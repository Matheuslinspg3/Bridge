FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY request-logger.js ./
COPY logging-middleware.js ./
COPY public ./public
COPY portal ./portal

# /data é o volume persistente onde config.json e claudbridge.db são salvos
RUN mkdir -p /data

ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

CMD ["npm", "start"]
