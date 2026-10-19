FROM node:20-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 may need to compile from source when no matching prebuilt
# binary is available for the deployment platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules

COPY --chown=node:node src ./src
COPY --chown=node:node file-renamer ./file-renamer
RUN mkdir -p /app/data && chown node:node /app/data

USER node
CMD ["node", "src/bot.js"]
