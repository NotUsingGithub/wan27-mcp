#!/usr/bin/env node

// packages/cli/src/cli.mjs
import { randomUUID as randomUUID4 } from "node:crypto";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/agent/mcp-server.ts
import { randomUUID } from "node:crypto";

// src/generation/contracts/agent-error.ts
var AGENT_ERROR_CODES = [
  "SERVICE_UNAVAILABLE",
  "RATE_LIMITED",
  "INSUFFICIENT_CREDITS",
  "SUBSCRIPTION_REQUIRED",
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "INSUFFICIENT_SCOPE",
  "IDEMPOTENCY_CONFLICT",
  "MODEL_UNAVAILABLE",
  "NOT_FOUND"
];
var AgentError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AgentError";
  }
};

// src/agent/mcp-server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
var AGENT_MCP_MODEL_IDS = [
  "wan2.7-image",
  "wan2.7-image-pro",
  "wan27-text-to-video",
  "wan27-image-to-video"
];
var readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
var generationInput = z.looseObject({
  modelId: z.enum(AGENT_MCP_MODEL_IDS),
  prompt: z.string().min(1).max(1500)
}).describe(
  "Generation parameters. Call get_model for the full input schema of a model."
);
var requestId = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional().describe(
  "Optional. Reuse the same value when retrying the same request so it is never charged twice."
);
function createAgentMcpServer(services, websiteOrigin = "https://wan2-7.io") {
  const server = new McpServer({ name: "wan27", version: "0.2.0" });
  async function call(action) {
    try {
      const data = await action();
      return {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: { data }
      };
    } catch (error) {
      const code = error instanceof AgentError ? error.code : "SERVICE_UNAVAILABLE";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code,
                message: error instanceof AgentError ? error.message : "The service is temporarily unavailable. Check list_tasks before retrying.",
                ...code === "SUBSCRIPTION_REQUIRED" ? { upgradeUrl: `${websiteOrigin}/pricing/` } : {},
                ...code === "INSUFFICIENT_CREDITS" ? { rechargeUrl: `${websiteOrigin}/settings/credits/` } : {}
              }
            })
          }
        ]
      };
    }
  }
  server.registerTool(
    "account_status",
    {
      description: "Credit balance and subscription status. Credits are shared with the website.",
      inputSchema: {},
      annotations: readOnly
    },
    () => call(() => services.account())
  );
  server.registerTool(
    "list_models",
    {
      description: "Models available for generation, with pricing.",
      inputSchema: {},
      annotations: readOnly
    },
    () => call(() => services.models())
  );
  server.registerTool(
    "get_model",
    {
      description: "One model, including the JSON Schema of its input.",
      inputSchema: { modelId: z.enum(AGENT_MCP_MODEL_IDS) },
      annotations: readOnly
    },
    ({ modelId }) => call(() => services.model(modelId))
  );
  server.registerTool(
    "estimate_generation",
    {
      description: "Credits a generation would cost, without creating it. Same price as the website.",
      inputSchema: { input: generationInput },
      annotations: readOnly
    },
    ({ input }) => call(() => services.estimate(input))
  );
  for (const [name, kind] of [
    ["generate_image", "an image"],
    ["generate_video", "a video"]
  ]) {
    server.registerTool(
      name,
      {
        description: `Create ${kind}. Spends website credits at the website price and returns a task; poll get_task until it succeeds or fails. Failed tasks are refunded automatically.`,
        inputSchema: { input: generationInput, requestId },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        }
      },
      ({ input, requestId: key }) => call(async () => {
        const video = input.modelId.startsWith("wan27-");
        if (video !== (name === "generate_video"))
          throw new AgentError(
            "INVALID_INPUT",
            `Use ${video ? "generate_video" : "generate_image"} for ${input.modelId}`
          );
        return services.generate(input, key ?? randomUUID());
      })
    );
  }
  server.registerTool(
    "list_tasks",
    {
      description: "Your recent image and video tasks, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().max(512).optional()
      },
      annotations: readOnly
    },
    ({ limit, cursor }) => call(() => services.tasks({ limit, cursor }))
  );
  server.registerTool(
    "get_task",
    {
      description: "Status of one task. When it succeeds, `outputs` holds the download URLs.",
      inputSchema: { taskId: z.string().min(1).max(64) },
      annotations: readOnly
    },
    ({ taskId }) => call(() => services.task(taskId))
  );
  return server;
}

