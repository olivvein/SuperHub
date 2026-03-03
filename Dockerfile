FROM node:22-bookworm-slim AS build

WORKDIR /app

# Build tools are needed when native modules (for example better-sqlite3)
# must be compiled for the target architecture.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.base.json ./
COPY hub.config.ts hub.config.json ./
COPY packages ./packages
COPY scripts ./scripts

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/hub.config.ts /app/hub.config.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages

EXPOSE 7777

CMD ["node", "packages/hub/dist/index.js"]
