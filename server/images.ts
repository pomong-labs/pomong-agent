/**
 * v0.6.15 — 채팅방 이미지 생성·편집 · QR 코드
 *
 *  · generate_image : 프롬프트로 새 그림을 만든다(Gemini 이미지 모델).
 *  · edit_image     : 채팅에 올렸거나 방금 만든 사진을 지시대로 고친다.
 *  · create_qr      : 링크·텍스트·Wi-Fi 정보로 스캔되는 PNG QR을 만든다(qrcode npm).
 *
 * 만든 그림은 모두 채팅 첨부(chat_attachments)로 저장한다. 그래서
 *   · 대화 말풍선에 바로 보이고,
 *   · 파일함(/files)에서도 다시 열 수 있고,
 *   · 사용자가 다음 턴에 "그거 배경만 바꿔 줘"라고 하면 edit_image가 찾아 쓴다.
 *
 * 키는 사용자가 설정에 저장한 Gemini 키를 쓴다(이미지 출력은 Gemini만 지원).
 * 무료 한도가 0인 키에서는 Google이 429를 돌려주므로, 그 이유를 사용자가 알아볼 수 있게
 * 한국어 안내로 바꿔 돌려준다.
 */

import fs from 'node:fs';
import QRCode from 'qrcode';
import { addLog, db, getJson } from './db';
import { decrypt, serverKey } from './crypto';
import * as attachments from './attachments';
import * as files from './files';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';

/** 이미지 출력을 지원하는 모델 — 앞에 있는 것부터 시도한다. */
export const IMAGE_MODEL_PREFERENCE = [
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3-pro-image-preview',
];

/** 모델 목록을 다시 받아 오는 간격 */
const MODEL_CACHE_MS = 10 * 60 * 1000;
let modelCache: { at: number; models: string[] } | null = null;

/** 편집 입력으로 받는 원본 사진 상한 */
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
/** 생성된 그림 1장 상한 */
const MAX_OUTPUT_BYTES = 18 * 1024 * 1024;
/** 이미지 모델은 장당 수 초~수십 초가 걸린다. */
const GENERATE_TIMEOUT_MS = 120_000;

export interface ImageToolResult {
  content: string;
  /** 채팅 말풍선에 붙일 첨부 id */
  attachmentIds?: string[];
  ok: boolean;
}

/** 설정에 저장된 Gemini 키(없으면 null). 값은 어디에도 기록하지 않는다. */
export function geminiApiKey(): string | null {
  const state = getJson<{ accounts?: Record<string, { apiKeyEnc?: string }> }>('llm.state', {});
  const enc = state.accounts?.gemini?.apiKeyEnc;
  if (!enc) return null;
  try {
    return decrypt(enc, serverKey());
  } catch {
    return null;
  }
}

