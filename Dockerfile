FROM node:22-alpine
WORKDIR /app
COPY server.js index.html ./
ENV DATA_DIR=/data
CMD ["node", "server.js"]
