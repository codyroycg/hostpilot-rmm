FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY server/package.json ./
COPY server/src ./src
COPY server/public ./public
COPY server/agents ./agents
COPY server/seed-scripts ./seed-scripts
COPY server/task-scripts ./task-scripts

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/favicon.svg >/dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
