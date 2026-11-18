#!/bin/bash
# Phase 2 실서버 E2E — 임시 컨테이너(별도 데이터)에서 실행한다. 실제 data/ 는 건드리지 않는다.
set -u
NET=pomong-agent_default
NAME=pa-e2e
VOL=/tmp/pa-e2e
BASE=http://127.0.0.1:3198
J=/tmp/pa-e2e-cookies.txt
say() { echo "[$(date +%H:%M:%S)] $*"; }

say "cleanup"
rm -f $J
sudo -n docker rm -f $NAME >/dev/null 2>&1
sudo -n rm -rf $VOL
sudo -n mkdir -p $VOL

say "start temp container"
sudo -n docker run -d --name $NAME --network $NET \
  -e NODE_ENV=production -e PORT=3100 -e DATA_DIR=/data \
  -e BROWSER_WS_URL=ws://browser:9222/ -e BROWSER_ENABLED=1 -e TZ=Asia/Seoul \
  -v $VOL:/data -p 127.0.0.1:3198:3100 pomong-agent:0.4.0 >/dev/null || exit 1

for i in $(seq 1 40); do
  curl -s -m 2 $BASE/api/health | grep -q '"ok":true' && break
  sleep 2
done
say "health: $(curl -s $BASE/api/health)"
TOKEN=$(sudo -n cat $VOL/setup-token.txt)
say "token length ${#TOKEN}"

code=$(curl -s -o /dev/null -w '%{http_code}' -c $J -X POST $BASE/api/setup/verify-token -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}")
say "verify-token → $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b $J -c $J -X POST $BASE/api/setup/account -H 'Content-Type: application/json' -d '{"username":"e2e","password":"e2e-test-pass"}')
say "account → $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b $J -c $J -X POST $BASE/api/setup/preferences -H 'Content-Type: application/json' -d '{"nickname":"E2E","agentName":"테스트","character":"pimong","tone":"polite"}')
say "preferences → $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -b $J -c $J -X POST $BASE/api/setup/complete -H 'Content-Type: application/json' -d '{}')
say "complete → $code"
say "cookie count: $(grep -c pa_ $J 2>/dev/null || echo 0)"
say "auth check: $(curl -s -b $J $BASE/api/jobs | head -c 120)"

say "browser status: $(curl -s -b $J $BASE/api/browser/status | head -c 200)"

say "tool: browser_open example.com"
sudo -n docker exec -e DATA_DIR=/data $NAME node -e '
const tools = require("/app/server-dist/tools.js");
(async () => {
  const r = await tools.runTool("browser_open", { url: "https://example.com" });
  console.log(r.content.slice(0, 600));
  const shot = await tools.runTool("browser_screenshot", {});
  console.log("SHOT:", shot.content.slice(0, 160));
})().catch((e) => { console.error("TOOL FAILED", e.message); process.exit(1); });
' 2>&1 | tail -25

S=$(curl -s -b $J -X POST $BASE/api/browser/sessions -H 'Content-Type: application/json' -d '{}')
say "session: $(echo "$S" | head -c 220)"
SID=$(echo "$S" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null)

if [ -n "$SID" ]; then
  curl -s -b $J -o /tmp/frame1.jpg -w "frame http=%{http_code} bytes=%{size_download}\n" "$BASE/api/browser/sessions/$SID/frame"

  say "handover"
  curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/handover" -H 'Content-Type: application/json' -d '{"reason":"login","detail":"E2E 로그인"}' | head -c 200; echo

  say "user goto (wikipedia)"
  curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"goto","url":"https://www.wikipedia.org"}' | head -c 120; echo
  sleep 3
  curl -s -b $J -o /tmp/frame2.jpg -w "frame2 http=%{http_code} bytes=%{size_download}\n" "$BASE/api/browser/sessions/$SID/frame"

  say "user click + typing (검색창)"
  curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"click","x":300,"y":120}' | head -c 80; echo
  curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"text","text":"포몽"}' | head -c 80; echo
  sleep 2
  curl -s -b $J -o /tmp/frame3.jpg -w "frame3 http=%{http_code} bytes=%{size_download}\n" "$BASE/api/browser/sessions/$SID/frame"

  say "agent action blocked while user controls"
  sudo -n docker exec -e DATA_DIR=/data $NAME node -e '
const tools = require("/app/server-dist/tools.js");
(async () => {
  const r = await tools.runTool("browser_snapshot", {});
  console.log("BLOCK:", r.content.slice(0, 150));
})().catch((e) => console.error("ERR", e.message));
' 2>&1 | tail -3

  say "resume"
  curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/resume" | head -c 120; echo

  say "payment hard block"
  sudo -n docker exec -e DATA_DIR=/data $NAME node -e '
const tools = require("/app/server-dist/tools.js");
(async () => {
  const r = await tools.runTool("browser_click", { text: "결제하기" });
  console.log("PAYMENT:", r.content.slice(0, 140));
  const t = await tools.runTool("browser_type", { ref: "e1", text: "secret" });
  console.log("TYPE:", t.content.slice(0, 140));
})().catch((e) => console.error("ERR", e.message));
' 2>&1 | tail -4

  say "actions"
  curl -s -b $J "$BASE/api/browser/sessions/$SID/actions" | head -c 350; echo

  say "close session"
  curl -s -b $J -X DELETE "$BASE/api/browser/sessions/$SID" | head -c 60; echo
fi

say "resource usage"
free -m | head -2
sudo -n docker stats --no-stream --format "{{.Name}} {{.MemUsage}} {{.CPUPerc}}" pa-e2e pomong-browser pomong-agent 2>/dev/null

say "job + watcher on temp instance"
curl -s -b $J -X POST $BASE/api/jobs -H 'Content-Type: application/json' -d '{"name":"E2E 잡","cron":"0 8 * * *","prompt":"테스트"}' | head -c 140; echo
W=$(curl -s -b $J -X POST $BASE/api/watchers -H 'Content-Type: application/json' -d '{"name":"E2E 워치","url":"https://example.com","mode":"text"}')
WID=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin).get('watcher',{}).get('id',''))" 2>/dev/null)
curl -s -b $J -X POST "$BASE/api/watchers/$WID/check" | head -c 260; echo

say "cleanup"
rm -f $J
sudo -n docker rm -f $NAME >/dev/null 2>&1
sudo -n rm -rf $VOL
say "done"
