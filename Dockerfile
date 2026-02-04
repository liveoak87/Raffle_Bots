FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

ENV DATABASE_PATH=/data/raffle.db

CMD ["node", "dist/index.js"]
