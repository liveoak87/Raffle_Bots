FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends     build-essential     python3     libcairo2-dev     libpango1.0-dev     libjpeg-dev     libgif-dev     librsvg2-dev     && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src

ENV DATABASE_PATH=/app/data/raffle.db

CMD ["node", "src/index.js"]
