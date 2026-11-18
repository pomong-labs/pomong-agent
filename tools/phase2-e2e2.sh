#!/bin/bash
# Phase 2 실서버 E2E v2 — 앱 HTTP API 경로(한 프로세스)로 검증한다.
set -u
NET=pomong-agent_default
NAME=pa-e2e
VOL=/tmp/pa-e2e
BASE=http://127.0.0.1:3198
J=/tmp/pa-e2e-cookies.txt
say() { echo "[$(date +%H:%M:%S)] $*"; }
nowms() { date +%s%3N; }

say "cleanup"
rm -f $J
sudo -n docker rm -f $NAME >/dev/null 2>&1
sudo -n rm -rf $VOL
sudo -n mkdir -p $VOL

say "start temp container"
sudo -n docker run -d --name $NAME --network $NET \
  -e NODE_ENV=production -e PORT=3100 -e DATA_DIR=/data \
  -e BROWSER_WS_URL=ws://browser:9222/ -e BROWSER_CONTROL_URL=http://browser:9223/ -e BROWSER_ENABLED=1 -e TZ=Asia/Seoul \
  -v $VOL:/data -p 127.0.0.1:3198:3100 pomong-agent:0.4.0 >/dev/null || exit 1
for i in $(seq 1 40); do
  curl -s -m 2 $BASE/api/health | grep -q '"ok":true' && break
  sleep 2
done
say "health: $(curl -s $BASE/api/health)"
TOKEN=$(sudo -n cat $VOL/setup-token.txt)
curl -s -o /dev/null -c $J -X POST $BASE/api/setup/verify-token -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}"
curl -s -o /dev/null -b $J -c $J -X POST $BASE/api/setup/account -H 'Content-Type: application/json' -d '{"username":"e2e","password":"e2e-test-pass"}'
curl -s -o /dev/null -b $J -c $J -X POST $BASE/api/setup/preferences -H 'Content-Type: application/json' -d '{"nickname":"E2E","agentName":"테스트","character":"pimong","tone":"polite"}'
curl -s -o /dev/null -b $J -c $J -X POST $BASE/api/setup/complete -H 'Content-Type: application/json' -d '{}'
say "auth: $(curl -s -b $J $BASE/api/jobs | head -c 60)"

say "1) 세션 생성 (첫 브라우저 기동 시간 측정)"
T0=$(nowms)
S=$(curl -s -b $J -X POST $BASE/api/browser/sessions -H 'Content-Type: application/json' -d '{}')
T1=$(nowms)
say "  소요 $(( (T1-T0) ))ms"
echo "$S" | head -c 260; echo
SID=$(echo "$S" | python3 -c "import sys,json;print(json.load(sys.stdin).get('session',{}).get('id',''))" 2>/dev/null)
[ -z "$SID" ] && { say "세션 생성 실패 — 중단"; sudo -n docker logs --tail 20 $NAME; exit 1; }

say "2) 화면 프레임"
T0=$(nowms)
curl -s -b $J -o /tmp/f1.jpg -w "  http=%{http_code} bytes=%{size_download}" "$BASE/api/browser/sessions/$SID/frame"; T1=$(nowms); echo " $((T1-T0))ms"
file /tmp/f1.jpg 2>/dev/null | head -1

say "3) 핸드오버 → 사용자 조작(goto 위키백과)"
curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/handover" -H 'Content-Type: application/json' -d '{"reason":"login","detail":"E2E 로그인"}' | head -c 200; echo
curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"goto","url":"https://www.wikipedia.org"}'; echo
sleep 3
curl -s -b $J -o /tmp/f2.jpg -w "  frame2 http=%{http_code} bytes=%{size_download}\n" "$BASE/api/browser/sessions/$SID/frame"
say "4) 사용자 클릭+타이핑"
curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"click","x":330,"y":130}'; echo
curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"text","text":"Pomong"}'; echo
curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"key","key":"Enter"}'; echo
sleep 3
curl -s -b $J -o /tmp/f3.jpg -w "  frame3 http=%{http_code} bytes=%{size_download}\n" "$BASE/api/browser/sessions/$SID/frame"

say "5) 액션 로그"
curl -s -b $J "$BASE/api/browser/sessions/$SID/actions" | head -c 400; echo

say "6) 재개(AI에게 넘김) → 이후 예약 실행 목록"
curl -s -b $J -X POST "$BASE/api/browser/sessions/$SID/resume"; echo

say "7) 예약 실행 만들기 + 다음 3회"
JOB=$(curl -s -b $J -X POST $BASE/api/jobs -H 'Content-Type: application/json' -d '{"name":"아침 브리핑","cron":"0 8 * * *","prompt":"오늘 일정과 서버 상태를 요약해줘"}')
echo "$JOB" | python3 -c "import sys,json;d=json.load(sys.stdin)['job'];print(' ',d['name'],d['scheduleLabel'],d['nextRuns'])"
JID=$(echo "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['id'])")
say "  즉시 실행(키 없음 → 실패 기록이 남는지)"
curl -s -b $J -X POST "$BASE/api/jobs/$JID/run" | head -c 220; echo

say "8) 워치 만들기 + 즉시 확인"
W=$(curl -s -b $J -X POST $BASE/api/watchers -H 'Content-Type: application/json' -d '{"name":"예제","url":"https://example.com","mode":"text","intervalMin":30}')
WID=$(echo "$W" | python3 -c "import sys,json;print(json.load(sys.stdin).get('watcher',{}).get('id',''))" 2>/dev/null)
curl -s -b $J -X POST "$BASE/api/watchers/$WID/check" | head -c 240; echo

say "9) 정책"
curl -s -b $J $BASE/api/policies | python3 -c "import sys,json;d=json.load(sys.stdin)['policies'];print(' 총',len(d),'개')"

say "10) 세션 닫기 → 워커 회수 확인"
curl -s -b $J -X DELETE "$BASE/api/browser/sessions/$SID"; echo
sleep 2
say "  워커 상태: $(sudo -n docker exec pomong-browser node -e 'fetch("http://127.0.0.1:9223/health").then(r=>r.text()).then(t=>process.stdout.write(t))')"

say "11) 리소스"
free -m | head -2
sudo -n docker stats --no-stream --format "{{.Name}} {{.MemUsage}} {{.CPUPerc}}" $NAME pomong-browser pomong-agent

say "cleanup"
sudo -n docker rm -f $NAME >/dev/null 2>&1
sudo -n rm -rf $VOL
say "done"
