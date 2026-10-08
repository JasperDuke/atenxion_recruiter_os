FROM node:22-alpine
WORKDIR /app
COPY backend/package.json ./backend/
WORKDIR /app/backend
RUN npm install
WORKDIR /app
COPY backend ./backend
WORKDIR /app/backend
ENV HOST=0.0.0.0 NODE_PATH=/app/backend/node_modules
EXPOSE 3000
CMD ["npm", "start"]
