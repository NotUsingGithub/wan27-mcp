FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node dist/ ./dist/
COPY --chown=node:node README.md LICENSE PROVENANCE.md ./
USER node
ENV WAN27_CONFIG_DIR=/home/node/.config/wan27
ENTRYPOINT ["node", "dist/cli.mjs", "mcp", "--credential-store", "file"]
