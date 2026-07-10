FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY dist/ ./dist/
ENV PORT=8090
EXPOSE 8090
CMD ["node", "dist/index.js"]
