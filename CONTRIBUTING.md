# Contributing to Pomong Agent

포몽 에이전트에 관심 가져 주셔서 고마워요! 작은 수정도 환영합니다.

## 개발 환경

```bash
git clone https://github.com/pomong-labs/pomong-agent.git
cd pomong-agent
npm install
npm run dev        # 프론트엔드 (Vite, http://localhost:5173)
npm run dev:server # API 서버 (http://localhost:3100)
```

`npm run dev`만 쓰면 `/api` 요청은 3100으로 프록시됩니다. 서버를 따로 띄우지 않으면
로그인·채팅이 동작하지 않으니 두 명령을 함께 실행해 주세요.

## 보내기 전에 (필수)

```bash
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.server.json
npm run build
```

세 명령이 모두 통과해야 합니다. 타입 오류나 빌드 실패가 있는 PR은 리뷰하지 않습니다.

## 규칙

- **시크릿 금지**: 실제 API 키, 서버 IP, 도메인, 토큰을 코드·커밋·스크린샷에 넣지 마세요. `.env.example`만 수정합니다.
- **`data/` 금지**: 런타임 데이터(DB·키·설정 토큰)는 커밋하지 않습니다.
- **브랜드 에셋**: [brand/LICENSE-assets.md](brand/LICENSE-assets.md)를 지켜 주세요.
- **UI**: `#FBFBFD` 라이트 배경, 포몽 파스텔 5색(`#FFB7CA` `#D2B4FF` `#BBE6FF` `#FFDFB3` `#BCF4DE`), 둥근 모서리(20~30px)와 부드러운 그림자를 유지해 주세요.
- **한국어 우선**: UI 문구는 한국어를 기본으로 하고, 필요하면 영어를 병기합니다.

## 커밋 & PR

- 커밋 메시지: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:` 접두사를 사용합니다.
- PR에는 무엇을·왜 바꿨는지, 어떻게 확인했는지(스크린샷 환영)를 적어 주세요.
- 하나의 PR에는 하나의 주제만 담아 주세요.

## 새 기능을 제안할 때

Phase 로드맵(코어 두뇌 → 생활 연동·스케줄러 → 음성·플러그인)에 맞는지 먼저 확인해 주세요.
큰 변경은 이슈로 먼저 논의하면 좋습니다.

## 행동 강령

서로 존중해 주세요. 괴롭힘, 차별, 개인정보 침해는 어떤 이유로도 받아들이지 않습니다.
