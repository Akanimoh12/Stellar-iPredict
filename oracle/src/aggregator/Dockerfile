# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

# The oracle imports @ipredict/shared, so build from the repository root and
# install the workspace graph rather than pretending oracle/ is standalone.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY oracle/package.json ./oracle/package.json
COPY backend/package.json ./backend/package.json
COPY indexer/package.json ./indexer/package.json
COPY shared ./shared
RUN npm ci --ignore-scripts

COPY oracle ./oracle
RUN npm run build --workspace=@ipredict/shared \
 && npm run build --workspace=ipredict-oracle \
 && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system aggregator \
 && useradd --system --gid aggregator --home-dir /app aggregator

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/package.json
COPY oracle/package.json ./oracle/package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/oracle/dist ./oracle/dist

# Metrics use 9102; readiness/liveness use 9103 by default.
EXPOSE 9102 9103
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||'9103')+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

USER aggregator
CMD ["node", "oracle/dist/index.js"]
