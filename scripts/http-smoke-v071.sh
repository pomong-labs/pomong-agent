#!/bin/bash
# v0.7.1 HTTP 스모크: 워크플로우 빌더·기억 그래프·하이브리드 기억 라우트를 실제 express 서버로 검증
set -u
B=http://127.0.0.1:3198
D=/tmp/pa-http-smoke-v071
rm -rf $D && mkdir -p $D
cd /workspace/pomong-agent || exit 1
DATA_DIR=$D PORT=3198 NODE_ENV=production node server-dist/index.js >$D/server.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -s -m 2 $B/api/health | grep -q '"ok":true' && break; sleep 1; done

J=$D/cookies.txt
TOKEN=$(cat $D/setup-token.txt)
curl -s -c $J -X POST $B/api/setup/verify-token -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" >/dev/null
curl -s -b $J -c $J -X POST $B/api/setup/account -H 'Content-Type: application/json' -d '{"username":"e2e","password":"e2e-test-pass"}' >/dev/null
curl -s -b $J -c $J -X POST $B/api/setup/preferences -H 'Content-Type: application/json' -d '{"nickname":"홍길동","agentName":"포몽","character":"poding","tone":"polite"}' >/dev/null
curl -s -b $J -c $J -X POST $B/api/setup/complete -H 'Content-Type: application/json' -d '{}' >/dev/null

echo "== version"; curl -s $B/api/version; echo
echo "== health"; curl -s $B/api/health | head -c 120; echo

echo "== /api/tools — 워크플로우 빌더 도구 목록"
curl -s -b $J $B/api/tools | python3 -c "import sys,json;d=json.load(sys.stdin);w=d.get('workflowTools') or [];print('  workflowTools', len(w), '| blocked 포함?', any(t['name'] in ('mail_send','manage_docker','browser_fill_vault') for t in w));print('  예:', [t['name'] for t in w[:4]])"

echo "== /api/skills — 워크플로우 템플릿"
curl -s -b $J $B/api/skills | python3 -c "import sys,json;d=json.load(sys.stdin);print('  skills',len(d['skills']),'| workflowTemplates',len(d.get('workflowTemplates') or []))"

echo "== 워크플로우 저장(도구+할 일)"
CREATED=$(curl -s -b $J -X POST $B/api/skills -H 'Content-Type: application/json' -d '{"name":"HTTP 스모크 흐름","mode":"workflow","keywords":"스모크","steps":[{"kind":"tool","label":"현재 시각","tool":"time_now","args":{}},{"kind":"action","label":"할 일 등록","action":"todo","text":"HTTP 스모크 할 일 {{step1}}"}]}')
echo "$CREATED" | python3 -c "import sys,json;d=json.load(sys.stdin);s=d.get('skill') or {};print('  ok',d.get('ok'),'| mode',s.get('mode'),'| steps',len(s.get('steps') or []))"
SID=$(echo "$CREATED" | python3 -c "import sys,json;print((json.load(sys.stdin).get('skill') or {}).get('id',''))")

echo "== 워크플로우 테스트 실행(저장 전)"
curl -s -b $J -X POST $B/api/skills/workflow/test -H 'Content-Type: application/json' -d '{"name":"테스트","input":"점검","steps":[{"kind":"tool","label":"시각","tool":"time_now","args":{}},{"kind":"action","label":"알림","action":"notify","text":"{{input}} 확인"}]}' | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('run') or {};print('  ok',d.get('ok'),'| steps',[(s['label'],s['status'],s['durationMs']) for s in (r.get('steps') or [])]);print('  출력:', (r.get('output') or '')[:70])"

echo "== 저장된 워크플로우 즉시 실행"
curl -s -b $J -X POST $B/api/skills/$SID/run -H 'Content-Type: application/json' -d '{"input":"HTTP 점검"}' | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('run') or {};print('  ok',d.get('ok'),'|',[ (s['label'],s['status']) for s in (r.get('steps') or [])])"

echo "== 막힌 도구(메일 발송) 포함 워크플로우 저장 거부"
curl -s -b $J -o /dev/null -w "  http %{http_code}\n" -X POST $B/api/skills -H 'Content-Type: application/json' -d '{"name":"위험","mode":"workflow","steps":[{"kind":"tool","label":"메일","tool":"mail_send","args":{"to":"a@b.c","subject":"s","text":"t"}}]}'

echo "== 기억 3개 + 고정 + 비슷한 새 기억"
M1=$(curl -s -b $J -X POST $B/api/memory -H 'Content-Type: application/json' -d '{"content":"아메리카노를 좋아한다","category":"taste","importance":3}' | python3 -c "import sys,json;print(json.load(sys.stdin)['memory']['id'])")
M2=$(curl -s -b $J -X POST $B/api/memory -H 'Content-Type: application/json' -d '{"content":"주말에는 등산을 간다","category":"habit","importance":2}' | python3 -c "import sys,json;print(json.load(sys.stdin)['memory']['id'])")
M3=$(curl -s -b $J -X POST $B/api/memory -H 'Content-Type: application/json' -d '{"content":"금요일까지 보고서 마감","category":"promise","importance":4}' | python3 -c "import sys,json;print(json.load(sys.stdin)['memory']['id'])")
curl -s -b $J -X PATCH $B/api/memory/$M3 -H 'Content-Type: application/json' -d '{"pinned":true}' | python3 -c "import sys,json;m=json.load(sys.stdin)['memory'];print('  고정', m['pinned'], '| 태그', m['tags'])"
curl -s -b $J -X POST $B/api/memory -H 'Content-Type: application/json' -d '{"content":"아메리카노를 정말 좋아한다","category":"taste","importance":3}' | python3 -c "import sys,json;m=json.load(sys.stdin)['memory'];print('  새 기억', m['id'][:8], '| 대체 표시', m['supersededBy'])"
curl -s -b $J "$B/api/memory" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  목록', len(d['memories']), '| 이전 버전', d.get('supersededCount'))"
curl -s -b $J "$B/api/memory?includeSuperseded=1" | python3 -c "import sys,json;d=json.load(sys.stdin);print('  이전 버전 포함', len(d['memories']))"

echo "== 기억 그래프 + 수동 연결"
G=$(curl -s -b $J $B/api/memory/graph)
echo "$G" | python3 -c "import sys,json;g=json.load(sys.stdin)['graph'];print('  nodes',len(g['nodes']),'| edges',len(g['edges']),'|',g['counts'])"
echo "$G" | python3 -c "import sys,json;g=json.load(sys.stdin)['graph'];print('  kinds', sorted({n['kind'] for n in g['nodes']}))"
curl -s -b $J -X POST $B/api/memory/graph/edge -H 'Content-Type: application/json' -d "{\"a\":\"$M1\",\"b\":\"$M2\",\"action\":\"link\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);g=d.get('graph') or {};print('  연결', d.get('ok'), '| link 엣지', len([e for e in (g.get('edges') or []) if e['kind']=='link']))"
curl -s -b $J -X POST $B/api/memory/graph/edge -H 'Content-Type: application/json' -d "{\"a\":\"$M1\",\"b\":\"$M2\",\"action\":\"unlink\"}" | python3 -c "import sys,json;print('  해제', json.load(sys.stdin).get('ok'))"

echo "== 중복 정리"
curl -s -b $J -X POST $B/api/memory/consolidate | python3 -c "import sys,json;d=json.load(sys.stdin);print('  ok',d.get('ok'),'| 정리',d.get('superseded'),'| 남은 기억',d.get('count'))"

echo "== 서버 로그 오류"
grep -iE "error|unhandled|TypeError" $D/server.log | head -5 || true
