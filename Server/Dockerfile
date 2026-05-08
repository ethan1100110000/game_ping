FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV GAMEPING_DATA_DIR=/data

COPY package.json ./
COPY server.mjs apns.mjs ./
COPY public ./public

RUN mkdir -p /data

EXPOSE 8787
CMD ["npm", "run", "start:prod"]
