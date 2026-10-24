# OpenAI-compatible gateway that drives the official opencode CLI.
# Free-tier requests must come from the official client, so we ship it inside.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.19.0
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 ca-certificates git curl \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force \
 && opencode --version

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin shim \
 && mkdir -p /app /data /tmp/opencode-work \
 && chown -R shim:shim /app /data /tmp/opencode-work

COPY --chown=shim:shim shim.py /app/shim.py

ENV SHIM_PORT=18001 \
    SHIM_BIND=0.0.0.0 \
    SHIM_TOKEN_FILE=/data/token \
    SHIM_WORKDIR=/tmp/opencode-work \
    SHIM_CONCURRENCY=1 \
    HOME=/home/shim

USER shim
EXPOSE 18001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:18001/health',timeout=4)"

CMD ["python3", "/app/shim.py"]
