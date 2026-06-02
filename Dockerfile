FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public
COPY portal ./portal

# /data é o volume persistente onde config.json e claudbridge.db são salvos
RUN mkdir -p /data

ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

CMD ["npm", "start"]
