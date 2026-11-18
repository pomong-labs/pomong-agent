#!/bin/bash
# UI 스크린샷 + 사용자 조작 감사로그 검증 (임시 컨테이너 사용)
set -u
NET=pomong-agent_default
NAME=pa-shots
VOL=/tmp/pa-shots
BASE=http://127.0.0.1:3197
J=/tmp/pa-shots-cookies.txt
say() { echo "[$(date +%H:%M:%S)] $*"; }

sudo -n docker rm -f $NAME >/dev/null 2>&1
sudo -n rm -rf $VOL /tmp/shots
sudo -n mkdir -p $VOL /tmp/shots
rm -f $J

say "start temp app"
sudo -n docker run -d --name $NAME --network $NET \
  -e NODE_ENV=production -e PORT=3100 -e DATA_DIR=/data \
  -e BROWSER_WS_URL=ws://browser:9222/ -e BROWSER_CONTROL_URL=http://browser:9223/ -e BROWSER_ENABLED=1 -e TZ=Asia/Seoul \
  -v $VOL:/data -p 127.0.0.1:3197:3100 pomong-agent:0.4.0 >/dev/null
for i in $(seq 1 40); do curl -s -m 2 $BASE/api/health | grep -q '"ok":true' && break; sleep 2; done
TOKEN=$(sudo -n cat $VOL/setup-token.txt)
curl -s -o /dev/null -c $J -X POST $BASE/api/setup/verify-token -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}"
curl -s -o /dev/null -b $J -c $J -X POST $BASE/api/setup/account -H 'Content-Type: application/json' -d '{"username":"e2e","password":"e2e-test-pass"}'
curl -s -o /dev/null -b $J -c $J -X POST $BASE/api/setup/preferences -H 'Content-Type: application/json' -d '{"nickname":"현준","agentName":"루아","character":"lamong","tone":"polite"}'
curl -s -o /dev/null -b $J -c $J -X POST $BASE/api/setup/complete -H 'Content-Type: application/json' -d '{}'
say "account ready"

say "seed jobs + watchers"
curl -s -o /dev/null -b $J -X POST $BASE/api/jobs -H 'Content-Type: application/json' -d '{"name":"아침 브리핑","cron":"0 8 * * *","prompt":"오늘 일정과 새 메일, 서버 상태를 요약해줘"}'
curl -s -o /dev/null -b $J -X POST $BASE/api/jobs -H 'Content-Type: application/json' -d '{"name":"서버 상태 점검","cron":"*/30 * * * *","prompt":"CPU·RAM을 확인하고 80%를 넘으면 알려줘"}'
curl -s -o /dev/null -b $J -X POST $BASE/api/jobs -H 'Content-Type: application/json' -d '{"name":"주간 정리","cron":"0 9 * * 1","prompt":"지난주 할 일을 정리해줘","enabled":false}'
curl -s -o /dev/null -b $J -X POST $BASE/api/watchers -H 'Content-Type: application/json' -d '{"name":"쿠팡 재입고","url":"https://example.com","mode":"price","intervalMin":5}'
curl -s -o /dev/null -b $J -X POST $BASE/api/watchers -H 'Content-Type: application/json' -d '{"name":"포몽 에이전트 릴리스","url":"https://github.com/pomong-labs/pomong-agent","mode":"github","target":"pomong-labs/pomong-agent","intervalMin":30}'
WID=$(curl -s -b $J $BASE/api/watchers | python3 -c "import sys,json;print(json.load(sys.stdin)['watchers'][0]['id'])")
curl -s -o /dev/null -b $J -X POST "$BASE/api/watchers/$WID/check"

say "browser session + handover (github login 화면)"
S=$(curl -s -b $J -X POST $BASE/api/browser/sessions -H 'Content-Type: application/json' -d '{}')
SID=$(echo "$S" | python3 -c "import sys,json;print(json.load(sys.stdin)['session']['id'])")
curl -s -o /dev/null -b $J -X POST "$BASE/api/browser/sessions/$SID/handover" -H 'Content-Type: application/json' -d '{"reason":"login","detail":"직접 입력 후 완료를 눌러주세요"}'
curl -s -o /dev/null -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"goto","url":"https://github.com/login"}'
sleep 5
curl -s -o /dev/null -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"click","x":640,"y":420}'
curl -s -o /dev/null -b $J -X POST "$BASE/api/browser/sessions/$SID/input" -H 'Content-Type: application/json' -d '{"type":"text","text":"hyunjun"}'
sleep 1

say "user action audit"
curl -s -b $J "$BASE/api/browser/sessions/$SID/actions" | python3 -c "import sys,json;[print('  ',a['actor'],a['tool'],'|',a['result'][:40]) for a in json.load(sys.stdin)['actions']]" 2>/dev/null || true

say "screenshots"
sudo -n docker run --rm --network $NET --shm-size=256m \
  -e APP_BASE=http://$NAME:3100 -v /home/ubuntu/ui-screenshot.js:/s/ui-screenshot.js:ro -v /tmp/shots:/out \
  pomong-agent-browser:0.4.0 node /s/ui-screenshot.js
sudo -n ls -la /tmp/shots

say "keep container for inspection; run: docker rm -f $NAME"
