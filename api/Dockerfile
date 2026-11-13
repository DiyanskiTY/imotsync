# syntax=docker/dockerfile:1

# ---- Build: compile TypeScript to dist/ ----
FROM node:24-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Runtime: production dependencies and compiled code only ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

# Fonts for the text on the generated demo photos (sharp renders SVG text with fontconfig).
RUN apk add --no-cache fontconfig font-dejavu

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Uploaded and generated photos (mounted as a volume by docker compose).
RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${API_PORT:-3000}/api/health" || exit 1

CMD ["node", "dist/server.js"]
