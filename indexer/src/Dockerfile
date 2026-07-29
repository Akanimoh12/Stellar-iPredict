# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS production
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system indexer \
  && useradd --system --gid indexer --home-dir /app indexer

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=build /app/dist ./dist

USER indexer
CMD ["node", "dist/index.js"]
