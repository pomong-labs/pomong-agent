# 🫧 Pomong Agent

**내 서버에 한 줄로 띄우는 개인 AI 비서 OS.**
BYOK 멀티 LLM · 서버 관제 · 암호화 금고 · 웹 푸시 · 완전한 셀프호스팅.

> A self-hosted personal AI assistant OS. Bring your own LLM key (Gemini · OpenAI · Claude),
> watch your server in real time, and keep secrets in a local AES-256-GCM vault.
> Everything runs on your own machine — no accounts, no telemetry, no vendor lock-in.

<p align="center">
  <img src="brand/mascots-sheets/all-six.jpg" alt="Pomong characters" width="640" />
</p>

---

## 왜 만들었나

기존 AI 비서는 대화 내용이 남의 서버로 가고, 모델과 한도를 서비스가 정합니다.
Pomong Agent는 반대로 갑니다.

- **내 서버에서만 동작** — 대화·메모·비밀번호가 내 디스크를 떠나지 않습니다.
- **BYOK (Bring Your Own Key)** — Gemini · OpenAI · Claude 중 원하는 모델을 골라 연결합니다. 한도는 내 키의 한도일 뿐입니다.
- **서버를 함께 봅니다** — CPU·RAM·Disk 실측, 상위 프로세스, 시스템 로그를 채팅 안에서 바로 확인합니다.
- **금고** — API 키와 로그인 정보를 PIN으로 잠그고 AES-256-GCM으로 암호화해 보관합니다.
- **포몽이 캐릭터** — 서버가 힘들면 함께 걱정해 주는 6종 마스코트.

## v0.4.0에 들어있는 것 — Phase 2 (자율 브라우저 · 자동화)

| 기능 | 내용 |
| --- | --- |
| 자율 웹 브라우저 | Playwright(Chromium)로 실제 사이트를 열고 읽고 누릅니다. 접근성 트리에서 뽑은 `ref`(e1, e2 …)로 클릭·입력하고, 화면 텍스트는 `<untrusted>`로 격리합니다. 옵션 컨테이너(프로필 `browser`)에서만 동작하며, 연결하지 않으면 크로미움이 아예 뜨지 않습니다. |
| 화면 넘겨받기(핸드오버) | 로그인·인증번호(OTP)·캡차·결제·본인인증 화면은 에이전트가 조작하지 않고 사용자에게 넘깁니다. 사용자는 앱 안의 라이브 화면(스크린샷 스트림 + 입력 브리지)에서 직접 입력하고 「인증 완료 · AI에게 넘기기」를 누르면 AI가 이어서 진행합니다. |
| 제어권 리스 | `agent` / `user` 한쪽만 조작할 수 있습니다. 사용자가 조작하는 동안 에이전트 도구 호출은 서버에서 거부되고(15분 리스, 무입력 시 자동 회수), 핸드오버 중에는 에이전트가 화면 텍스트를 읽지 않습니다. |
| 결제 하드블록 | 카드·계좌·비밀번호 필드 입력은 API 레벨에서 거부. 결제·구매·게시·댓글·삭제 버튼은 클릭 자체가 막히고 사용자에게 넘깁니다. |
| 예약 실행(스케줄러) | cron 5필드 + 프리셋(`매일 08:00`, `평일 09:00`, `30분마다`), 잡별 타임존, 다음 3회 미리보기, 겹침 건너뜀, 놓친 실행은 2시간 이내 1회 따라잡기, 실행당 단계 예산. 예약 잡은 사람이 필요한 단계에서 스스로 멈추고 «승인 대기»로 알립니다. |
| 워치(웹 변화 감시) | CSS 선택자 · 전체 텍스트 · JSON 경로 · 정규식 · 가격/재고 · RSS · GitHub 릴리스 · 서버 ping. 정규화 후 SHA-256 비교, 이전/이후 diff 요약, 최소 5분 주기(±10% 지터), 실패 3회면 알림 + 주기 자동 2배. 구매는 하지 않습니다. |
| 도메인 정책 | allow / confirm / handover / block 4단계. 기본 시드(공개 정보 allow, 쇼핑 confirm, 금융·정부 handover, 도박·성인·거래소 block)로 시작하고 설정 화면에서만 바꿀 수 있습니다(모델은 변경 불가). |
| 알림 | SSE 실시간 이벤트(잡 완료·워치 변경·핸드오버 요청). 텔레그램·디스코드·웹푸시 어댑터는 이 이벤트를 구독해 붙입니다. |

## v0.5.1에 들어있는 것 — 작업 카드 · 뒤로가기 · 로그인 카드 (2026-11-18)

