# MoPilot Mobile Remote relay: one small Node service. The build context is this folder:
#   docker build -t mopilot-relay relay
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER node
EXPOSE 8787
# SIGTERM (docker stop) finishes what each connection is doing and closes the sockets with 1012; see README, "Stopping"
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/bin.mjs"]
