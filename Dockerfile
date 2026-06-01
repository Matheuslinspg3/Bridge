FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

# /data é o volume persistente onde config.json é salvo
RUN mkdir -p /data

ENV PORT=8787
EXPOSE 8787
VOLUME ["/data"]

CMD ["npm", "start"]
