#!/bin/bash
# Phase 2 API 통합 스모크 테스트 (로컬, 임시 DATA_DIR)
set -u
export PATH=/workspace/.tools/node-v20.18.1-linux-x64/bin:$PATH
cd /workspace/pomong-agent
DIR=$PWD/.uitest/local
rm -rf "$DIR"; mkdir -p "$DIR"
DATA_DIR="$DIR" PORT=3199 NODE_ENV=production node server-dist/index.js > "$DIR/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
sleep 3
TOKEN=$(cat "$DIR/setup-token.txt")
J="$DIR/cookies.txt"
curl -s -c "$J" -X POST localhost:3199/api/setup/verify-token -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" > /dev/null
curl -s -b "$J" -c "$J" -X POST localhost:3199/api/setup/account -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}' > /dev/null
curl -s -b "$J" -c "$J" -X POST localhost:3199/api/setup/preferences -H 'Content-Type: application/json' -d '{"nickname":"테스터","agentName":"루아","character":"lamong","tone":"polite"}' > /dev/null
curl -s -b "$J" -c "$J" -X POST localhost:3199/api/setup/complete -H 'Content-Type: application/json' -d '{}' > /dev/null

echo "== create job"
JOB=$(curl -s -b "$J" -X POST localhost:3199/api/jobs -H 'Content-Type: application/json' -d '{"name":"아침 브리핑","cron":"0 8 * * *","prompt":"오늘 일정과 서버 상태를 요약해줘"}')
echo "$JOB" | head -c 400; echo
JOB_ID=$(echo "$JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['job']['id'])")
echo "== jobs list"; curl -s -b "$J" localhost:3199/api/jobs | head -c 200; echo
echo "== preview"; curl -s -b "$J" "localhost:3199/api/jobs/preview?cron=*/30%20*%20*%20*%20*"; echo
echo "== bad cron"; curl -s -b "$J" "localhost:3199/api/jobs/preview?cron=bad%20cron"; echo
echo "== patch job (disable)"; curl -s -b "$J" -X PATCH "localhost:3199/api/jobs/$JOB_ID" -H 'Content-Type: application/json' -d '{"enabled":false}' | head -c 200; echo

echo "== create watcher"
W=$(curl -s -b "$J" -X POST localhost:3199/api/watchers -H 'Content-Type: application/json' -d '{"name":"예제 페이지","url":"https://example.com","mode":"text","intervalMin":30}')
echo "$W" | head -c 300; echo
WID=$(echo "$W" | python3 -c "import sys,json; print(json.load(sys.stdin)['watcher']['id'])")
echo "== check watcher"; curl -s -b "$J" -X POST "localhost:3199/api/watchers/$WID/check" | head -c 300; echo
echo "== watcher events"; curl -s -b "$J" "localhost:3199/api/watchers/$WID/events" | head -c 300; echo
echo "== watchers list"; curl -s -b "$J" localhost:3199/api/watchers | head -c 250; echo

echo "== policies"; curl -s -b "$J" localhost:3199/api/policies | head -c 200; echo
echo "== add policy"; curl -s -b "$J" -X POST localhost:3199/api/policies -H 'Content-Type: application/json' -d '{"pattern":"my-shop.example","level":"confirm"}' | head -c 120; echo
echo "== remove policy"; curl -s -b "$J" -X DELETE "localhost:3199/api/policies/my-shop.example" | head -c 80; echo

echo "== browser status"; curl -s -b "$J" localhost:3199/api/browser/status | head -c 300; echo
echo "== browser create (worker off)"; curl -s -b "$J" -X POST localhost:3199/api/browser/sessions -H 'Content-Type: application/json' -d '{}' | head -c 300; echo

echo "== events recent"; curl -s -b "$J" localhost:3199/api/events/recent | head -c 300; echo
echo "== tools catalog count"; curl -s -b "$J" localhost:3199/api/tools | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['tools']), [t['name'] for t in d['tools']][-6:])"
echo "== health"; curl -s -b "$J" localhost:3199/api/health; echo
echo "== run job (no AI key -> error)"
curl -s -b "$J" -X POST "localhost:3199/api/jobs/$JOB_ID/run" | head -c 300; echo
echo "== runs"; curl -s -b "$J" localhost:3199/api/runs | head -c 400; echo
echo "== log tail"; tail -5 "$DIR/server.log"