// packages/cli/src/auth.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

// packages/cli/src/client.mjs
var WanClientError = class extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
};
function normalizeOrigin(value = "https://wan2-7.io") {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.protocol !== "https:")
    throw new WanClientError(
      "INVALID_ORIGIN",
      "Use an exact HTTPS service origin."
    );
  return url.origin;
}
function serviceUrl(origin, path4) {
  const url = new URL(path4, origin);
  if (!url.pathname.endsWith("/") && !url.pathname.split("/").at(-1).includes("."))
    url.pathname += "/";
  return url;
}
async function readJsonResponse(response, limit = 2097152) {
  if (!response.body)
    throw new WanClientError(
      "INVALID_RESPONSE",
      "The server returned an empty response."
    );
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit)
        throw new WanClientError(
          "INVALID_RESPONSE",
          "The server response exceeded the size limit."
        );
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof WanClientError) throw error;
    throw new WanClientError(
      "INVALID_RESPONSE",
      "The server returned an unreadable response."
    );
  } finally {
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
}
var WanClient = class {
  constructor({ origin, getToken, request = fetch, sleep, mode }) {
    this.mode = mode === "local_mcp" ? "local_mcp" : "cli";
    this.origin = normalizeOrigin(origin);
    this.getToken = getToken;
    this.request = request;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  async authorizedFetch(path4, init) {
    const token = await this.getToken();
    if (typeof token !== "string" || !token || /[\r\n]/.test(token))
      throw new WanClientError("AUTH_REQUIRED", "Run wan27 auth login.");
    return this.request(serviceUrl(this.origin, path4), {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(12e4),
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...init.headers,
        "X-Wan27-Client-Mode": this.mode
      }
    });
  }
  async parse(response, method) {
    let data;
    try {
      data = response.status === 204 ? {} : await readJsonResponse(response);
    } catch {
      throw new WanClientError(
        response.status === 401 ? "UNAUTHORIZED" : "INVALID_RESPONSE",
        response.status === 401 ? "Authorization expired or was revoked. Run wan27 auth login." : `Service returned an unreadable response (HTTP ${response.status}).`,
        response.status
      );
    }
    if (!response.ok)
      throw new WanClientError(
        typeof data.error?.code === "string" ? data.error.code : "API_ERROR",
        typeof data.error?.message === "string" ? data.error.message : `Service returned HTTP ${response.status}.`,
        response.status
      );
    return data;
  }
  async call(method, path4, body, key) {
    if (!path4.startsWith("/api/v1/") || path4.startsWith("//") || new URL(path4, this.origin).pathname !== path4.split("?")[0] || new URL(path4, this.origin).origin !== this.origin)
      throw new WanClientError("INVALID_PATH", "Invalid API path.");
    const serialized = body === void 0 ? void 0 : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > 32768)
      throw new WanClientError("INVALID_INPUT", "Request exceeds 32 KiB.");
    let response;
    try {
      response = await this.authorizedFetch(path4, {
        method,
        headers: {
          Accept: "application/json",
          ...serialized ? { "Content-Type": "application/json" } : {},
          ...key ? { "Idempotency-Key": key } : {}
        },
        body: serialized
      });
    } catch (error) {
      if (error instanceof WanClientError) throw error;
      throw new WanClientError(
        "SERVICE_UNAVAILABLE",
        "Could not reach the service."
      );
    }
    return this.parse(response, method);
  }
  account() {
    return this.call("GET", "/api/v1/account");
  }
  models() {
    return this.call("GET", "/api/v1/models");
  }
  model(id) {
    return this.call("GET", `/api/v1/models/${encodeURIComponent(id)}`);
  }
  estimate(input) {
    return this.call("POST", "/api/v1/estimates", input);
  }
  /** Safe to retry: the same key never creates or charges a second task. */
  async generate(input, key) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.call("POST", "/api/v1/generations", input, key);
      } catch (error) {
        const transient = error.code === "SERVICE_UNAVAILABLE" || error.code === "INVALID_RESPONSE" || error.status >= 500;
        if (!transient || attempt >= 3) {
          if (transient)
            error.message += ` Retry with --request-id ${key}; it will not be charged twice.`;
          throw error;
        }
        await this.sleep(1e3 * attempt);
      }
    }
  }
  tasks({ limit = 20, cursor } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set("cursor", cursor);
    return this.call("GET", `/api/v1/tasks?${query}`);
  }
  task(id) {
    return this.call("GET", `/api/v1/tasks/${encodeURIComponent(id)}`);
  }
  async upload(bytes, filename, contentType) {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: contentType }), filename);
    let response;
    try {
      response = await this.authorizedFetch("/api/v1/uploads", {
        method: "POST",
        headers: { Accept: "application/json" },
        body: form
      });
    } catch (error) {
      if (error instanceof WanClientError) throw error;
      throw new WanClientError("SERVICE_UNAVAILABLE", "Upload failed.");
    }
    return this.parse(response, "POST");
  }
};

