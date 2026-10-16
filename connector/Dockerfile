FROM node:20-alpine
WORKDIR /app
COPY package.json connector.js ./
USER node
CMD ["node", "connector.js"]
