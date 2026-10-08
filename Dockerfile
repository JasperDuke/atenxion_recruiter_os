FROM node:22-alpine
WORKDIR /app
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
RUN cd backend && npm install && cd ../frontend && npm install
WORKDIR /app
COPY backend ./backend
COPY frontend ./frontend
RUN cd frontend && npm run build
WORKDIR /app/backend
ENV HOST=0.0.0.0 NODE_PATH=/app/backend/node_modules
EXPOSE 3000
CMD ["npm", "start"]
