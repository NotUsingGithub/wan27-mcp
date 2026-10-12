# Wan27 MCP and CLI — AI Image and Video Generation

Generate images and videos from your terminal or AI assistant with your
[wan2-7.io](https://wan2-7.io/) account. MCP and CLI spend the same credit balance as the website, at
the same prices. Credits are topped up on the website.

**Access requires an active paid subscription.** Credit packs alone, free
accounts and unpaid trials do not qualify. A subscription with auto-renew turned
off keeps access until its paid period ends. Upgrade at
https://wan2-7.io/pricing/.

Node 22+, macOS or Linux (including WSL).

## Install

```sh
npm install -g @wan27/cli
```

## Use

```sh
wan27 auth login
wan27 account
wan27 models
wan27 estimate --input request.json
wan27 create --input request.json --wait
wan27 download <taskId> --output result.mp4
wan27 auth logout
```

`request.json` examples:

```json
{"modelId":"wan27-text-to-video","prompt":"A paper boat on a rainy street","durationSeconds":5,"resolution":"720p"}
```

```json
{"modelId":"wan2.7-image","prompt":"A paper crane on a desk","resolution":"2K"}
```

For image-to-video, upload the first frame and pass its URL:

```sh
wan27 upload frame.png        # {"url":"https://..."}
```

```json
{"modelId":"wan27-image-to-video","prompt":"The crane takes off","imageUrl":"https://..."}
```

`wan27 model <modelId>` prints every option and its JSON Schema.

`create` prints a request ID on stderr. Re-running it with
`--request-id <id>` after a network error returns the same task and is never
charged twice. Failed tasks are refunded automatically. A `wait` timeout only
stops waiting; the task keeps running.

Credentials are stored in the macOS Keychain, or with
`--credential-store file` in a private file (directory 0700, file 0600).
`WAN27_CONFIG_DIR` changes that directory. `WAN27_ACCESS_TOKEN` accepts a
pre-issued API token for automation. Logging out revokes this connection;
changing your website password revokes every connection.

## Connect an assistant (local MCP)

Sign in once with `wan27 auth login`, then register the stdio server:

```sh
codex mcp add wan27 -- wan27 mcp
claude mcp add wan27 -- wan27 mcp
```

Tools: `account_status`, `list_models`, `get_model`, `estimate_generation`,
`generate_image`, `generate_video`, `list_tasks`, `get_task`.

After signing in, clients that accept JSON configuration can launch the same
stdio server with npx:

```json
{
  "mcpServers": {
    "wan27": {
      "command": "npx",
      "args": ["-y", "@wan27/cli", "mcp"]
    }
  }
}
```

Read account status and estimate the cost before generating. Image and video
generation spend your website credits.

## Documentation and support

- [Wan27 website](https://wan2-7.io/)
- [MCP setup and client instructions](https://wan2-7.io/mcp/)
- [CLI installation](https://wan2-7.io/cli/)
- [MCP and CLI workflow guide](https://wan2-7.io/mcp/guide/)
- [Subscription plans](https://wan2-7.io/pricing/)
- [Public client distribution and issue tracker](https://github.com/NotUsingGithub/wan27-mcp)

## Run this public distribution

This repository contains the readable JavaScript executable for
[`@wan27/cli@0.1.3`](https://www.npmjs.com/package/@wan27/cli/v/0.1.3).
The hosted service is operated at wan2-7.io.

```sh
npm ci --ignore-scripts
node dist/cli.mjs --help
node dist/cli.mjs auth login
node dist/cli.mjs mcp
```

## License and provenance

MIT. See [PROVENANCE.md](PROVENANCE.md) for release provenance.
The executable is unchanged from 0.1.1. Version 0.1.3 updates the GitHub repository
and MCP Registry namespace to the NotUsingGithub account.
