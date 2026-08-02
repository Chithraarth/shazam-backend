# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* .npmrc* ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json* /app/.npmrc* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
