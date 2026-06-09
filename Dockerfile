FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist/ ./dist/
COPY public/ ./public/
COPY meetings.config.docker.yml ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh
EXPOSE 4200
VOLUME ["/app/data"]
ENV NODE_ENV=production
ENTRYPOINT ["./docker-entrypoint.sh"]
