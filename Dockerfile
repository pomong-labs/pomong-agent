# syntax=docker/dockerfile:1

# ---------- build ----------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.server.json vite.config.ts postcss.config.cjs tailwind.config.cjs index.html ./
COPY src ./src
COPY server ./server
COPY public ./public
COPY scripts ./scripts

RUN npm run build

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3100 \
    DATA_DIR=/app/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# v0.6.5: 첨부 PDF 본문 추출(pdftotext). 한글 PDF에서 가장 정확하다.
#   npm 패키지가 아니라 OS 도구라 node_modules 를 늘리지 않는다.
#   poppler-data 는 한글·중일 CMap(Adobe-Korea1) 언어 팩 — 없으면 한글 PDF가 빈손으로 나온다.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils poppler-data \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server-dist ./server-dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p /app/data

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=6s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server-dist/index.js"]
