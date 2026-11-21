/**
 * v0.6.16 스모크 테스트
 *
 *   npx tsx scripts/smoke-v0616.ts
 *
 * 택배 조회·택배 변동 추적 · 환율/주식/코인 시세 · D-Day · 도커 관리(포몽 보호) 검증.
 * 외부 네트워크 없이 돈다 — 택배 조회는 로컬 가짜 서버, 시세는 fetch 대역으로 확인한다.
 *
 *   1) 버전(server/config ↔ package.json ↔ docker-compose ↔ sw ↔ asset ↔ More/Settings)
 *   2) 도구 등록 — track_parcel·watch_parcel·get_market_quote·dday_*·manage_docker
 *   3) 의도 감지 — 택배/시세/디데이/도커 요청에 그룹이 붙는지
 *   4) 택배 — 택배사 해석 · 번호 정규화 · 기사님 연락처 가리기 · 조회 결과 문구
 *   5) 택배 추적 — 등록/목록/중복/중지 · 단계 변동에만 알림 · 배송완료 자동 종료
 *   6) 시세 — 환율(전일 대비)·국내주식·해외주식·코인 해석과 표시
 *   7) D-Day — 날짜 정규화 · 남은 일수 · 매년 반복 넘김 · 등록/조회/삭제
 *   8) 도커 — 포몽 자기 컨테이너 보호 · 삭제/정리 차단 · 소켓 없음 안내
 *   9) 회귀 — poppler, PWA 메타, 개인정보 0건, compose 소켓 마운트
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pomong-smoke-v0616-'));
process.env.DATA_DIR = tmp;
process.env.BROWSER_ENABLED = '0';
process.env.MONITOR_ENABLED = '0';
process.env.HOST_LOG_DIR = path.join(tmp, 'hostlog');
process.env.DOCKER_SOCKET = path.join(tmp, 'no-docker.sock');

const ROOT = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const originalFetch = globalThis.fetch;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'server-dist') continue;
    if (entry.name === 'data' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ---------------------------- 가짜 택배 API ---------------------------- */

interface TrackStage {
  stateId: string;
  stateText: string;
  location: string;
  time: string;
  description: string;
}

let trackStage: TrackStage = {
  stateId: 'in_transit',
  stateText: '간선하차',
  location: '대전HUB',
  time: '2026-11-20T18:20:00+09:00',
  description: '배송지역으로 상품이 이동중입니다.',
};
let trackCalls = 0;

function trackerPayload(): unknown {
  return {
    carrier: { id: 'kr.cjlogistics', name: 'CJ Logistics' },
    from: { name: null, time: '2026-11-19T10:00:00+09:00' },
    to: { name: null, time: null },
    progresses: [
      {
        time: '2026-11-19T10:00:00+09:00',
        status: { id: 'at_pickup', text: '집화처리' },
        location: { name: '대전동부' },
        description: '보내시는 고객님으로부터 상품을 인수받았습니다',
      },
      {
        time: trackStage.time,
        status: { id: trackStage.stateId, text: trackStage.stateText },
        location: { name: trackStage.location },
        description: trackStage.description,
      },
    ],
    state: { id: trackStage.stateId, text: trackStage.stateText },
  };
}

function startMockParcelServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      trackCalls += 1;
      const url = req.url || '';
      const match = /^\/carriers\/([^/]+)\/tracks\/([^/?]+)/.exec(url);
      if (!match) {
        res.writeHead(400).end('bad request');
        return;
      }
      const number = decodeURIComponent(match[2]);
      if (number === '0000000000') {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'tracking number not found.' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(trackerPayload()));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      process.env.PARCEL_API_BASE = `http://127.0.0.1:${port}`;
      resolve({ server, port });
    });
  });
}

