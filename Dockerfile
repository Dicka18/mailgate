# Glama / containerized runtime for the MailGate stdio MCP server (zero npm dependencies).
FROM node:22-alpine

WORKDIR /app

COPY sdk/index.mjs sdk/mcp.mjs sdk/package.json ./sdk/

USER node

ENTRYPOINT ["node", "/app/sdk/mcp.mjs"]
