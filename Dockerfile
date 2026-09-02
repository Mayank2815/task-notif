# Build stage — compiles the server and the dashboard.
FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY dashboard/package*.json ./dashboard/
RUN npm ci --prefix dashboard

COPY tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
RUN npm run build

# Runtime stage — production deps only, no toolchain, non-root.
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# su-exec drops privileges in the entrypoint after fixing volume ownership.
RUN apk add --no-cache su-exec

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard/dist ./dashboard/dist

# Config and run history live here; mounted as a volume so they survive redeploys.
RUN mkdir -p /app/data && chown -R node:node /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# No USER directive: the entrypoint starts as root only long enough to chown the
# mounted volume, then execs the app as node.
ENV PORT=4310 DATA_DIR=/app/data
EXPOSE 4310

# The scheduler is useless if the process is wedged, so check the API answers.
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4310)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server/index.js"]
