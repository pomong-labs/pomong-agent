import * as cheerio from 'cheerio';

/**
 * 무료 웹 검색 (v0.5.0) — API 키 없이 동작한다.
 *
 * DuckDuckGo HTML 엔드포인트를 읽어 제목·URL·스니펫을 돌려준다.
 * 쿠팡처럼 봇 차단이 강한 사이트에서 browser_open이 막히면 이 도구로 정보를 찾아 답한다.
 * (결제·로그인이 필요한 정보는 검색으로 대신할 수 없다는 점을 모델에게 함께 알린다.)
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
  source: string;
  note?: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function fetchText(url: string, timeoutMs = 6000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** DDG 리다이렉트 링크(//duckduckgo.com/l/?uddg=…)를 실제 주소로 바꾼다. */
function realUrl(href: string): string {
  try {
    if (!href) return '';
    const absolute = href.startsWith('//') ? `https:${href}` : href;
    const url = new URL(absolute, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : url.toString();
  } catch {
    return href;
  }
}

function parseDdgHtml(html: string): SearchHit[] {
  const $ = cheerio.load(html);
  const hits: SearchHit[] = [];
  $('.result, .web-result').each((_, el) => {
    const link = $(el).find('.result__a').first();
    const title = link.text().trim().replace(/\s+/g, ' ');
    const url = realUrl(link.attr('href') || '');
    const snippet = $(el)
      .find('.result__snippet')
      .first()
      .text()
      .trim()
      .replace(/\s+/g, ' ');
    if (title && url) hits.push({ title, url, snippet: snippet.slice(0, 260) });
  });
  return hits;
}

function parseDdgLite(html: string): SearchHit[] {
  const $ = cheerio.load(html);
  const hits: SearchHit[] = [];
  $('a.result-link').each((_, el) => {
    const title = $(el).text().trim().replace(/\s+/g, ' ');
    const url = realUrl($(el).attr('href') || '');
    if (!title || !url) return;
    const row = $(el).closest('tr');
    const snippet = row.next('tr').find('.result-snippet').text().trim().replace(/\s+/g, ' ');
    hits.push({ title, url, snippet: snippet.slice(0, 260) });
  });
  return hits;
}

export async function webSearch(query: string, limit = 6): Promise<SearchResult> {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) throw new Error('검색어가 비어 있습니다.');
  const encoded = encodeURIComponent(q);
  const sources: { label: string; url: string; parse: (html: string) => SearchHit[] }[] = [
    { label: 'DuckDuckGo', url: `https://html.duckduckgo.com/html/?q=${encoded}&kl=kr-kr`, parse: parseDdgHtml },
    { label: 'DuckDuckGo Lite', url: `https://lite.duckduckgo.com/lite/?q=${encoded}&kl=kr-kr`, parse: parseDdgLite },
  ];
  let lastError = '';
  for (const source of sources) {
    try {
      const html = await fetchText(source.url);
      const hits = source.parse(html).slice(0, Math.min(8, Math.max(3, limit)));
      if (hits.length) return { query: q, hits, source: source.label };
      lastError = '검색 결과를 찾지 못했습니다.';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    query: q,
    hits: [],
    source: 'none',
    note: `검색이 되지 않았습니다(${lastError.slice(0, 80)}). 잠시 뒤 다시 시도하거나, 사이트를 직접 열어 확인해 주세요.`,
  };
}

/** 도구 응답용 텍스트 */
export function formatSearch(result: SearchResult): string {
  if (!result.hits.length) {
    return `${result.note || '검색 결과가 없습니다.'} (검색어: ${result.query})`;
  }
  const lines = [
    `웹 검색 결과 (${result.source}) — "${result.query}"`,
    ...result.hits.map((hit, i) => `${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`),
    '',
    '※ 검색 결과는 웹 페이지 발췌문입니다. 로그인·결제·실시간 재고처럼 사이트 안에서만 확인되는 값은 다를 수 있으니, 확실하지 않으면 그렇다고 답하세요.',
  ];
  return lines.join('\n');
}