// packages/cli/src/auth.mjs
var CLIENT_ID = "wan27-cli";
var CALLBACK_PORT = 8787;
var CALLBACK_PATH = "/oauth/callback";
var scopes = "account:read models:read generations:create tasks:read uploads:write offline_access";
var nonce = () => randomBytes(32).toString("base64url");
var safeEqual = (a, b) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function credentialName(origin) {
  return `credentials-${createHash("sha256").update(normalizeOrigin(origin)).digest("hex")}.json`;
}
function tokenIdentity(token, origin) {
  try {
    if (typeof token !== "string" || token.length > 32768) throw new Error();
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    if (typeof claims.sub !== "string" || !claims.sub || typeof claims.grant_id !== "string" || !claims.grant_id || claims.aud !== `${origin}/api/v1`)
      throw new Error();
    return createHash("sha256").update(
      JSON.stringify([
        claims.sub,
        claims.grant_id,
        claims.client_id,
        claims.aud
      ])
    ).digest("hex");
  } catch {
    throw new WanClientError(
      "INVALID_TOKEN",
      "Access token is not a Wan27 API authorization. Sign in again."
    );
  }
}
function openBrowser(url) {
  const command2 = process.platform === "darwin" ? "open" : "xdg-open";
  const args = [url];
  const child = spawn(command2, args, {
    shell: false,
    detached: true,
    stdio: "ignore"
  });
  child.on("error", () => {
  });
  child.unref();
}
async function receiveAuthorization({
  origin,
  launch = openBrowser,
  report: report2 = (value) => process.stderr.write(`${value}
`),
  port = CALLBACK_PORT,
  timeoutMs = 3e5
}) {
  origin = normalizeOrigin(origin);
  const state = nonce();
  const verifier = nonce();
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const url = new URL("/api/auth/oauth2/authorize/", origin);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    resource: `${origin}/api/v1`,
    scope: scopes,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256"
  }).toString();
  return new Promise((resolve, reject) => {
    let timer;
    let settled = false;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (error) reject(error);
      else resolve({ code, verifier, redirectUri });
    };
    const server = createServer(
      { maxHeaderSize: 8192 },
      (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.setHeader("Content-Security-Policy", "default-src 'none'");
        let callback;
        try {
          callback = new URL(request.url, redirectUri);
        } catch {
          response.writeHead(400).end("Invalid callback.");
          return;
        }
        if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${port}` || callback.origin !== new URL(redirectUri).origin || callback.pathname !== CALLBACK_PATH || callback.searchParams.getAll("state").length !== 1 || !safeEqual(callback.searchParams.get("state"), state)) {
          response.writeHead(400).end("Invalid authorization callback.");
          return;
        }
        const codes = callback.searchParams.getAll("code");
        if (callback.searchParams.has("error") || codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
          response.writeHead(400).end(
            "Authorization was not completed.",
            () => finish(
              new WanClientError(
                "AUTH_CANCELLED",
                "Authorization was denied or incomplete."
              )
            )
          );
          return;
        }
        response.end(
          "Authorization received. You can close this window.",
          () => finish(null, codes[0])
        );
      }
    );
    server.requestTimeout = 1e4;
    server.headersTimeout = 1e4;
    server.setTimeout(1e4, (socket) => socket.destroy());
    server.once(
      "error",
      () => finish(
        new WanClientError(
          "CALLBACK_UNAVAILABLE",
          "Cannot open the local authorization callback on port 8787."
        )
      )
    );
    server.listen(port, "127.0.0.1", () => {
      timer = setTimeout(
        () => finish(
          new WanClientError(
            "AUTH_TIMEOUT",
            "Authorization timed out. Run auth login again."
          )
        ),
        timeoutMs
      );
      report2(`Open this URL to authorize Wan27:
${url}`);
      try {
        launch(url.toString());
      } catch {
      }
    });
  });
}
var CredentialManager = class {
  constructor({
    origin,
    files,
    request = fetch,
    accessToken = process.env.WAN27_ACCESS_TOKEN,
    now = Date.now
  }) {
    this.origin = normalizeOrigin(origin);
    this.files = files;
    this.request = request;
    this.accessToken = accessToken;
    this.now = now;
    this.name = credentialName(this.origin);
  }
  async exchange(fields) {
    let response;
    try {
      response = await this.request(
        new URL("/api/auth/oauth2/token/", this.origin),
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(3e4),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json"
          },
          body: new URLSearchParams({
            client_id: CLIENT_ID,
            resource: `${this.origin}/api/v1`,
            ...fields
          }).toString()
        }
      );
    } catch {
      throw new WanClientError(
        "AUTH_OUTCOME_UNKNOWN",
        "Authorization response was lost. Sign in again; do not retry the same refresh token."
      );
    }
    const data = await readJsonResponse(response, 65536);
    if (response.status === 429 && data.error === "slow_down" && data.refresh_token_unchanged === true && fields.grant_type === "refresh_token")
      throw new WanClientError(
        "AUTH_RETRY_LATER",
        "Authorization is temporarily rate limited. Retry later.",
        429
      );
    if (!response.ok)
      throw new WanClientError(
        "AUTH_REQUIRED",
        "Authorization is no longer available. Sign in again.",
        response.status
      );
    if (data.token_type?.toLowerCase() !== "bearer" || typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || !data.refresh_token || data.refresh_token.length > 32768 || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 86400)
      throw new WanClientError(
        "INVALID_RESPONSE",
        "Invalid authorization response."
      );
    tokenIdentity(data.access_token, this.origin);
    return {
      origin: this.origin,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: this.now() + data.expires_in * 1e3,
      refreshUncertain: false
    };
  }
  async login(options = {}) {
    if (this.accessToken)
      throw new WanClientError(
        "INVALID_INPUT",
        "Unset WAN27_ACCESS_TOKEN before interactive login."
      );
    const auth = await receiveAuthorization({
      origin: this.origin,
      ...options
    });
    return this.files.lock(this.name, async () => {
      const credentials = await this.exchange({
        grant_type: "authorization_code",
        code: auth.code,
        code_verifier: auth.verifier,
        redirect_uri: auth.redirectUri
      });
      await this.files.write(this.name, credentials);
      this.cached = credentials;
      return { authenticated: true, origin: this.origin };
    });
  }
  async token() {
    if (this.accessToken) {
      tokenIdentity(this.accessToken, this.origin);
      return this.accessToken;
    }
    if (this.cached?.expiresAt > this.now() + 6e4)
      return this.cached.accessToken;
    if (this.tokenPromise) return this.tokenPromise;
    this.tokenPromise = this.files.lock(this.name, async () => {
      const credentials = await this.files.read(this.name);
      if (!credentials || credentials.origin !== this.origin || credentials.refreshUncertain)
        throw new WanClientError("AUTH_REQUIRED", "Run wan27 auth login.");
      if (Number.isFinite(credentials.expiresAt) && credentials.expiresAt > this.now() + 6e4) {
        tokenIdentity(credentials.accessToken, this.origin);
        this.cached = credentials;
        return credentials.accessToken;
      }
      if (typeof credentials.refreshToken !== "string" || !credentials.refreshToken)
        throw new WanClientError("AUTH_REQUIRED", "Run wan27 auth login.");
      await this.files.write(this.name, {
        ...credentials,
        refreshUncertain: true
      });
      let refreshed;
      try {
        refreshed = await this.exchange({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken
        });
      } catch (error) {
        if (error instanceof WanClientError && error.code === "AUTH_RETRY_LATER")
          await this.files.write(this.name, credentials);
        throw error;
      }
      await this.files.write(this.name, refreshed);
      this.cached = refreshed;
      return refreshed.accessToken;
    });
    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }
  async identity() {
    return tokenIdentity(await this.token(), this.origin);
  }
  async logout(client) {
    let failure;
    try {
      await client.call("POST", "/api/v1/connections/revoke", {});
    } catch {
      failure = true;
    }
    this.cached = null;
    if (!this.accessToken)
      await this.files.lock(this.name, () => this.files.remove(this.name));
    if (failure)
      throw new WanClientError(
        "REVOCATION_UNCONFIRMED",
        this.accessToken ? "Environment token revocation is unconfirmed. Revoke this connection in account settings and unset WAN27_ACCESS_TOKEN." : "Local credentials removed; server revocation is unconfirmed. Revoke this connection in account settings."
      );
    return { revoked: true, origin: this.origin };
  }
};

// packages/cli/src/files.mjs
import { randomUUID as randomUUID2 } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
var PrivateFiles = class {
  constructor(directory = process.env.WAN27_CONFIG_DIR || path.join(homedir(), ".wan27")) {
    this.directory = path.resolve(directory);
  }
  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || process.getuid && info.uid !== process.getuid())
      throw new WanClientError(
        "UNSAFE_CONFIG",
        "Configuration directory is not a private owned directory."
      );
    await chmod(this.directory, 448);
  }
  target(name) {
    if (!/^[a-zA-Z0-9._-]{1,160}$/.test(name))
      throw new WanClientError("INVALID_FILE", "Invalid configuration record.");
    return path.join(this.directory, name);
  }
  async read(name) {
    await this.initialize();
    let handle;
    try {
      handle = await open(
        this.target(name),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 65536 || info.mode & 63 || process.getuid && info.uid !== process.getuid())
        throw new WanClientError(
          "UNSAFE_CONFIG",
          "Credential or operation file is not private."
        );
      return JSON.parse(await handle.readFile("utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  async write(name, value, exclusive = false) {
    await this.initialize();
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 65536)
      throw new WanClientError(
        "INVALID_FILE",
        "Configuration record is too large."
      );
    const destination = this.target(name);
    const temporary = this.target(`tmp-${randomUUID2()}`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        384
      );
      await handle.writeFile(data);
      await handle.sync();
      await handle.close();
      handle = null;
      if (exclusive) await link(temporary, destination);
      else await rename(temporary, destination);
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
  async remove(name) {
    await this.initialize();
    await rm(this.target(name), { force: true });
  }
  async lock(name, action) {
    const lock = `${name}.lock`;
    await this.initialize();
    const deadline = Date.now() + 1e4;
    while (true) {
      try {
        await this.write(
          lock,
          { pid: process.pid, createdAt: (/* @__PURE__ */ new Date()).toISOString() },
          true
        );
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new WanClientError(
            "BUSY",
            `Credential lock is busy: ${this.target(lock)}. If its recorded process crashed, remove this stale lock and sign in again. No refresh was retried.`
          );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    try {
      return await action();
    } finally {
      await this.remove(lock);
    }
  }
};

// packages/cli/src/mcp.mjs
function localMcpServices({ client }) {
  const wrap = (action) => async (...args) => {
    try {
      return await action(...args);
    } catch (error) {
      const code = AGENT_ERROR_CODES.includes(error.code) ? error.code : error.code === "AUTH_REQUIRED" || error.status === 401 ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE";
      throw new AgentError(
        code,
        error instanceof WanClientError ? error.code === "AUTH_REQUIRED" ? "Not signed in. Run `wan27 auth login` in a terminal." : error.message : "Service unavailable. Check list_tasks before retrying."
      );
    }
  };
  return {
    account: wrap(() => client.account()),
    models: wrap(() => client.models()),
    model: wrap((id) => client.model(id)),
    estimate: wrap((input) => client.estimate(input)),
    generate: wrap((input, key) => client.generate(input, key)),
    tasks: wrap((query) => client.tasks(query)),
    task: wrap((id) => client.task(id))
  };
}

// packages/cli/src/media.mjs
import { randomUUID as randomUUID3 } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { link as link2, open as open2, unlink } from "node:fs/promises";
import path2 from "node:path";
var MAX_BYTES = 512 * 1024 * 1024;
var MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "video/mp4"];
async function downloadTask(client, taskId, destination, { index = 0, request = fetch } = {}) {
  const task = await client.task(taskId);
  if (task.status !== "succeeded")
    throw new WanClientError(
      "TASK_NOT_READY",
      `Task is ${task.status}. Run wan27 wait ${taskId} first.`
    );
  const source = task.outputs?.[index];
  if (typeof source !== "string" || !source.startsWith("https://"))
    throw new WanClientError("DOWNLOAD_UNAVAILABLE", "Task has no output.");
  const target = path2.resolve(destination);
  const temporary = path2.join(
    path2.dirname(target),
    `.wan27-download-${randomUUID3()}`
  );
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 6e5);
  let file;
  let bytes = 0;
  try {
    file = await open2(
      temporary,
      constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | constants2.O_NOFOLLOW,
      384
    );
    const response = await request(source, {
      redirect: "follow",
      signal: abort.signal
    });
    const type = response.headers.get("content-type")?.split(";")[0].trim();
    if (!response.ok || !response.body)
      throw new WanClientError(
        "DOWNLOAD_UNAVAILABLE",
        `Download returned HTTP ${response.status}.`,
        response.status
      );
    if (!MEDIA_TYPES.includes(type))
      throw new WanClientError("INVALID_RESPONSE", "Unexpected media type.");
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES)
        throw new WanClientError("INVALID_RESPONSE", "Media is too large.");
      await file.writeFile(chunk);
    }
    await file.sync();
    await file.close();
    file = null;
    await link2(temporary, target);
    return { taskId, path: target, bytes, contentType: type };
  } finally {
    clearTimeout(timer);
    await file?.close();
    await unlink(temporary).catch(() => {
    });
  }
}
async function waitForTask(client, taskId, {
  timeoutMs = 6e5,
  intervalMs = 5e3,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 864e5)
    throw new WanClientError(
      "INVALID_INPUT",
      "Wait timeout must be 1 ms to 24 hours."
    );
  const until = now() + timeoutMs;
  do {
    const task = await client.task(taskId);
    if (task.status === "succeeded" || task.status === "failed") return task;
    const remaining = until - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  } while (now() < until);
  throw new WanClientError(
    "WAIT_TIMEOUT",
    `Stopped waiting; the task continues. Run wan27 wait ${taskId} again later.`
  );
}

// packages/cli/src/upload.mjs
import { constants as constants3 } from "node:fs";
import { open as open3 } from "node:fs/promises";
import path3 from "node:path";
async function readBoundedFile(filename, limit) {
  const handle = await open3(filename, constants3.O_RDONLY);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > limit)
      throw new WanClientError(
        "INVALID_INPUT",
        `Input must be a regular file no larger than ${limit} bytes.`
      );
    const data = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        offset
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size)
      throw new WanClientError(
        "INVALID_INPUT",
        "Input file changed while reading."
      );
    return data.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP")
    return "image/webp";
  throw new WanClientError("INVALID_INPUT", "Use a PNG, JPEG or WebP image.");
}
var MAX_UPLOAD_BYTES = 5 * 1024 * 1024 - 1;
async function uploadImage(client, filename) {
  const bytes = await readBoundedFile(filename, MAX_UPLOAD_BYTES);
  return client.upload(bytes, path3.basename(filename), imageType(bytes));
}

// packages/cli/src/vault.mjs
import { spawn as spawn2 } from "node:child_process";
function command(binary, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn2(binary, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), 3e4);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 131072) child.kill();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new WanClientError(
          "KEYCHAIN_UNAVAILABLE",
          "System keychain unavailable. To explicitly use private local files, run auth login --credential-store file."
        )
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && size <= 131072)
        resolve(Buffer.concat(chunks).toString("utf8").trim());
      else if (code === 44) resolve(null);
      else
        reject(
          new WanClientError(
            "KEYCHAIN_UNAVAILABLE",
            "System keychain is locked or unavailable. Unlock it, or explicitly use auth login --credential-store file."
          )
        );
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
var MacKeychainVault = class {
  constructor(files, run = command) {
    this.files = files;
    this.run = run;
  }
  account(name) {
    if (!/^credentials-[a-f0-9]{64}\.json$/.test(name))
      throw new Error("Invalid credential key");
    return name;
  }
  lock(name, action) {
    return this.files.lock(name, action);
  }
  async read(name) {
    const result = await this.run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      "wan27-cli",
      "-a",
      this.account(name),
      "-w"
    ]);
    return result === null ? null : JSON.parse(Buffer.from(result, "base64url").toString("utf8"));
  }
  async write(name, value) {
    const data = Buffer.from(JSON.stringify(value)).toString("base64url");
    if (data.length > 87384) throw new Error("Credential too large");
    await this.run(
      "/usr/bin/security",
      ["-i"],
      `add-generic-password -U -s wan27-cli -a ${this.account(name)} -w ${data}
`
    );
    const saved = await this.read(name);
    if (JSON.stringify(saved) !== JSON.stringify(value))
      throw new WanClientError(
        "KEYCHAIN_UNAVAILABLE",
        "System keychain did not confirm the credential write."
      );
  }
  async remove(name) {
    await this.run("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      "wan27-cli",
      "-a",
      this.account(name)
    ]);
  }
};
async function selectVault(files, selection, report2 = (value) => process.stderr.write(`${value}
`)) {
  if (selection !== void 0 && !["file", "keychain"].includes(selection))
    throw new WanClientError(
      "INVALID_INPUT",
      "Credential store must be file or keychain."
    );
  const config = await files.read("credential-store.json");
  const chosen = selection ?? config?.store ?? "keychain";
  if (chosen === "file") {
    if (selection) {
      report2(
        `Credentials will be stored in private local files (directory 0700, files 0600): ${files.directory}`
      );
      await files.write("credential-store.json", { store: "file" });
    }
    return files;
  }
  if (process.platform !== "darwin")
    throw new WanClientError(
      "KEYCHAIN_UNAVAILABLE",
      "This platform has no supported keychain adapter. Explicitly select private local files with auth login --credential-store file."
    );
  if (selection)
    await files.write("credential-store.json", { store: "keychain" });
  return new MacKeychainVault(files);
}

// packages/cli/src/cli.mjs
var stdioMode = false;
var output = (value) => process.stdout.write(`${JSON.stringify(value)}
`);
var report = (value) => process.stderr.write(`${value}
`);
var help = `wan27 \u2014 generate images and videos with your wan2-7.io credits

  auth login [--credential-store keychain|file] [--no-browser]
  auth status | auth logout
  account                         Credits and subscription status
  models | model <modelId>        Models, prices and input schema
  estimate --input <json-file>    Credits a generation would cost
  create --input <json-file> [--request-id <id>] [--wait]
  tasks [--limit <1..50>] [--cursor <cursor>]
  task <taskId> | wait <taskId> [--timeout <seconds>]
  upload <image-file>             Upload a reference image, prints its URL
  download <taskId> --output <file> [--index <n>]
  mcp                             Start a local MCP server on stdio
  --origin <https-origin>         Default https://wan2-7.io

Results are JSON on stdout. Retrying create with the same --request-id never
charges twice. A wait timeout does not cancel the task.
`;
async function inputFile(file) {
  if (!file)
    throw new WanClientError(
      "INVALID_INPUT",
      "--input <json-file> is required."
    );
  try {
    return JSON.parse((await readBoundedFile(file, 32768)).toString("utf8"));
  } catch (error) {
    if (error instanceof WanClientError) throw error;
    throw new WanClientError("INVALID_INPUT", "Input file is not valid JSON.");
  }
}
function required(value, label) {
  if (!value)
    throw new WanClientError("INVALID_INPUT", `${label} is required.`);
  return value;
}
async function main() {
  if (!["darwin", "linux"].includes(process.platform))
    throw new WanClientError(
      "UNSUPPORTED_PLATFORM",
      "This CLI currently supports macOS and Linux (including WSL)."
    );
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      origin: { type: "string" },
      input: { type: "string" },
      "request-id": { type: "string" },
      wait: { type: "boolean" },
      limit: { type: "string" },
      cursor: { type: "string" },
      timeout: { type: "string" },
      output: { type: "string" },
      index: { type: "string" },
      "credential-store": { type: "string" },
      "no-browser": { type: "boolean" }
    }
  });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const [command2, id] = positionals;
  stdioMode = command2 === "mcp";
  if (positionals.length > 2)
    throw new WanClientError(
      "INVALID_INPUT",
      "Unexpected positional arguments."
    );
  const files = new PrivateFiles();
  const origin = values.origin ?? "https://wan2-7.io";
  const vault = process.env.WAN27_ACCESS_TOKEN ? files : await selectVault(files, values["credential-store"], report);
  const auth = new CredentialManager({ origin, files: vault });
  const client = new WanClient({
    origin,
    getToken: () => auth.token(),
    mode: stdioMode ? "local_mcp" : "cli"
  });
  const timeoutMs = Number(values.timeout ?? 600) * 1e3;
  if (command2 === "auth") {
    if (id === "login")
      output(
        await auth.login({
          ...values["no-browser"] ? { launch: () => {
          } } : {},
          report
        })
      );
    else if (id === "logout") {
      output(await auth.logout(client));
      if (process.env.WAN27_ACCESS_TOKEN)
        report("Unset WAN27_ACCESS_TOKEN in your shell.");
    } else if (id === "status") {
      await client.account();
      output({ authenticated: true, origin });
    } else
      throw new WanClientError(
        "INVALID_INPUT",
        "Expected auth login, status or logout."
      );
  } else if (command2 === "account") output(await client.account());
  else if (command2 === "models") output(await client.models());
  else if (command2 === "model")
    output(await client.model(required(id, "model ID")));
  else if (command2 === "estimate")
    output(await client.estimate(await inputFile(values.input)));
  else if (command2 === "create") {
    const input = await inputFile(values.input);
    const requestId2 = values["request-id"] ?? randomUUID4();
    report(`Request ID: ${requestId2} (reuse it to retry without a new charge)`);
    const created = await client.generate(input, requestId2);
    output(
      values.wait ? await waitForTask(client, created.task.id, { timeoutMs }) : created
    );
  } else if (command2 === "tasks") {
    const limit = Number(values.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new WanClientError("INVALID_INPUT", "Limit must be 1..50.");
    output(await client.tasks({ limit, cursor: values.cursor }));
  } else if (command2 === "task")
    output(await client.task(required(id, "task ID")));
  else if (command2 === "wait")
    output(await waitForTask(client, required(id, "task ID"), { timeoutMs }));
  else if (command2 === "upload")
    output(await uploadImage(client, required(id, "image file")));
  else if (command2 === "download")
    output(
      await downloadTask(
        client,
        required(id, "task ID"),
        required(values.output, "--output"),
        { index: Number(values.index ?? 0) }
      )
    );
  else if (command2 === "mcp") {
    const server = createAgentMcpServer(localMcpServices({ client }), origin);
    await server.connect(new StdioServerTransport());
    process.once("SIGINT", () => {
      void server.close().finally(() => process.exit(0));
    });
  } else
    throw new WanClientError(
      "INVALID_INPUT",
      "Unknown command. Run wan27 --help."
    );
}
main().catch((error) => {
  const emit = stdioMode ? (value) => report(JSON.stringify(value)) : output;
  emit({
    error: {
      code: error.code ?? "CLI_ERROR",
      message: error instanceof WanClientError || error instanceof AgentError ? error.message : "Command failed. Check your input and try again."
    }
  });
  process.exitCode = 1;
});
