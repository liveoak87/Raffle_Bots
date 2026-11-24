FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm_config_build_from_source=true npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM build AS dependencies
RUN npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
COPY scripts/load-simulate.js ./scripts/load-simulate.js
ENV DATABASE_PATH=/data/raffle.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "dist/index.js"]
