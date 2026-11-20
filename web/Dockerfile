# syntax=docker/dockerfile:1

# The admin panel as a static build, served by Caddy. In deploy/compose.yml this container is
# also the reverse proxy in front of the API, and it gets its HTTPS certificate itself
# (deploy/Caddyfile, mounted at run time).

# ---- Build: the Angular production build ----
FROM node:24-alpine AS build
WORKDIR /app
ENV NG_CLI_ANALYTICS=false

COPY package.json package-lock.json ./
RUN npm ci

COPY angular.json tsconfig.json tsconfig.app.json .postcssrc.json ./
COPY public ./public
COPY src ./src
RUN npx ng build

# ---- Runtime: Caddy with the static files ----
FROM caddy:2.10-alpine AS runtime
COPY --from=build /app/dist/imotsync-web/browser /srv