| 기능 | 내용 |
| --- | --- |
| 작업 카드는 진짜 일할 때만 | `task_run`을 턴 시작이 아니라 **실제 도구가 처음 실행될 때(lazy)** 만듭니다. 일반 대화나 `chat_notify`(중간 말풍선)만 있는 턴에는 "작업하는 중 0단계" 빈 카드가 뜨지 않고, 화면에서도 단계가 없는 카드는 그리지 않습니다. |
| 하위 페이지 뒤로가기 | `더보기`에서 들어가는 기억함·연결된 앱 및 서비스·할 일·설정·도구 화면 상단에 `←` 버튼을 넣었습니다. 들어온 기록이 있으면 한 단계 되돌아가고, 딥링크로 바로 들어온 경우 `더보기`로 보냅니다. |
| 채팅 인라인 로그인 카드 | 금고에 계정이 없으면 AI가 "직접 로그인하세요"로 끝내지 않고 `vault_request_login`으로 채팅에 아이디·비밀번호 입력 카드를 띄웁니다. `[저장하고 로그인하기]`를 누르면 서버가 금고에 암호화 저장(`is_default`)한 뒤 **AI에게 후속 턴을 붙여 브라우저 로그인까지 이어서** 합니다(OTP·캡차만 핸드오버). 금고가 잠겨 있으면 카드에서 PIN을 함께 받습니다. 비밀번호는 대화·프롬프트·로그에 남지 않고 `vault_id`만 AI에게 전달합니다. |

## v0.5.0에 들어있는 것 — 기억 · 작업 카드 · 푸시 (2026-11-18)

| 기능 | 내용 |
| --- | --- |
| 영구 기억 + 자동 기억 | SQLite `memories`에 취향·습관·직업·인물·약속·프로젝트 규칙을 저장합니다. 사용자가 말하지 않아도 AI가 `memory_save`로 스스로 남기고, 매 턴 핵심 기억 + 질문 키워드에 맞는 기억을 시스템 프롬프트에 자동 주입합니다. `더보기 → 기억함`에서 직접 보고 고칠 수 있습니다. |
| AI 연속 말풍선 | `chat_notify` 도구로 오래 걸리는 작업 전에 "깃허브 연동해 드릴게요, 잠시만요!" 같은 중간 말풍선을 먼저 보냅니다(DB 저장 + SSE). |
| 실시간 작업 카드 | 한 턴에서 도구를 여러 번 쓰면 채팅 말풍선 흐름에 작업 카드(진행 중/완료/실패, 단계 수)가 실시간으로 뜨고, 펼치면 단계별 도구·요약·소요 시간이 보입니다. |
| 금고 자동 로그인 · 다중 계정 | 금고에 `기본 계정`을 지정하면 AI가 `vault_find_for_site` → `browser_fill_vault`로 아이디·비밀번호를 직접 채웁니다. 비밀번호는 AI 응답·감사 로그에 남지 않습니다. 같은 서비스 계정이 여러 개이고 기본 계정이 없으면 임의로 고르지 않고 채팅에서 물어봅니다. |
| 브라우저 로그인 세션 유지 | `data/browser-state.json`에 쿠키·스토리지를 저장해 앱을 다시 열어도 깃허브·쇼핑몰 로그인이 유지됩니다. 설정에서 초기화할 수 있습니다. |
| 모바일 브라우저 조작 | 세션 닫기 버튼, 한글 조합·붙여넣기 입력, 손가락 스와이프/휠 스크롤, 1x/1.5x/2x 확대, 우클릭 모드, 클릭 위치 표시, 입력 즉시(120ms) 프레임 갱신. |
| 기본 스텔스 + 무료 웹 검색 | 일반 데스크톱 Chrome UA와 기본 스텔스 처리로 불필요한 봇 차단을 줄이고, API 키 없이 동작하는 `web_search`(DuckDuckGo HTML, 5~8건)로 봇 차단이 강한 사이트에서도 정보를 찾아 답합니다. |
| 앱 및 서비스 카탈로그 | `더보기 → 연결된 앱 및 서비스`에서 깃허브·노션·지메일·네이버·쿠팡·무신사·야놀자·SRT·캐치테이블·컬리·올리브영·크몽·RouteNote를 카테고리·검색으로 찾고, 금고 계정이나 브라우저 세션이 있으면 「연결됨」으로 표시합니다. 예시를 누르면 채팅 입력창에 그대로 들어갑니다. |
| PWA 백그라운드 푸시 | 첫 기동 시 VAPID 키를 `data/vapid.json`에 자동 생성합니다(환경변수 불필요). 앱을 보고 있을 때는 알림을 띄우지 않는 이중 가드(서버 presence + 서비스워커 clients.matchAll)를 쓰고, 답변 완료·핸드오버·예약/워치 알림을 보냅니다. 설정에서 켜고 테스트할 수 있습니다. |
| 예약 쉬운 시간 설정 | 크론 문법 없이 매일/평일/매주(요일)/N분·N시간마다를 고르고, 기존 크론 입력은 「고급」으로 접습니다. |

