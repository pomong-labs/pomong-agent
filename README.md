# 🫧 Pomong Agent

**내 서버에 한 줄로 띄우는 개인 AI 비서 OS.**
BYOK 멀티 LLM · 서버 관제 · 암호화 금고 · 완전한 셀프호스팅.

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
src/            React + TypeScript + Tailwind UI (Setup · Chat · Monitor · Vault · Tasks · Settings)
server/         Express + TypeScript API, SQLite(better-sqlite3), AES-256-GCM 금고, 시스템 샘플러
server/system.ts  /proc 기반 CPU·RAM·Disk·프로세스 수집기
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
