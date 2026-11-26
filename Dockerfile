# Containerized runtime for the MailGate stdio MCP server (zero npm dependencies).
FROM node:22-alpine

WORKDIR /app

COPY sdk/index.mjs sdk/mcp.mjs sdk/package.json ./sdk/

ENV MAILGATE_URL="https://mailgate.example.com"

USER node

CMD ["node", "/app/sdk/mcp.mjs"]