브라우저 기능까지 켜려면:

```bash
docker compose --profile browser up -d --build
```

> 브라우저 이미지는 약 1.2GB이며, 워커는 유휴 시 크로미움을 띄우지 않습니다(≈60MB).
> 브라우저가 붙어 있는 동안 ≈300MB를 쓰므로 **1GB 서버에서는 동시 1세션**을 권장합니다
> (`mem_limit: 640m`, `shm_size: 256m` 기본값).

## v0.3.1에 들어있는 것

| 기능 | 내용 |
| --- | --- |
| iOS 키보드 | `interactive-widget=resizes-content`로 레이아웃 뷰포트까지 줄어드는 환경에서도 키보드 상태(`kb-open`)를 잡아 하단 탭바를 숨기고, 채팅 스크롤이 최신 메시지에 붙도록 보정 |
| 존댓말 강제 | `tone: polite`일 때 프롬프트 본문까지 존댓말로 쓰고 맨 앞·맨 뒤에 강제 규칙과 예시를 넣어 반말이 섞이던 문제 수정 |
| 생각 중 캐릭터 6종 재제작 | 기본(`idle`) 이미지를 베이스로 눈 모양을 유지한 채 다시 생성, 팔은 정확히 2개 |
| 이미지 캐시 | 서비스워커 v0.3.1 + `?v=0.3.1` 쿼리, `/mascots/*.png`는 `immutable` 대신 재검증 |

## v0.3.0에 들어있는 것

| 기능 | 내용 |
| --- | --- |
| 날씨 도구 (`weather_get`) | API 키 없이 Open-Meteo로 현재 날씨·기온·습도·바람과 최대 7일 예보를 조회. "강원도 인제", "서울", "익산", "Tokyo" 같은 지명을 인식(한국 시·군 159곳 좌표 내장) |
| AI 말투 설정 | 존댓말 / 편한 반말 중 선택, 설정 화면에 말투별 대화 예시를 함께 표시. 고른 말투가 시스템 프롬프트에 그대로 반영 |
| 닉네임 호칭 | 설정에 저장한 닉네임을 AI가 기억하고 그 이름으로 부름 (비어 있으면 기본 호칭) |
| 도구 목록 (더보기) | AI가 쓸 수 있는 도구와 기능·사용 예시를 앱에서 바로 확인 (`/api/tools`) |
| 생각 중 캐릭터 6종 | 6종 캐릭터의 `thinking` 표정을 정면·고민 포즈로 새로 제작(투명 PNG) |
| 채팅 안정화 | AI 응답 후 내 메시지가 사라지던 버그 수정 — 서버가 저장한 내 메시지를 함께 반환 |
| iOS 키보드 | 키보드가 올라올 때 화면이 밀려 흰 공백이 남던 현상 수정 (`visualViewport` 높이·오프셋 보정) |
| 금고 카드 | 아이디 행의 중복 복사 버튼 정리 (라벨은 배지, 복사 버튼은 하나) |

## v0.2.0에 들어있는 것

| 기능 | 내용 |
| --- | --- |
| 4단계 온보딩 마법사 (`/setup`) | 1회용 설정 토큰 검증 → 관리자 계정 → AI Provider·키 연결 테스트 → 닉네임/캐릭터/테마/언어 → 완료 시 `/setup` 영구 잠금(410) |
| 메인 채팅 | 연결한 API 키로 실제 대화. 서버 상태·할 일을 실시간 컨텍스트로 전달하고, 도구 호출로 할 일·금고·서버 상태를 직접 확인·추가 |
| 모델 선택 바 | 입력창 위에서 Gemini(3.8/3.7/3.6/3.5 Flash, 3.1 Flash Lite)·Claude·GPT를 즉시 전환. 선택은 서버에 저장돼 다음 요청부터 반영 |
| AI 캐릭터 | 6종 마스코트(포딩·피몽·라몽·퐁이·멜로·민티) 중 선택, AI 이름 변경. 상단바에 캐릭터·이름·AI 상태(대기/생각/작업/응답/오류)와 상태별 표정 표시 |
| 서버 관제실 (Monitor) | 호스트 CPU·RAM·Disk 실측, 원형 게이지 / 콤팩트 바 / 상세 그래프 3단 전환, 추이(최소·평균·최대), 시스템 상세, 상위 프로세스·시스템 로그 |
| 금고 (Vault) | AES-256-GCM 암호화, PIN 잠금·자동 잠금, 검색·마스킹·항목별 복사(ID/비밀번호)·수정 |
| 할 일 (Tasks) | 우선순위(높음/보통/낮음)·마감 일시·메모·필터·인라인 수정, 기한 지남 표시. 채팅에서 자연어로 조회·추가·완료 |
| 모바일 | iOS Safari/PWA 키보드 대응(하단 탭 숨김·상단바 고정·visualViewport 오프셋 보정·입력창을 키보드 위에 배치), 탭을 옮겨도 응답 수신 유지 |
| UI | React + Tailwind, `Spoqa Han Sans Neo`, `#FBFBFD` 라이트 테마, 포몽 5색 파스텔, PC 사이드바 / 모바일 4탭 · iOS PWA |

