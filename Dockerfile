# OpenAI-compatible gateway for the OpenCode free tier.
# Calls the inference API directly; no CLI subprocess.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    SHIM_PORT=18001 \
    SHIM_BIND=0.0.0.0 \
    SHIM_UPSTREAM=https://opencode.ai \
    SHIM_TIMEOUT=300

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY server.mjs ./
COPY src ./src

RUN mkdir -p /tmp/opencode-work && chown -R node:node /app /tmp/opencode-work
USER node

EXPOSE 18001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SHIM_PORT||18001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
