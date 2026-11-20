/**
 * v0.6.6 스모크 테스트
 *
 *   npx tsx scripts/smoke-v065.ts
 *
 * 외부 네트워크 없이 확인한다.
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw.js ↔ 에셋 버전)
 *   2) 설정 카테고리 바 sticky(틈·배경) 수정
 *   3) 글꼴 체크 유지(서버 저장 + 이 기기 값 → 화면)
 *   4) 채팅 상단바 플로팅 개편(시안: 유리 버튼·큰 아바타·여백·상태 점)
 *   5) 상태 배지 전환 애니메이션
 *   6) 첨부 내용 분석 — PDF 본문 추출·캐시, 이미지 inline, 텍스트 본문, 스캔본 PDF 원본 전달
 *   7) 보낸 뒤 입력창 높이 원복
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v065-'));
process.env.DATA_DIR = tmp;
process.env.BROWSER_ENABLED = '0';
process.env.MONITOR_ENABLED = '0';
process.env.HOST_LOG_DIR = path.join(tmp, 'hostlog');
process.env.DOCKER_SOCKET = path.join(tmp, 'no-docker.sock');

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** 글자가 들어 있는(압축 스트림) 아주 작은 PDF — 내장 추출기 폴백 경로 검사용 */
function makeTextPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

/** 그림만 있고 글자가 없는(스캔본 같은) PDF */
function makeScanPdf(): Buffer {
  const content = 'q 612 0 0 792 0 0 cm /Im0 Do Q\n';
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'));
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
  ]);
}