## 빠른 시작 (Docker)

```bash
git clone https://github.com/pomong-labs/pomong-agent.git
cd pomong-agent
cp .env.example .env      # optional — 기본값으로도 동작합니다
docker compose up -d --build
```

기동 후 **1회용 설정 주소**를 확인합니다.

```bash
docker compose logs pomong-agent | grep -o 'http://[^ ]*setup?token=[A-Za-z0-9_-]*'
```

그 주소를 브라우저에서 열고 4단계를 마치면 `/setup`은 잠기고, 이후에는 `/login`으로 접속합니다.
기본 포트는 `127.0.0.1:3100`(루프백)입니다. nginx 등으로 80/443에 붙이세요.

```nginx
server {
    listen 80;
    server_name agent.example.com;

    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:3100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

HTTPS는 `certbot --nginx -d agent.example.com`로 마무리합니다.

### 직접 실행 (개발)

```bash
npm install
npm run build          # 프론트엔드(dist) + 서버(server-dist)
PORT=3100 npm start    # http://localhost:3100/setup?token=...
```

개발 모드: `npm run dev` (Vite, 5173) + `npm run dev:server` (API, 3100).

## 구조

```
src/            React + TypeScript + Tailwind UI (Setup · Chat · Monitor · Vault · Tasks · Automation · Browser · Settings)
server/         Express + TypeScript API, SQLite(better-sqlite3), AES-256-GCM 금고, 시스템 샘플러
server/system.ts  /proc 기반 CPU·RAM·Disk·프로세스 수집기
server/jobs.ts    예약 실행 스케줄러 (croner, job_runs 기록, 따라잡기·겹침 정책)
server/watchers.ts 웹 변화 감시 (cheerio 추출, 해시 비교, diff·백오프)
server/browser.ts 자율 브라우저 세션·핸드오버·입력 브리지 (playwright-core)
server/policy.ts  도메인 정책·결제 하드블록·프롬프트 인젝션 감지
docker/Dockerfile.browser  브라우저 워커 이미지 (Playwright run-server)
public/mascots/   포몽 6종 마스코트 (앱 렌더링용)
brand/            마스코트 원본 시트 · 에셋 라이선스
scripts/          install.sh 등 운영 스크립트
```

데이터는 모두 `./data` 하나에 모입니다.

```
data/pomong-agent.db   SQLite (설정·대화·금고 암호문·할 일·로그)
data/setup-token.txt   1회용 설정 토큰 (설정 완료 시 자동 삭제)
data/.server_key       API 키 암호화 키
data/.session_key      세션 서명 키
data/.vault_key...     금고 마스터 키 (PIN으로 감싼 형태)
```

**`./data`만 백업하면 전체 상태가 복구됩니다.** 이 폴더는 절대 커밋하지 마세요.

## 보안 요약

- 비밀번호: `scrypt` 해시 (평문 저장 없음)
- API 키: AES-256-GCM, 서버 로컬 키로 암호화
- 금고: PIN → scrypt → 키 유도, 마스터 키는 PIN으로 감싸 보관, 10분 자동 잠금
- 세션: HMAC 서명 쿠키 (HttpOnly · SameSite=Lax · HTTPS에서 Secure)
- `/setup`은 1회용 토큰 + 완료 후 410 잠금, 로그인 8회 실패 시 15분 차단
- 외부 전송은 **선택한 LLM 제공자 API 호출 외에 없습니다** (텔레메트리 없음)

자세한 내용과 신고 절차는 [SECURITY.md](SECURITY.md)를 봐 주세요.

## 라이선스

- 코드: [MIT](LICENSE)
- 마스코트·로고 등 브랜드 에셋: [brand/LICENSE-assets.md](brand/LICENSE-assets.md) — 앱과 함께 쓰는 것은 자유, **에셋만 따로 떼어 상업적으로 재사용하는 것은 금지**합니다.

## 만든 사람

Pomong Labs (포몽랩스) — 1인 사업자 팀. 대표 김현준, 그리고 하늘·겨울·여름 세 AI 에이전트의 협업으로 만들어집니다.

> Phase 2에서 자율 도구 루프·외부 커넥터·스케줄러가, Phase 3에서 WebRTC 음성과 스킬 플러그인이 붙습니다.
