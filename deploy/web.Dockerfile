# OmniPitch UI for Azure Container Apps: static Vite build served by nginx, which also forwards the API
# paths to the internal API app, so the browser sees one origin (no CORS needed; the API stays internal).
#   docker build -f deploy/web.Dockerfile --build-arg PUBLIC_URL=https://<web-app-fqdn> -t ghcr.io/<owner>/omnipitch-web:<tag> .
FROM node:24-alpine AS build
ARG PUBLIC_URL
WORKDIR /src
COPY contracts contracts
COPY analytics/threat-grid-v1.json analytics/threat-grid-v1.json
COPY apps/web/package.json apps/web/package-lock.json apps/web/
RUN cd apps/web && npm ci
COPY apps/web apps/web
# The UI calls the API through its own origin (nginx below), so the API base URL is the UI's public URL.
RUN test -n "$PUBLIC_URL" && cd apps/web && VITE_API_BASE_URL="$PUBLIC_URL" npm run build

FROM nginx:1.27-alpine
# API_UPSTREAM: the API app inside the Container Apps environment, e.g. http://omnipitch-api
ENV API_UPSTREAM=http://omnipitch-api
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
