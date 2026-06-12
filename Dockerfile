FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends     build-essential     python3     libcairo2-dev     libpango1.0-dev     libjpeg-dev     libgif-dev     librsvg2-dev     && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src

ENV DATABASE_PATH=/app/data/raffle.db

# Liveness probe: hit the bot's /health endpoint, which returns 200 only when the
# Discord gateway is connected. Catches "zombie" states (process alive, gateway dead).
# Uses node (no curl in slim image). start-period gives the gateway time to connect.
HEALTHCHECK --interval=60s --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.DASHBOARD_PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
