FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY config ./config
COPY db ./db

ENV SIM_BIND_HOST=0.0.0.0
ENV LTL_APP_HOST=0.0.0.0
USER node
CMD ["node", "src/simulators/main.ts"]
