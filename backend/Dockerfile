# iPredict backend API image.
#
# Build from the REPOSITORY ROOT, not from backend/:
#
#     docker build -t ipredict-backend:test -f backend/Dockerfile .
#
# The backend imports the `@ipredict/shared` workspace package at runtime
# (config parsing, secret loading, wasm verification), and that package exists
# only in the root workspace lockfile. A backend-only build context cannot
# resolve it — `npm ci` inside backend/ asks the public registry for
# `@ipredict/shared@*` and fails with a 404.

# node:20-alpine
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build

WORKDIR /app

# Manifests first so the dependency layer is cached across backend source
# changes. Every workspace manifest is needed because the root lockfile
# describes all of them. shared's sources come along because its `prepare`
# script compiles it during install.
COPY package.json package-lock.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src
COPY backend/package.json ./backend/
COPY db/package.json ./db/
COPY indexer/package.json ./indexer/
COPY oracle/package.json ./oracle/

RUN npm ci

COPY backend ./backend

RUN npm run build --workspace=@ipredict/shared \
 && npm run build --workspace=ipredict-backend \
 && npm prune --omit=dev

# node:20-alpine
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS production

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

# Workspace layout is preserved: the hoisted node_modules carries the runtime
# dependencies and the `@ipredict/shared` symlink, which points at /app/shared.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/package.json
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/backend/package.json ./backend/package.json
COPY --from=build /app/backend/dist ./backend/dist

USER app

EXPOSE 4000

# backend/tsconfig.json uses rootDir "." so the compiler emits dist/src/*.
CMD ["node", "backend/dist/src/index.js"]
