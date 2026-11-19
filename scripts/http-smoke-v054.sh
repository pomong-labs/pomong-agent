#!/bin/bash
# v0.5.4 HTTP 스모크: 새 라우트(대화방·검색·백업·PIN 카드·자동화 실행)를 실제 express 서버로 검증
set -u
B=http://127.0.0.1:3199
D=/tmp/pa-http-smoke
rm -rf $D && mkdir -p $D
cd /workspace/pomong-agent
DATA_DIR=$D PORT=3199 NODE_ENV=production node server-dist/index.js >$D/server.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s -m 2 $B/api/health | grep -q '"ok":true' && break; sleep 1; done

J=$D/cookies.txt
TOKEN=$(cat $D/setup-token.txt)
curl -s -c $J -X POST $B/api/setup/verify-token -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" >/dev/null
curl -s -b $J -c $J -X POST $B/api/setup/account -H 'Content-Type: application/json' -d '{"username":"e2e","password":"e2e-test-pass"}' >/dev/null
curl -s -b $J -c $J -X POST $B/api/setup/preferences -H 'Content-Type: application/json' -d '{"nickname":"현준","agentName":"포몽","character":"poding","tone":"polite"}' >/dev/null
curl -s -b $J -c $J -X POST $B/api/setup/complete -H 'Content-Type: application/json' -d '{}' >/dev/null

echo "== version"; curl -s $B/api/version
echo; echo "== sessions (기본 방)"
curl -s -b $J $B/api/chat/sessions
echo; echo "== 새 방 + 이름 변경"
NEW=$(curl -s -b $J -X POST $B/api/chat/sessions -H 'Content-Type: application/json' -d '{}')
SID=$(echo "$NEW" | python3 -c "import sys,json;print(json.load(sys.stdin)['session']['id'])")
curl -s -b $J -X PATCH $B/api/chat/sessions/$SID -H 'Content-Type: application/json' -d '{"title":"무신사 로그인 준비"}'
echo; echo "== 방 목록(제목 반영)"
curl -s -b $J $B/api/chat/sessions | python3 -c "import sys,json;[print(' -',s['title'],s['messageCount']) for s in json.load(sys.stdin)['sessions']]"

echo "== vault init + item"
curl -s -b $J -X POST $B/api/vault/init -H 'Content-Type: application/json' -d '{"pin":"1234"}'
curl -s -b $J -X POST $B/api/vault/items -H 'Content-Type: application/json' -d '{"title":"무신사","type":"login","username":"smoke@example.com","secret":"pw-1234","isDefault":true}'
echo; echo "== 항목 수정(아이디·메모만, 비밀번호 비움)"
VID=$(curl -s -b $J "$B/api/vault/items" | python3 -c "import sys,json;print(json.load(sys.stdin)['items'][0]['id'])")
curl -s -b $J -X PATCH $B/api/vault/items/$VID -H 'Content-Type: application/json' -d '{"username":"new@example.com","notes":"새 메모","secret":""}'
curl -s -b $J "$B/api/vault/items" | python3 -c "import sys,json;i=json.load(sys.stdin)['items'][0];print('  usernameMasked',i['usernameMasked'],'| notes',i['notes'])"
curl -s -b $J "$B/api/vault/items/$VID/reveal" | python3 -c "import sys,json;i=json.load(sys.stdin);print('  비밀번호 유지:', i['secret']=='pw-1234')"

echo "== PIN 카드 생성 → 목록 → 제출 → 자동 해제"
curl -s -b $J -X POST $B/api/vault/lock >/dev/null
PID_CARD=$(DATA_DIR=$D node -e "
const db=require('better-sqlite3')('$D/pomong-agent.db');
const {randomUUID}=require('crypto');
const id=randomUUID();
db.prepare('INSERT INTO vault_unlock_requests(id,session_id,service,login_url,vault_id,intent,note,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,'default','무신사','https://member.one.musinsa.com/login','$VID',JSON.stringify({tool:'browser_login_with_vault',vaultId:'$VID'}),'금고가 잠겨 있어 자동 입력을 시작하지 못했습니다.','pending',new Date().toISOString(),new Date().toISOString());
console.log(id);
" 2>/dev/null)
curl -s -b $J "$B/api/vault/login-cards?session=default" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  unlockRequests',len(d['unlockRequests']),'| unlocked',d['unlocked'])"
curl -s -b $J -X POST "$B/api/vault/unlock-card/$PID_CARD/submit" -H 'Content-Type: application/json' -d '{"pin":"9999"}'
echo; curl -s -b $J -X POST "$B/api/vault/unlock-card/$PID_CARD/submit" -H 'Content-Type: application/json' -d '{"pin":"1234"}'
echo; curl -s -b $J "$B/api/vault/login-cards?session=default" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  카드 상태',d['unlockRequests'][0]['status'],'| unlocked',d['unlocked'])"
echo "  (PIN 원문이 DB에 남았는지) $(grep -c 1234 $D/pomong-agent.db 2>/dev/null || echo 0)"

echo "== 자동화 실행/기록 라우트"
JOB=$(curl -s -b $J -X POST $B/api/jobs -H 'Content-Type: application/json' -d '{"name":"아침 브리핑","cron":"0 8 * * *","prompt":"오늘 요약"}')
JID=$(echo "$JOB" | python3 -c "import sys,json;print(json.load(sys.stdin)['job']['id'])")
curl -s -b $J -o /dev/null -w "  run-now http %{http_code}\n" -X POST $B/api/automations/$JID/run-now
curl -s -b $J $B/api/automations/$JID/runs | head -c 200
echo; curl -s -b $J -o /dev/null -w "  없는 id http %{http_code}\n" -X POST $B/api/automations/nope/run-now

echo "== 백업 내보내기"
curl -s -b $J -D $D/head.txt $B/api/backup/export -o $D/backup.json
grep -i "content-disposition" $D/head.txt
python3 - "$D/backup.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print('  format', d['format'], '| counts', d['counts'])
print('  settings redacted keys:', [k for k,v in d['settings'].items() if v=='[redacted]'][:5])
print('  vault meta:', d['vault'])
raw=open(sys.argv[1]).read()
print('  비밀번호(pw-1234) 포함?', 'pw-1234' in raw)
PY

echo "== 정지 엔드포인트(진행 중인 턴 없음)"
curl -s -b $J -X POST $B/api/chat/stop -H 'Content-Type: application/json' -d '{"session":"default"}'
echo; echo "== 서버 로그 오류"; grep -iE "error|unhandled" $D/server.log | head -5 || true
