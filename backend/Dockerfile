FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-alpine

WORKDIR /app

RUN addgroup --system app && adduser --system --ingroup app app

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

USER app

EXPOSE 4000

CMD ["node", "dist/index.js"]
