FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 compiles a native addon on install; only the build stage needs the toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# The already-compiled node_modules (including better-sqlite3's native binary) come straight
# from the build stage, so the runtime image never needs python3/make/g++ at all.
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# node:22-slim ships a pre-created, non-root `node` user (uid 1000) for exactly this purpose.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
