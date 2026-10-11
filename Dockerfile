FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY server/ ./server/
COPY web/ ./web/

ENV NODE_ENV=production \
    CMD3_MODE=public \
    CMD3_HOST=0.0.0.0 \
    CMD3_DATA_DIR=/data \
    PORT=4317

EXPOSE 4317
CMD ["node", "server/index.mjs"]