/* ---------------------------- 시세 fetch 대역 ---------------------------- */

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function installMarketFixture(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url);
    if (url.includes('api.frankfurter.app')) {
      const quote = /to=([A-Z]{3})/.exec(url)?.[1] || 'KRW';
      const values = quote === 'JPY' ? { '2026-11-19': 157.9, '2026-11-20': 158.64 } : { '2026-11-19': 1328.45, '2026-11-20': 1339.44 };
      return jsonResponse({ amount: 1, base: 'USD', rates: Object.fromEntries(Object.entries(values).map(([date, v]) => [date, { [quote]: v }])) });
    }
    if (url.includes('open.er-api.com')) {
      return jsonResponse({ result: 'success', rates: { USD: 1, KRW: 1330.97, JPY: 159.75 }, time_last_update_utc: 'Fri, 20 Nov 2026 00:02:32 +0000' });
    }
    if (url.includes('api.upbit.com/v1/market/all')) {
      return jsonResponse([
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
      ]);
    }
    if (url.includes('api.upbit.com/v1/ticker')) {
      return jsonResponse([
        {
          market: 'KRW-BTC',
          trade_price: 81034000,
          prev_closing_price: 81134000,
          trade_date_kst: '20261121',
          trade_time_kst: '100231',
        },
      ]);
    }
    if (url.includes('finance.yahoo.com')) {
      const symbol = decodeURIComponent(/chart\/([^?]+)/.exec(url)?.[1] || '');
      if (symbol === '005930.KS') {
        return jsonResponse({
          chart: {
            result: [
              {
                meta: {
                  symbol: '005930.KS',
                  currency: 'KRW',
                  regularMarketPrice: 183100,
                  chartPreviousClose: 196900,
                  regularMarketTime: 1795156205,
                  shortName: 'SamsungElec',
                  exchangeName: 'KSC',
                },
              },
            ],
          },
        });
      }
      if (symbol === 'AAPL') {
        return jsonResponse({
          chart: {
            result: [
              {
                meta: {
                  symbol: 'AAPL',
                  currency: 'USD',
                  regularMarketPrice: 342.56,
                  chartPreviousClose: 349.21,
                  regularMarketTime: 1795208402,
                  shortName: 'Apple Inc.',
                  exchangeName: 'NMS',
                },
              },
            ],
          },
        });
      }
      return jsonResponse({ chart: { result: null, error: { code: 'Not Found' } } });
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

async function main(): Promise<void> {
  const mock = await startMockParcelServer();
  const { APP_VERSION } = await import('../server/config');
  const { ASSET_VERSION } = await import('../src/lib/version');
  const { db } = await import('../server/db');
  const parcel = await import('../server/parcel');
  const parcelWatch = await import('../server/parcel-watch');
  const market = await import('../server/market');
  const ddays = await import('../server/ddays');
  const docker = await import('../server/docker');
  const tools = await import('../server/tools');
  const filter = await import('../server/tool-filter');

  /* 1) 버전 --------------------------------------------------------------- */
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const compose = read('docker-compose.yml');
  // v0.6.17 이후: 버전 표기가 한 값으로 모여 있는지만 본다.
  // v0.7.0: 0.6 이상이면 통과(이후 릴리스에서도 회귀 확인용으로 계속 돈다).
  check('버전 0.6.x 이상', Number(pkg.version.split('.')[0]) > 0 || Number(pkg.version.split('.')[1] || 0) >= 6, pkg.version);
  check('server/config 버전', APP_VERSION === pkg.version, APP_VERSION);
  check('에셋 버전', ASSET_VERSION === pkg.version, ASSET_VERSION);
  check(
    'docker-compose 이미지 태그',
    compose.includes(`image: pomong-agent:${pkg.version}`) && compose.includes(`image: pomong-agent-browser:${pkg.version}`)
  );
  check('서비스 워커 캐시 버전', read('public/sw.js').includes(`pomong-agent-v${pkg.version}`));
  check(
    'More·Settings 표시 버전',
    read('src/pages/More.tsx').includes(`useState('${pkg.version}')`) && read('src/pages/Settings.tsx').includes(`|| '${pkg.version}'`)
  );
  check(
    '도커 소켓 쓰기 마운트(:ro 제거)',
    compose.includes('/var/run/docker.sock:/var/run/docker.sock') && !compose.includes('/var/run/docker.sock:/var/run/docker.sock:ro')
  );

  /* 2) 도구 등록 ----------------------------------------------------------- */
  const names = tools.TOOL_SPECS.map((spec) => spec.name);
  const newTools = ['track_parcel', 'watch_parcel', 'get_market_quote', 'dday_list', 'dday_add', 'dday_delete', 'manage_docker'];
  for (const name of newTools) {
    const spec = tools.TOOL_SPECS.find((item) => item.name === name);
    check(`도구 스펙 ${name}`, Boolean(spec) && spec!.description.length > 40, spec ? `${spec.description.length}자` : '없음');
    const entry = tools.TOOL_CATALOG.find((item) => item.name === name);
    check(`도구 카탈로그 ${name}`, Boolean(entry?.label && entry?.summary), entry?.label || '없음');
    check(`도구 이름표 ${name}`, Boolean(tools.TOOL_LABELS[name]), tools.TOOL_LABELS[name] || '없음');
  }
  check(
    'manage_docker 인자(동작·컨테이너·줄 수)',
    (() => {
      const params = JSON.stringify(tools.TOOL_SPECS.find((item) => item.name === 'manage_docker')?.parameters);
      return params.includes('"ps"') && params.includes('"restart"') && params.includes('container') && params.includes('tail');
    })()
  );
  check(
    'watch_parcel 인자(add·list·remove)',
    (() => {
      const params = JSON.stringify(tools.TOOL_SPECS.find((item) => item.name === 'watch_parcel')?.parameters);
      return params.includes('"add"') && params.includes('"list"') && params.includes('"remove"') && params.includes('interval_min');
    })()
  );
  for (const group of ['parcel', 'market', 'dday', 'docker'] as const) {
    check(`도구 그룹 ${group}`, filter.TOOL_GROUP_META.some((meta) => meta.id === group) && filter.TOOL_GROUPS[group].length > 0);
  }
  const groupTools = Object.values(filter.TOOL_GROUPS).flat();
  const missing = groupTools.filter((name) => !names.includes(name));
  check('그룹 도구 이름이 모두 실제 스펙에 존재', missing.length === 0, missing.join(', '));
  check(
    'manage_docker 설명에 보호장치 명시',
    /포몽 에이전트 자신의 컨테이너/.test(tools.TOOL_SPECS.find((item) => item.name === 'manage_docker')?.description || '') &&
      /명시적으로 부탁했을 때만/.test(tools.TOOL_SPECS.find((item) => item.name === 'manage_docker')?.description || '')
  );

  /* 3) 의도 감지 ----------------------------------------------------------- */
  const pick = (text: string) => filter.selectToolNames({ userRequest: text }).tools;
  const has = (list: string[] | null, name: string) => Boolean(list && list.includes(name));
  check('택배 조회 의도 → track_parcel', has(pick('내 택배 어디쯤인지 조회해줘'), 'track_parcel'));
  check('택배 도착 알림 의도 → watch_parcel', has(pick('택배 도착하면 알려줘'), 'watch_parcel'));
  check('환율 의도 → get_market_quote', has(pick('달러 환율 얼마야'), 'get_market_quote'));
  check('주가 의도 → get_market_quote', has(pick('삼성전자 주가 알려줘'), 'get_market_quote'));
  check('코인 의도 → get_market_quote', has(pick('비트코인 시세 어때'), 'get_market_quote'));
  check('디데이 의도 → dday_list', has(pick('디데이 뭐 있어'), 'dday_list'));
  check('도커 의도 → manage_docker', has(pick('도커 컨테이너 목록 보여줘'), 'manage_docker'));
  check('일상 대화는 전체 허용(기능 축소 없음)', pick('오늘 기분 어때') === null);

  /* 4) 택배 ---------------------------------------------------------------- */
  check('택배사 이름 CJ', parcel.findCarrierByName('CJ대한통운')?.id === 'kr.cjlogistics');
  check('택배사 이름 cj(영문)', parcel.findCarrierByName('cj')?.id === 'kr.cjlogistics');
  check('택배사 이름 우체국', parcel.findCarrierByName('우체국택배')?.id === 'kr.epost');
  check('택배사 이름 로젠', parcel.findCarrierByName('로젠')?.id === 'kr.logen');
  check('없는 택배사는 null', parcel.findCarrierByName('없는택배사') === null);
  check('송장 정규화(하이픈 제거)', parcel.normalizeTrackingNumber('1234-5678-9012') === '123456789012');
  check(
    '기사님 연락처 가리기',
    parcel.maskPersonal('배송담당:홍길동 010-1234-5678') === '배송담당 기사님 010-****-****',
    parcel.maskPersonal('배송담당:홍길동 010-1234-5678')
  );
  const direct = await parcel.lookupParcel({ number: '1234-5678-9012', carrier: 'CJ대한통운' });
  check('송장 조회 성공', direct.ok && direct.events.length === 2, direct.ok ? `${direct.carrierLabel} ${direct.stateId}` : direct.reason);
  if (direct.ok) {
    check('조회 경로 표시', direct.source === 'delivery-tracker', direct.source);
    const text = parcel.formatParcel(direct, { events: 2 });
    check('조회 문구에 상태·이력', text.includes('CJ대한통운') && text.includes('배송 중') && text.includes('이동 이력'));
    check('조회 문구에 현재 위치', text.includes('대전HUB'), text.slice(0, 80));
  }
  const notFound = await parcel.lookupParcel({ number: '0000000000', carrier: 'CJ대한통운' });
  check('없는 송장은 사유 반환', !notFound.ok && notFound.notFound && notFound.reason.includes('조회 결과'), notFound.ok ? 'ok' : notFound.reason);
  const autoCarrier = await parcel.lookupParcel({ number: '1234567890123' });
  check('택배사 없이 자릿수로 자동 추정', autoCarrier.ok, autoCarrier.ok ? autoCarrier.carrierLabel : autoCarrier.reason);
  const shortNumber = await parcel.lookupParcel({ number: '123' });
  check('너무 짧은 송장은 거부', !shortNumber.ok && shortNumber.reason.includes('짧'), shortNumber.ok ? 'ok' : shortNumber.reason);

  /* 5) 택배 추적 ----------------------------------------------------------- */
  const notices: { kind: string; label: string }[] = [];
  parcelWatch.setParcelNotifier((notice) => notices.push({ kind: notice.kind, label: notice.watch.label }));

  const seeded = await parcel.lookupParcel({ number: '1234567890', carrier: 'CJ대한통운' });
  if (!seeded.ok) throw new Error('기준 조회 실패');
  const created = parcelWatch.createParcelWatch({
    carrier: seeded.carrierId,
    trackingNumber: '1234567890',
    label: '무선 이어폰',
    intervalMin: 15,
    snapshot: seeded,
  });
  check('추적 등록', !('error' in created) && '무선 이어폰' === (created as parcelWatch.ParcelWatchView).label, 'error' in created ? created.error : '');
  const dup = parcelWatch.createParcelWatch({ carrier: seeded.carrierId, trackingNumber: '1234567890', label: '중복' });
  check('같은 송장 중복 등록 거부', 'error' in dup && dup.error.includes('이미'), 'error' in dup ? dup.error : '통과됨');
  check('추적 목록 1개', parcelWatch.listParcelWatches().length === 1);

  const before = trackCalls;
  const first = await parcelWatch.checkParcelWatchNow((created as parcelWatch.ParcelWatchView).id, 'schedule');
  check('같은 단계면 알림 없음', !first.changed && notices.length === 0, `호출 ${trackCalls - before}`);
  check('확인 주기 저장', (created as parcelWatch.ParcelWatchView).intervalMin === 15);

  trackStage = {
    stateId: 'out_for_delivery',
    stateText: '배송출발',
    location: '경남창원신촌',
    time: '2026-11-21T09:12:00+09:00',
    description: '배송할 예정입니다.(배송담당:홍길동 010-1234-5678)',
  };
  const changed = await parcelWatch.checkParcelWatchNow((created as parcelWatch.ParcelWatchView).id, 'schedule');
  check('단계 변동 감지', changed.changed && notices.length === 1, JSON.stringify(notices));
  check('알림 종류 changed', notices[0]?.kind === 'changed');
  check('알림에 별칭', notices[0]?.label === '무선 이어폰');
  check(
    '알림 문구에 기사님 연락처 없음',
    Boolean(changed.snapshot) && !/010-\d{4}-\d{4}/.test(parcel.parcelNoticeLine(changed.snapshot!)),
    changed.snapshot ? parcel.parcelNoticeLine(changed.snapshot) : ''
  );

  trackStage = {
    stateId: 'delivered',
    stateText: '배송완료',
    location: '경남창원신촌',
    time: '2026-11-21T10:40:00+09:00',
    description: '배송완료 되었습니다.',
  };
  const delivered = await parcelWatch.checkParcelWatchNow((created as parcelWatch.ParcelWatchView).id, 'schedule');
  check('배송 완료 감지', delivered.changed && notices.some((n) => n.kind === 'delivered'), JSON.stringify(notices));
  const afterDelivered = parcelWatch.listParcelWatches()[0];
  check('배송 완료 후 자동 종료', afterDelivered.enabled === false && afterDelivered.stateLabel?.includes('배송 완료'), String(afterDelivered.enabled));

  const stopped = parcelWatch.stopParcelWatch('무선');
  check('별칭으로 추적 중지', stopped.removed.length === 1 && parcelWatch.listParcelWatches().length === 0);
  const stopMissing = parcelWatch.stopParcelWatch('없는별칭');
  check('없는 추적 중지는 안내', Boolean(stopMissing.error));

  /* 6) 시세 ---------------------------------------------------------------- */
  installMarketFixture();
  check('환율 판별', market.detectQuoteKind('USD/KRW') === 'fx' && market.detectQuoteKind('달러') === 'fx');
  check('주식 판별', market.detectQuoteKind('삼성전자') === 'stock' && market.detectQuoteKind('AAPL') === 'stock');
  check('코인 판별', market.detectQuoteKind('BTC') === 'crypto' && market.detectQuoteKind('비트코인') === 'crypto');
  check('모르는 말은 null', market.detectQuoteKind('오늘 기분') === null);
  check('통화 코드 해석', market.currencyCode('엔화') === 'JPY' && market.currencyCode('달러') === 'USD');
  check('코인 별명 해석', market.cryptoHintSymbol('비트코인') === 'BTC');
  check('국내 종목 → 야후 심볼', market.resolveStockTargets('삼성전자')[0]?.symbol === '005930.KS');
  check('종목코드 → 야후 심볼', market.resolveStockTargets('005930')[1]?.symbol === '005930.KQ');
  check('지수 해석', market.resolveStockTargets('코스피')[0]?.symbol === '^KS11');
  check('금액 표기(원·환율)', market.formatMoney(1339.44, 'KRW', 'fx') === '1,339.44원', market.formatMoney(1339.44, 'KRW', 'fx'));
  check('금액 표기(원·주가)', market.formatMoney(183100, 'KRW') === '183,100원', market.formatMoney(183100, 'KRW'));
  check('금액 표기(달러)', market.formatMoney(342.56, 'USD') === '$342.56', market.formatMoney(342.56, 'USD'));

  const fx = await market.lookupQuotes('USD/KRW');
  check('환율 조회', fx.ok && fx.quotes[0]?.kind === 'fx', fx.ok ? `${fx.quotes[0].price}` : fx.reason);
  if (fx.ok) {
    check('환율 값', Math.abs(fx.quotes[0].price - 1339.44) < 0.01, String(fx.quotes[0].price));
    check('환율 전일 대비', Math.abs((fx.quotes[0].change || 0) - 10.99) < 0.01, String(fx.quotes[0].change));
    check('환율 문구', market.formatQuotes(fx).includes('USD/KRW 1 = 1,339.44원'), market.formatQuotes(fx).split('\n')[1] || '');
  }
  const krStock = await market.lookupQuotes('삼성전자');
  check('국내 주식 조회', krStock.ok && krStock.quotes[0]?.symbol === '005930.KS', krStock.ok ? krStock.quotes[0].symbol : krStock.reason);
  if (krStock.ok) {
    check('국내 주식 이름은 한글', krStock.quotes[0].name === '삼성전자', krStock.quotes[0].name);
    check('국내 주식은 원 단위', market.formatQuotes(krStock).includes('183,100원'), market.formatQuotes(krStock).split('\n')[1] || '');
    check('국내 주식 전일 대비', Math.abs((krStock.quotes[0].changePct || 0) + 7.0) < 0.05, String(krStock.quotes[0].changePct));
  }
  const usStock = await market.lookupQuotes('AAPL');
  check('해외 주식 조회', usStock.ok && usStock.quotes[0]?.currency === 'USD', usStock.ok ? usStock.quotes[0].symbol : usStock.reason);
  const coin = await market.lookupQuotes('비트코인');
  check('코인 조회', coin.ok && coin.quotes[0]?.symbol === 'BTC', coin.ok ? coin.quotes[0].name : coin.reason);
  if (coin.ok) check('코인 전일 대비', coin.quotes[0].change === -100000, String(coin.quotes[0].change));
  const multi = await market.lookupQuotes('USD/KRW, 삼성전자, BTC');
  check('쉼표로 여러 개', multi.ok && multi.quotes.length === 3, multi.ok ? String(multi.quotes.length) : multi.reason);
  const krwFirst = await market.lookupQuotes('원달러');
  check("'원달러'는 1달러 기준으로", krwFirst.ok && krwFirst.quotes[0]?.name === 'USD/KRW', krwFirst.ok ? krwFirst.quotes[0].name : krwFirst.reason);
  const unknown = await market.lookupQuotes('듣도보도못한것');
  check('모르는 대상은 안내', !unknown.ok && unknown.reason.length > 5, unknown.ok ? 'ok' : unknown.reason.slice(0, 40));
  globalThis.fetch = originalFetch;

  /* 7) D-Day --------------------------------------------------------------- */
  check('오늘(KST) 형식', /^\d{4}-\d{2}-\d{2}$/.test(ddays.todayKst()));
  check('날짜 정규화(점)', ddays.normalizeDateInput('2027.5.15') === '2027-05-15', String(ddays.normalizeDateInput('2027.5.15')));
  check('날짜 정규화(한글)', ddays.normalizeDateInput('2027년 5월 15일') === '2027-05-15');
  check('잘못된 날짜 거부', ddays.normalizeDateInput('2027-02-31') === null && ddays.normalizeDateInput('내일') === null);
  check('남은 일수 계산', ddays.daysUntil('2026-11-26', '2026-11-21') === 5, String(ddays.daysUntil('2026-11-26', '2026-11-21')));
  check('D-Day 표기', ddays.ddayLabel(0) === 'D-Day' && ddays.ddayLabel(14) === 'D-14' && ddays.ddayLabel(-3) === 'D+3');
  check('매년 반복(올해 남음)', ddays.nextOccurrence('2005-11-26', true, '2026-11-21') === '2026-11-26');
  check('매년 반복(올해 지남)', ddays.nextOccurrence('2005-11-20', true, '2026-11-21') === '2027-11-20');
  check('매년 반복(2월 29일 보정)', ddays.nextOccurrence('2004-02-29', true, '2026-01-05') === '2026-02-28');

  const dday1 = ddays.createDDay({ title: '전역', date: '2027-05-15' });
  check('D-Day 등록', dday1.ok && dday1.dday.title === '전역');
  check('D-Day 날짜 표기', dday1.ok && dday1.dday.dateLabel.includes('2027년 5월 15일'), dday1.ok ? dday1.dday.dateLabel : '');
  const dday2 = ddays.createDDay({ title: '생일', date: '2026-12-01', repeatYearly: true });
  check('매년 반복 등록', dday2.ok && dday2.dday.repeatYearly);
  const badDate = ddays.createDDay({ title: '테스트', date: '2027년 2월' });
  check('잘못된 날짜는 등록 거부', !badDate.ok && badDate.error.includes('YYYY-MM-DD'));
  const emptyTitle = ddays.createDDay({ title: '  ', date: '2027-01-01' });
  check('빈 이름은 등록 거부', !emptyTitle.ok);
  check('D-Day 목록 정렬(가까운 순)', ddays.listDDays().length === 2 && ddays.listDDays()[0].title === '생일');
  check('D-Day 줄 표기', ddays.ddayLine(ddays.listDDays()[0]).includes('생일 D-'));
  const del = ddays.deleteDDay('전역');
  check('D-Day 삭제', del.removed.length === 1 && ddays.listDDays().length === 1);
  check('없는 D-Day 삭제 안내', Boolean(ddays.deleteDDay('없는디데이').error));

  /* 8) 도커 ---------------------------------------------------------------- */
  check('도커 동작 허용 목록', ['start', 'stop', 'restart', 'pause', 'unpause'].every((a) => docker.ALLOWED_STATE_ACTIONS.has(a)));
  check('삭제·파괴 동작 차단 목록', ['rm', 'prune', 'kill', 'exec', 'down'].every((a) => docker.BLOCKED_ACTIONS.has(a)));
  const self = { hostname: 'abc123', id: 'abcdef0123456789', name: 'pomong-agent', project: 'pomong-agent', service: 'pomong-agent' };
  check('자기 자신(이름)', docker.guardVerdict({ id: 'ffff', name: 'pomong-agent', labels: {} }, self).protected);
  check('자기 자신(id)', docker.guardVerdict({ id: 'abcdef012345', name: 'x', labels: {} }, self).protected);
  check('pomong 이름 접두어', docker.guardVerdict({ id: 'zzz', name: 'pomong-browser', labels: {} }, self).protected);
  check('같은 compose 프로젝트', docker.guardVerdict({ id: 'zzz', name: 'sidecar', labels: { 'com.docker.compose.project': 'pomong-agent' } }, self).protected);
  check('pomong 서비스 이름', docker.guardVerdict({ id: 'zzz', name: 'other', labels: { 'com.docker.compose.service': 'browser' } }, self).protected);
  check(
    '남의 컨테이너는 보호 대상 아님',
    !docker.guardVerdict({ id: 'zzz', name: 'postgres', labels: { 'com.docker.compose.project': 'blog' } }, self).protected
  );
  check('보호 사유 문구', docker.guardVerdict({ id: 'zzz', name: 'pomong-agent', labels: {} }, self).reason.includes('포몽'));

  const rmAttempt = await docker.manageDockerBehavior({ action: 'rm', container: 'postgres' });
  check('rm 동작은 원천 차단', rmAttempt.content.includes('차단'), rmAttempt.content.slice(0, 40));
  const pruneAttempt = await docker.manageDockerBehavior({ action: 'prune' });
  check('prune 동작은 원천 차단', pruneAttempt.content.includes('차단'));
  const killAttempt = await docker.manageDockerBehavior({ action: 'kill', container: 'postgres' });
  check('kill 동작은 원천 차단', killAttempt.content.includes('차단'));
  const noSocket = await docker.manageDockerBehavior({ action: 'ps' });
  check('도커 소켓 없으면 안내', noSocket.content.includes('도커 소켓') || noSocket.content.includes('연결하지 못했습니다'), noSocket.content.slice(0, 50));
  check('도커 사용 가능 여부', docker.dockerAvailable() === false);
  const blockedChange = await docker.changeContainerState(
    { id: 'x', name: 'postgres', image: 'postgres', state: 'running', status: 'up', labels: {} },
    'rm'
  );
  check('전송 계층도 삭제 거부', !blockedChange.ok && blockedChange.error.includes('허용되지 않'), blockedChange.ok ? 'ok' : blockedChange.error);

  /* 9) 회귀 ---------------------------------------------------------------- */
  const html = read('index.html');
  check('viewport-fit=cover 유지', html.includes('viewport-fit=cover'));
  check('poppler-utils·poppler-data 유지', read('Dockerfile').includes('poppler-utils poppler-data'));
  check('D-Day 테이블', Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ddays'").get()));
  check('택배 추적 테이블', Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='parcel_watches'").get()));
  check('할 일 화면에 D-Day 섹션', read('src/pages/Tasks.tsx').includes('/api/ddays') && read('src/pages/Tasks.tsx').includes('D-Day'));
  check('알림은 채팅방 말풍선+푸시', read('server/index.ts').includes('setParcelNotifier') && read('server/index.ts').includes('startParcelWatchLoop'));

  // 개인 식별 문자열은 공개 저장소에 두지 않는다(오픈소스 배포 조건).
  // 그래서 저장소에서는 개인정보의 '형태'를 검사하고, 유지보수자는 저장소 밖 패턴 파일을
  // 지정해 실명·계정까지 함께 검사한다.
  //   PII_PATTERNS_FILE=/절대/경로/pii-patterns.json   → [["라벨", "정규식"], ...]
  const allow = /(?:you@naver\.com|pomong\.labs@gmail\.com|010-1234-5678|test-user@example\.com|홍길동)/;
  const localFile = process.env.PII_PATTERNS_FILE;
  const localPatterns: [string, RegExp][] =
    localFile && fs.existsSync(localFile)
      ? (JSON.parse(fs.readFileSync(localFile, 'utf8')) as [string, string][]).map(
          ([label, src]) => [label, new RegExp(src)] as [string, RegExp]
        )
      : [];
  const patterns: [string, RegExp][] = [
    ['개인 메일 계정', /[A-Za-z0-9._%+-]+@(?:gmail|naver|daum|hanmail|nate|kakao)\.[A-Za-z.]{2,}/],
    ['전화번호', /\b0\d{1,2}[-.\s]\d{3,4}[-.\s]\d{4}\b/],
    ['주민등록번호', /\b\d{6}[-.\s]?[1-4]\d{6}\b/],
    ['생년월일', /\b(?:199|200)\d[-./]?(?:0[1-9]|1[0-2])[-./]?(?:0[1-9]|[12]\d|3[01])\b/],
    ...localPatterns,
  ];
  // 문서·데모용으로 일부러 둔 더미 값만 허용한다.
  const piiHit = (re: RegExp, body: string): boolean =>
    (body.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).some(
      (m) => !allow.test(m)
    );
  const targets = walk(path.join(ROOT, 'src'))
    .concat(walk(path.join(ROOT, 'server')))
    .concat(walk(path.join(ROOT, 'scripts')))
    .concat(walk(path.join(ROOT, 'tools')))
    .concat(walk(path.join(ROOT, 'public')))
    .concat([path.join(ROOT, 'index.html'), path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')])
    .filter((file) => /\.(ts|tsx|js|jsx|css|html|md|json|sh|py)$/.test(file));
  for (const [label, re] of patterns) {
    const hits: string[] = [];
    for (const file of targets) {
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('scripts/smoke-')) continue;
      if (rel.startsWith('public/sw.js')) continue;
      if (piiHit(re, fs.readFileSync(file, 'utf8'))) hits.push(rel);
    }
    check(`개인정보(${label}) 0건`, hits.length === 0, hits.join(', '));
  }

  mock.server.close();
  parcelWatch.stopParcelWatchLoop();
  console.log(`\n${failures ? `❌ 실패 ${failures}건` : '✅ 전부 통과'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