/** 사용할 이미지 모델 이름(우선순위 → 목록에 있는 것 → null) */
export function pickImageModel(available: string[]): string | null {
  const names = available.map((n) => String(n || '').replace(/^models\//, '').trim()).filter(Boolean);
  for (const preferred of IMAGE_MODEL_PREFERENCE) {
    if (names.includes(preferred)) return preferred;
  }
  return names.find((name) => /image/i.test(name)) || null;
}

/** 계정에서 쓸 수 있는 이미지 모델 목록(10분 캐시). 실패하면 빈 배열. */
async function listImageModels(apiKey: string): Promise<string[]> {
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.models;
  try {
    const res = await fetch(`${GEMINI_API}/models?key=${encodeURIComponent(apiKey)}&pageSize=200`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const models = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((name) => /image/i.test(name));
    modelCache = { at: Date.now(), models };
    return models;
  } catch {
    return [];
  }
}

/** 오류 응답을 사용자가 읽을 수 있는 문장으로 바꾼다. */
export function describeImageError(status: number, body: string, model: string): string {
  const detail = (() => {
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      return String(parsed.error?.message || '').replace(/\s+/g, ' ').slice(0, 240);
    } catch {
      return String(body || '').replace(/\s+/g, ' ').slice(0, 240);
    }
  })();
  if (status === 429) {
    return (
      `[이미지 생성 한도] Gemini 이미지 모델(${model})의 이 키 사용 한도가 0이라 지금은 그림을 만들 수 없습니다. ` +
      'Google AI Studio에서 이 키에 결제(유료 사용 설정)를 켜면 바로 쓸 수 있습니다. ' +
      '사용자에게 이 사실을 한두 문장으로 알리고, 대신 글로 설명하거나 다른 방식으로 도와드리자고 제안하세요. ' +
      `(원문: ${detail})`
    );
  }
  if (status === 400 || status === 422) {
    return (
      '[이미지 요청 거부] 이미지 모델이 요청을 받아들이지 않았습니다. 안전 정책에 걸린 표현(사람 얼굴·폭력·상표 등)이 있으면 ' +
      `표현을 바꿔 다시 요청해 주세요. (원문: ${detail})`
    );
  }
  if (status === 401 || status === 403) {
    return `[권한 없음] 이 Gemini 키로는 이미지 모델을 쓸 수 없습니다. 설정 > AI에서 키를 다시 확인하거나 결제 설정을 켜 주세요. (원문: ${detail})`;
  }
  if (status === 404) {
    return `[모델 없음] 이미지 모델(${model})을 이 키에서 찾지 못했습니다. 다른 이미지 모델로 다시 시도하거나, 사용자에게 이 사실을 알려 주세요. (원문: ${detail})`;
  }
  return `[이미지 생성 실패] ${status} — ${detail || '알 수 없는 오류'}`;
}

export interface InlineImageInput {
  mime: string;
  dataBase64: string;
}

interface GeminiImageResponse {
  candidates?: {
    content?: { parts?: { text?: string; inlineData?: { mimeType?: string; data?: string } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/** 응답 본문에서 그림을 꺼낸다(그림이 없으면 이유를 붙여 오류). */
export function extractImage(
  response: GeminiImageResponse,
  model: string
): { data: Buffer; mime: string; text: string } {
  const candidate = response.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  const image = parts.find((p) => p.inlineData?.data);
  if (image?.inlineData?.data) {
    const mime = String(image.inlineData.mimeType || 'image/png');
    const data = Buffer.from(image.inlineData.data, 'base64');
    if (data.length > MAX_OUTPUT_BYTES) {
      throw new Error(`[이미지 생성 실패] 만들어진 그림이 너무 큽니다(${(data.length / 1024 / 1024).toFixed(1)}MB).`);
    }
    if (data.length) return { data, mime, text };
  }
  const reason = String(candidate?.finishReason || response.promptFeedback?.blockReason || '').toUpperCase();
  if (/SAFETY|PROHIBITED|RECITATION|BLOCK/.test(reason)) {
    throw new Error(
      `[안전 정책] 요청한 내용이 Gemini 안전 정책에 걸려 그림을 만들지 못했습니다(${reason}). 인물·상표·폭력적인 표현을 빼고 다시 요청해 주세요.`
    );
  }
  if (reason === 'MAX_TOKENS' || reason === 'LENGTH') {
    throw new Error('[이미지 생성 실패] 응답이 길이 제한에 걸려 그림이 나오지 않았습니다. 요청을 조금 짧게 바꿔 주세요.');
  }
  if (text) {
    throw new Error(`[이미지 생성 실패] 모델이 그림 대신 글만 돌려주었습니다: ${text.slice(0, 200)}`);
  }
  throw new Error(`[이미지 생성 실패] 모델이 그림을 돌려주지 않았습니다(사유: ${reason || '알 수 없음'}) — ${model}`);
}

/**
 * Gemini 이미지 모델 호출(generateContent + responseModalities).
 * 실패하면 한국어 안내 문구를 담은 Error를 던진다.
 */
export async function callImageModel(input: {
  apiKey: string;
  model: string;
  prompt: string;
  source?: InlineImageInput;
  aspectRatio?: string;
}): Promise<{ data: Buffer; mime: string; text: string; model: string }> {
  const parts: Record<string, unknown>[] = [{ text: input.prompt }];
  if (input.source) {
    parts.push({ inlineData: { mimeType: input.source.mime, data: input.source.dataBase64 } });
  }
  const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] };
  // 비율 지정은 gemini-3 계열 이미지 모델이 지원한다(2.5 계열에는 보내지 않는다).
  if (input.aspectRatio && /^gemini-3/.test(input.model)) {
    generationConfig.imageConfig = { aspectRatio: input.aspectRatio };
  }
  let res: Response;
  try {
    res = await fetch(
      `${GEMINI_API}/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
        signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`[이미지 생성 실패] 이미지 모델에 연결하지 못했습니다(${message}). 잠시 뒤 다시 시도해 주세요.`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(describeImageError(res.status, body, input.model));
  let parsed: GeminiImageResponse;
  try {
    parsed = JSON.parse(body) as GeminiImageResponse;
  } catch {
    throw new Error('[이미지 생성 실패] 모델 응답을 읽지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
  }
  return { ...extractImage(parsed, input.model), model: input.model };
}

/** 그림 파일 이름: pomong-image-20261121-093812.png */
export function imageFileName(prefix: string, mime: string, at: Date): string {
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(
    at.getMinutes()
  )}${pad(at.getSeconds())}`;
  return `pomong-${prefix}-${stamp}.${ext}`;
}

/** 그림을 채팅 첨부로 저장한다(말풍선·파일함에 함께 보인다). */
export function saveChatImage(input: {
  sessionId: string;
  data: Buffer;
  mime: string;
  prefix: 'image' | 'edit' | 'qr';
}): attachments.AttachmentView {
  const name = imageFileName(input.prefix, input.mime, new Date());
  return attachments.saveUpload({ sessionId: input.sessionId, filename: name, mime: input.mime, data: input.data });
}

/** 이 방에서 가장 최근 사진 첨부(사용자가 올린 사진·방금 만든 그림 모두) */
export function latestImageAttachment(sessionId: string): attachments.AttachmentRow | null {
  const row = db
    .prepare(
      `SELECT * FROM chat_attachments WHERE session_id = ? AND kind = 'image'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(sessionId) as attachments.AttachmentRow | undefined;
  return row || null;
}

/** id(`a:`·`f:`·첨부 id)로 사진 파일을 찾아 base64로 읽는다. */
export function readImageSource(ref: string): {
  row: attachments.AttachmentRow | null;
  absPath: string;
  mime: string;
  dataBase64: string;
} | null {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  let absPath = '';
  let mime = '';
  let row: attachments.AttachmentRow | null = null;
  if (raw.startsWith('a:') || raw.startsWith('f:')) {
    const resolved = files.resolveFile(raw);
    if (!resolved) return null;
    absPath = resolved.absPath;
    mime = resolved.item.mime;
    if (raw.startsWith('a:')) row = attachments.getRow(raw.slice(2));
  } else {
    row = attachments.getRow(raw);
    if (!row) return null;
    absPath = attachments.absolutePath(row);
    mime = row.mime;
  }
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SOURCE_BYTES) return null;
    const data = fs.readFileSync(absPath);
    return { row, absPath, mime: mime || 'image/png', dataBase64: data.toString('base64') };
  } catch {
    return null;
  }
}

/** 실제로 호출할 모델 이름(도구 인자 → 환경변수 → 계정에서 찾은 모델 → 기본값) */
async function resolveModel(apiKey: string, requested?: string): Promise<string> {
  const asked = String(requested || '').trim().replace(/^models\//, '');
  if (asked) return asked;
  const env = String(process.env.GEMINI_IMAGE_MODEL || '').trim();
  if (env) return env;
  const models = await listImageModels(apiKey);
  return pickImageModel(models) || IMAGE_MODEL_PREFERENCE[0];
}

function noKeyMessage(): string {
  return (
    '이미지 생성에는 Gemini 키가 필요합니다. 설정 > AI에서 Gemini API 키를 연결한 뒤 다시 요청해 주세요. ' +
    '(그림 생성·편집은 Gemini 이미지 모델만 지원합니다)'
  );
}

/** generate_image 도구 본체 */
export async function generateImageTool(input: {
  sessionId: string;
  prompt: string;
  aspectRatio?: string;
  model?: string;
}): Promise<ImageToolResult> {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) return { ok: false, content: '무엇을 그릴지 설명(prompt)이 비어 있습니다.' };
  const apiKey = geminiApiKey();
  if (!apiKey) return { ok: false, content: noKeyMessage() };
  const model = await resolveModel(apiKey, input.model);
  try {
    const result = await callImageModel({ apiKey, model, prompt, aspectRatio: input.aspectRatio });
    const view = saveChatImage({ sessionId: input.sessionId, data: result.data, mime: result.mime, prefix: 'image' });
    addLog('info', `이미지 생성 · ${model} (${(result.data.length / 1024).toFixed(0)}KB)`);
    return {
      ok: true,
      attachmentIds: [view.id],
      content:
        `이미지를 만들어 채팅에 바로 붙이고 파일함에도 저장했습니다. (모델 ${result.model} · ${(result.data.length / 1024).toFixed(0)}KB · ` +
        `첨부 id ${view.id}) 사용자에게 "만들었어요"라고 짧게 알려 주세요. 이 그림을 고치려면 edit_image(source_image_id: "${view.id}")를 쓰면 됩니다.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog('warn', `이미지 생성 실패 · ${message.slice(0, 160)}`);
    return { ok: false, content: message };
  }
}

/** edit_image 도구 본체 */
export async function editImageTool(input: {
  sessionId: string;
  instruction: string;
  sourceImageId?: string;
  aspectRatio?: string;
  model?: string;
}): Promise<ImageToolResult> {
  const instruction = String(input.instruction || '').trim();
  if (!instruction) return { ok: false, content: '어떻게 고칠지(instruction)가 비어 있습니다.' };
  const apiKey = geminiApiKey();
  if (!apiKey) return { ok: false, content: noKeyMessage() };
  const requested = String(input.sourceImageId || '').trim();
  let picked = requested ? readImageSource(requested) : null;
  if (!picked) {
    const latest = latestImageAttachment(input.sessionId);
    picked = latest ? readImageSource(latest.id) : null;
  }
  if (!picked) {
    return {
      ok: false,
      content:
        '고칠 사진을 찾지 못했습니다. 사용자에게 사진을 채팅에 첨부해 달라고 안내하거나, 먼저 generate_image로 그림을 만들면 됩니다. ' +
        '(사진은 8MB 이하만 다룰 수 있습니다)',
    };
  }
  const model = await resolveModel(apiKey, input.model);
  try {
    const result = await callImageModel({
      apiKey,
      model,
      prompt:
        '아래 사진을 요청대로 고쳐 주세요. 원본의 구도와 주요 요소는 유지하고, 요청한 부분만 바꿉니다.\n\n' +
        `[요청] ${instruction}`,
      source: { mime: picked.mime, dataBase64: picked.dataBase64 },
      aspectRatio: input.aspectRatio,
    });
    const view = saveChatImage({ sessionId: input.sessionId, data: result.data, mime: result.mime, prefix: 'edit' });
    addLog('info', `이미지 편집 · ${model} (${(result.data.length / 1024).toFixed(0)}KB)`);
    return {
      ok: true,
      attachmentIds: [view.id],
      content:
        '사진을 고쳐서 채팅에 붙이고 파일함에도 저장했습니다. ' +
        `(모델 ${result.model} · 첨부 id ${view.id}) 사용자에게 무엇을 바꿨는지 한 줄로 알려 주세요.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog('warn', `이미지 편집 실패 · ${message.slice(0, 160)}`);
    return { ok: false, content: message };
  }
}

/* ------------------------------------------------------------------ */
/* QR 코드                                                             */
/* ------------------------------------------------------------------ */

/** Wi-Fi QR 규격: WIFI:T:WPA;S:<ssid>;P:<password>;; */
export function buildWifiPayload(input: {
  ssid: string;
  password?: string;
  security?: string;
  hidden?: boolean;
}): string {
  const security = String(input.security || (input.password ? 'WPA' : 'nopass')).toUpperCase();
  const escape = (value: string) => String(value || '').replace(/([\\;,:"])/g, '\\$1');
  const type = security === 'WEP' ? 'WEP' : security === 'NOPASS' || !input.password ? 'nopass' : 'WPA';
  const parts = [`T:${type}`, `S:${escape(input.ssid)}`];
  if (type !== 'nopass' && input.password) parts.push(`P:${escape(input.password)}`);
  if (input.hidden) parts.push('H:true');
  return `WIFI:${parts.join(';')};;`;
}

/** URL처럼 보이면 https를 붙인다(스캔하면 브라우저가 바로 열리게). */
export function normalizeQrText(text: string): string {
  const value = String(text || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(value) && !/\s/.test(value)) return `https://${value}`;
  return value;
}

export interface QrInput {
  sessionId: string;
  text?: string;
  url?: string;
  kind?: string;
  wifiSsid?: string;
  wifiPassword?: string;
  wifiSecurity?: string;
  wifiHidden?: boolean;
  size?: number;
}

/** QR에 담을 문자열을 정한다(순수 함수 — 스모크에서 검증한다). */
export function resolveQrPayload(
  input: Omit<QrInput, 'sessionId'>
): { payload: string; label: string } | { error: string } {
  const kind = String(input.kind || 'auto').toLowerCase();
  if (kind === 'wifi' || input.wifiSsid) {
    const ssid = String(input.wifiSsid || '').trim();
    if (!ssid) return { error: 'Wi-Fi 이름(SSID)이 필요합니다.' };
    return {
      payload: buildWifiPayload({
        ssid,
        password: input.wifiPassword,
        security: input.wifiSecurity,
        hidden: Boolean(input.wifiHidden),
      }),
      label: `Wi-Fi “${ssid}”`,
    };
  }
  const raw = String(input.url || input.text || '').trim();
  if (!raw) return { error: 'QR에 담을 링크나 문구가 필요합니다.' };
  const payload = kind === 'text' ? raw : normalizeQrText(raw);
  if (Buffer.byteLength(payload, 'utf8') > 1200) {
    return { error: '내용이 너무 깁니다. QR 한 장에 담을 수 있는 길이(약 1,200바이트)로 줄여 주세요.' };
  }
  return { payload, label: payload.length > 48 ? `${payload.slice(0, 48)}…` : payload };
}

/** create_qr 도구 본체 */
export async function createQrTool(input: QrInput): Promise<ImageToolResult> {
  const resolved = resolveQrPayload(input);
  if ('error' in resolved) return { ok: false, content: resolved.error };
  const size = Math.min(2048, Math.max(256, Number(input.size) || 1024));
  try {
    const png = await QRCode.toBuffer(resolved.payload, {
      type: 'png',
      width: size,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#1B1923', light: '#FFFFFF' },
    });
    const view = saveChatImage({ sessionId: input.sessionId, data: png, mime: 'image/png', prefix: 'qr' });
    addLog('info', `QR 코드 생성 · ${resolved.label} (${size}px)`);
    return {
      ok: true,
      attachmentIds: [view.id],
      content:
        `QR 코드를 만들어 채팅에 붙이고 파일함에도 저장했습니다(${size}×${size} PNG · 담은 내용: ${resolved.label} · 첨부 id ${view.id}). ` +
        '사용자에게 "QR을 만들었어요, 화면을 스캔해 보세요"라고 알려 주세요.',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `QR 코드를 만들지 못했습니다: ${message}` };
  }
}