/** 1x1 투명 PNG */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function main(): Promise<void> {
  const { APP_VERSION } = await import('../server/config');
  const attachments = await import('../server/attachments');
  const { ASSET_VERSION } = await import('../src/lib/version');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('docker-compose 이미지 태그', compose.includes(`pomong-agent:${pkg.version}`) && compose.includes(`pomong-agent-browser:${pkg.version}`));
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check('에셋 캐시 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);

  /* 2) 설정 카테고리 바 — v0.6.6에서 스크롤 밖 고정 헤더로 변경 ---------- */
  const settings = read('src/pages/Settings.tsx');
  check('카테고리 바가 스크롤 밖 고정 헤더', settings.includes('flex h-full min-h-0 flex-col') && settings.includes('shrink-0 px-4'));
  check('sticky 방식 제거(v0.6.6)', !settings.includes('sticky top-0 z-20'));
  check('카드 뒤에 비칠 수 없는 구조', settings.includes('pa-scroll mt-3 min-h-0 flex-1 overflow-y-auto'));
  check('예전 반투명(88%) 제거', !settings.includes('var(--pa-surface) 88%'));

  /* 3) 글꼴 체크 유지 ----------------------------------------------------- */
  const serverIndex = read('server/index.ts');
  const profileRoute = serverIndex.slice(
    serverIndex.indexOf("app.put('/api/settings/profile'"),
    serverIndex.indexOf("app.put('/api/settings/profile'") + 1600
  );
  check('프로필 저장 라우트가 font를 저장한다', profileRoute.includes('font: normalizeFont(body.font, current.font)'));
  check('글꼴 초기값은 이 기기 값', settings.includes('useState<FontId>(() => readStoredFont())'));
  check('글꼴 불러오기 fallback', settings.includes("r.profile.font === 'default' ? readStoredFont() : r.profile.font"));
  const store = read('src/lib/store.tsx');
  check('store가 이 기기 글꼴을 지키고 서버에 맞춘다', store.includes("profile.font === 'default' && stored !== 'default'"));
  check('store가 글꼴을 서버에 한 번 올린다', store.includes("api.put('/api/settings/profile', { font: next })"));

  /* 4) 플로팅 상단바 ------------------------------------------------------ */
  const header = read('src/components/AppHeader.tsx');
  const chat = read('src/pages/Chat.tsx');
  const css = read('src/index.css');
  check('상단바가 겹쳐 뜨는 오버레이', header.includes('pointer-events-none absolute inset-x-0 top-0 z-30'));
  // v0.6.7: 페이드 시작색은 본문 표면색(--pa-surface). --pa-top 과 같은 값이라 경계가 없다.
  check('상단 페이드 그라데이션', header.includes('linear-gradient(to bottom, var(--pa-surface) 0px'));
  check('불투명 박스·하단 경계선 제거', !header.includes('border-b border-[#F4F2FA]') && !header.includes('bg-[#FCFCFE]/95'));
  check('좌우 버튼은 유리(pa-glass)', header.includes('pa-glass') && css.includes('.pa-glass'));
  check('유리 캡슐 안 구분선', header.includes("background: 'var(--pa-line)'") && header.includes('h-3.5 w-px'));
  check('캐릭터 아바타(48px · v0.6.6 축소)', header.includes('const avatar = compact ? 34 : 48'));
  check('은은한 원형 링', header.includes('--pa-line) 45%') && header.includes('radial-gradient('));
  check('우측 하단 상태 점', header.includes('boxShadow: \'0 0 0 2.5px var(--pa-surface)\''));
  // v0.6.10: 이름과 배지를 하나의 유리 캡슐(mt-1.5)로 묶어 간격을 조였다.
  check('아이콘·이름 사이 간격 축소', header.includes('mt-1.5 px-3 py-1') && header.includes('text-[15px]'));
  check('채팅 리스트 상단 여백 확보', chat.includes('HEADER_SPACE.normal') && chat.includes('HEADER_SPACE.compact'));

  /* 5) 배지 전환 애니메이션 ----------------------------------------------- */
  // v0.6.11: 300ms → 550ms(cubic-bezier(0.22,1,0.36,1)) 로 길어졌다. 전환 자체가 있는지만 본다.
  check('배지 라벨 크로스페이드 전환', /transition-all duration-(300|\[550ms\])/.test(header));
  check('배지 글자 크로스페이드(같은 칸 겹침)', header.includes('col-start-1 row-start-1') && header.includes('opacity-100'));
  check('모든 상태 라벨을 겹쳐 둔다', header.includes("const STATE_ORDER: AgentState[] = ['idle', 'thinking', 'working', 'responding', 'error']"));
  check('점 색도 부드럽게', /transition-colors duration-(300|\[550ms\])/.test(header));

  /* 6) 첨부 내용 분석 ----------------------------------------------------- */
  const attachmentsSrc = read('server/attachments.ts');
  check('pdftotext 사용(경량 추출)', attachmentsSrc.includes("spawnSync('pdftotext'") && attachmentsSrc.includes("execFile("));
  check('Docker 런타임에 poppler-utils', read('Dockerfile').includes('poppler-utils'));
  check('한글 PDF용 poppler-data(CMap) 포함', read('Dockerfile').includes('poppler-data'));
  check('PDF 본문 캐시 컬럼', read('server/db.ts').includes("ALTER TABLE chat_attachments ADD COLUMN text_content TEXT"));
  check('스캔본 PDF 원본 전달(inlinePdf)', attachmentsSrc.includes('export function inlinePdf') && attachmentsSrc.includes("mime: 'application/pdf'"));
  check('프롬프트에 문서 파트', serverIndex.includes("type: 'pdf' as const"));
  const providers = read('server/providers.ts');
  check('AgentPart에 pdf 종류', providers.includes("| { type: 'pdf'; mime: string; dataBase64: string }"));
  check('Claude document 블록', providers.includes("type: 'document'") && providers.includes("media_type: 'application/pdf'"));
  check('Gemini inlineData 경로', providers.includes('inlineData: { mimeType: part.mime, data: part.dataBase64 }'));
  check('텍스트·PDF는 본문을 프롬프트로', attachmentsSrc.includes('lines.push(content)'));
  check('시스템 프롬프트가 PDF 본문 안내', serverIndex.includes('PDF·텍스트 파일은 서버가 뽑은 본문이 [첨부] 블록에'));

  /* 실제 파이프라인 검증 */
  const textPdf = attachments.saveUpload({
    sessionId: 'default',
    filename: '대출계약서.pdf',
    mime: 'application/pdf',
    data: makeTextPdf(
      `Loan agreement sample text 2026 interest 19.9 percent monthly payment schedule. ${'Repayment clause detail without any special characters. '.repeat(8)}`
    ),
  });
  check('PDF 첨부 저장', textPdf.kind === 'pdf', textPdf.kind);
  const pdfRow = attachments.getRow(textPdf.id);
  const pdfBody = attachments.readTextContent(pdfRow!);
  check('PDF 본문을 읽어 낸다', Boolean(pdfBody && pdfBody.includes('Loan agreement')), (pdfBody || '').slice(0, 40));
  check('PDF 본문이 DB에 캐시된다', Boolean(attachments.getRow(textPdf.id)?.text_content));
  const pdfBlock = attachments.buildPromptBlock([textPdf.id], { pdfFiles: true });
  check('PDF 본문이 프롬프트 블록에 들어간다', pdfBlock.text.includes('<file>') && pdfBlock.text.includes('Loan agreement'));
  check('본문이 있는 PDF는 원본을 또 보내지 않는다', pdfBlock.documents.length === 0);

  const shortPdf = attachments.saveUpload({
    sessionId: 'default',
    filename: '짧은쪽지.pdf',
    mime: 'application/pdf',
    data: makeTextPdf('Only a few words'),
  });
  const shortBlock = attachments.buildPromptBlock([shortPdf.id], { pdfFiles: true });
  check('본문이 거의 없는 PDF는 원본도 함께 보낸다', shortBlock.documents.length === 1);

  const scanPdf = attachments.saveUpload({
    sessionId: 'default',
    filename: '스캔계약서.pdf',
    mime: 'application/pdf',
    data: makeScanPdf(),
  });
  check('스캔본 PDF 본문 없음', attachments.readTextContent(attachments.getRow(scanPdf.id)!) === null);
  const scanBlock = attachments.buildPromptBlock([scanPdf.id], { pdfFiles: true });
  check('스캔본은 PDF 원본을 함께 넘긴다', scanBlock.documents.length === 1 && scanBlock.documents[0].mime === 'application/pdf');
  check('스캔본 안내 문구', scanBlock.text.includes('원본'));
  const scanNoModel = attachments.buildPromptBlock([scanPdf.id], { pdfFiles: false });
  check('볼 수 없는 모델에는 원본을 보내지 않는다', scanNoModel.documents.length === 0);

  const txt = attachments.saveUpload({
    sessionId: 'default',
    filename: '메모.txt',
    mime: 'text/plain',
    data: Buffer.from('회의 메모\n- 대출 상환일: 12월 1일\n- 연락처: 010-0000-0000\n', 'utf8'),
  });
  const txtBlock = attachments.buildPromptBlock([txt.id]);
  check('텍스트 파일 본문 전달', txtBlock.text.includes('대출 상환일') && txtBlock.text.includes('<file>'));

  const png = attachments.saveUpload({ sessionId: 'default', filename: '영수증.png', mime: 'image/png', data: PNG_1PX });
  const pngBlock = attachments.buildPromptBlock([png.id], { pdfFiles: true });
  check('이미지는 실제 바이트(inline)로 전달', pngBlock.images.length === 1 && pngBlock.images[0].mime === 'image/png');
  check('이미지 base64가 비어 있지 않다', pngBlock.images[0].dataBase64.length > 20);

  /* 7) 입력창 높이 원복 --------------------------------------------------- */
  check('textarea ref 연결', chat.includes('ref={textareaRef}'));
  check('전송 후 높이 초기화', chat.includes('resetComposerHeight();') && chat.includes("el.style.height = 'auto'"));
  check('빈 입력이면 높이 원복', chat.includes("if (draft === '') resetComposerHeight();"));

  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
