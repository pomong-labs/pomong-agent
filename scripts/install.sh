#!/usr/bin/env bash
# Pomong Agent — one-shot installer for a Docker host.
# Usage:  ./scripts/install.sh
#         OR: curl -fsSL https://raw.githubusercontent.com/pomong-labs/pomong-agent/main/scripts/install.sh | bash

set -euo pipefail

GREEN='\033[0;32m'
PURPLE='\033[0;35m'
YELLOW='\033[1;33m'
NC='\033[0m'

say() { printf "${PURPLE}🫧 %s${NC}\n" "$1"; }
ok() { printf "${GREEN}✔ %s${NC}\n" "$1"; }
warn() { printf "${YELLOW}! %s${NC}\n" "$1"; }

# 1) docker + compose plugin
if ! command -v docker >/dev/null 2>&1; then
  say "Docker가 없어 설치를 시도합니다…"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  else
    echo "Docker를 먼저 설치해 주세요: https://docs.docker.com/engine/install/" >&2
    exit 1
  fi
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "docker compose 플러그인이 필요합니다." >&2
  exit 1
fi
ok "Docker 준비 완료"

# 2) project files with an already templated URL, or existing checkout only
if [ ! -f docker-compose.yml ]; then
  say "저장소를 내려받습니다…"
  git clone https://github.com/pomong-labs/pomong-agent.git
  cd pomong-agent
fi

PORT="$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-3100}"

# 3) build & run
say "이미지를 빌드하고 기동합니다 (첫 빌드는 2~5분 걸릴 수 있어요)…"
$COMPOSE up -d --build

say "헬스체크를 기다리는 중…"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ok "서버가 응답합니다"
    break
  fi
  sleep 2
done

# 4) setup URL
TOKEN_URL="$($COMPOSE logs --no-log-prefix pomong-agent 2>/dev/null | grep -o 'http://[^ ]*setup?token=[A-Za-z0-9_-]*' | tail -1 || true)"

echo
if [ -n "${TOKEN_URL}" ]; then
  say "아래 1회용 주소를 브라우저에서 여세요 (설정 후 자동으로 잠깁니다):"
  printf "  ${GREEN}%s${NC}\n" "${TOKEN_URL}"
  warn "외부에서 접속한다면 localhost 대신 서버 주소/도메인으로 바꿔 여세요."
else
  warn "설정 주소를 찾지 못했습니다. 아래 로그에서 직접 확인해 주세요:"
  echo "  $COMPOSE logs pomong-agent | grep setup"
fi
echo
say "설정을 마치면 http://127.0.0.1:${PORT}/login 으로 접속합니다."
