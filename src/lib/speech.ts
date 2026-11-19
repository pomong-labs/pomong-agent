/**
 * 음성 입력(마이크) · 답변 읽어주기(TTS) — v0.5.5
 *
 * 브라우저 기본 기능만 쓴다(별도 키·서버 없음).
 * - 받아쓰기: `SpeechRecognition` / `webkitSpeechRecognition` (ko-KR, interimResults)
 * - 읽어주기: `window.speechSynthesis` (ko-KR). iOS는 긴 글을 한 번에 읽지 못하므로
 *   문장 단위로 잘라 순서대로 읽고, 다른 말풍선을 누르면 이전 재생을 즉시 멈춘다.
 */

/* ------------------------------------------------------------------ */
/* 답변 읽어주기 (TTS)                                                   */
/* ------------------------------------------------------------------ */

type Listener = () => void;
const listeners = new Set<Listener>();
let speakingKey: string | null = null;
let playToken = 0;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function setSpeakingKey(key: string | null): void {
  if (speakingKey === key) return;
  speakingKey = key;
  emit();
}

export function subscribeSpeech(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSpeakingKey(): string | null {
  return speakingKey;
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** 마크다운·기호·링크를 걷어 내 읽기 좋은 문장으로 만든다. */
export function cleanForSpeech(raw: string): string {
  let text = String(raw || '');
  text = text.replace(/```[\s\S]*?```/g, ' 코드 예시는 생략할게요. ');
  text = text.replace(/`([^`]*)`/g, '$1');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, ' 링크 ');
  text = text.replace(/^\s*(?:[-*•+]|\d+[.)])\s+/gm, '');
  text = text.replace(/^\s*#{1,6}\s*/gm, '');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/[*_~^|>]/g, ' ');
  text = text.replace(/<[^>]{1,40}>/g, ' ');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{2,}/g, '\n');
  return text.trim();
}

const MAX_CHUNK = 150;

function splitLong(piece: string): string[] {
  const out: string[] = [];
  let rest = piece.trim();
  while (rest.length > MAX_CHUNK) {
    const window = rest.slice(0, MAX_CHUNK);
    let cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
      window.lastIndexOf(', '),
      window.lastIndexOf(' ')
    );
    if (cut < 40) cut = MAX_CHUNK - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** 긴 글을 iOS에서도 끊기지 않게 문장·줄 단위로 자른다. */
export function chunkForSpeech(text: string): string[] {
  return String(text || '')
    .split(/\n+/)
    .flatMap((line) => (line.trim().length > MAX_CHUNK ? splitLong(line) : [line.trim()]))
    .filter(Boolean);
}

function koreanVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find((voice) => voice.lang?.replace('_', '-') === 'ko-KR' && voice.localService) ||
      voices.find((voice) => /^ko/i.test(voice.lang || '')) ||
      null
    );
  } catch {
    return null;
  }
}

function finishPlayback(token: number): void {
  if (token !== playToken) return;
  setSpeakingKey(null);
}

/** 해당 말풍선을 읽는다. 다른 것 재생 중이면 멈추고 이어서 읽는다. */
export function speak(key: string, raw: string): void {
  if (!speechSupported()) return;
  const text = cleanForSpeech(raw);
  if (!text) return;
  stopSpeech();
  const token = playToken;
  const chunks = chunkForSpeech(text);
  if (!chunks.length) return;
  setSpeakingKey(key);
  const voice = koreanVoice();
  const synth = window.speechSynthesis;
  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = 'ko-KR';
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.onend = () => {
      if (token !== playToken) return;
      if (index === chunks.length - 1) finishPlayback(token);
    };
    utterance.onerror = () => finishPlayback(token);
    try {
      synth.speak(utterance);
    } catch {
      finishPlayback(token);
    }
  });
  // iOS가 마지막 onend를 놓치는 경우를 대비한 안전장치.
  const estimate = Math.min(600_000, 2_000 + text.length * 120);
  window.setTimeout(() => {
    if (token !== playToken) return;
    if (!synth.speaking && !synth.pending) finishPlayback(token);
  }, estimate);
}

export function stopSpeech(): void {
  playToken += 1;
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* ignore */
  }
  setSpeakingKey(null);
}

export function toggleSpeech(key: string, text: string): void {
  if (getSpeakingKey() === key) stopSpeech();
  else speak(key, text);
}

/* ------------------------------------------------------------------ */
/* 음성 입력 (받아쓰기)                                                 */
/* ------------------------------------------------------------------ */

interface RecognitionResultLike {
  0?: { transcript?: string };
  isFinal?: boolean;
  length?: number;
}
interface RecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResultLike };
}
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return scope.SpeechRecognition || scope.webkitSpeechRecognition || null;
}

export function dictationSupported(): boolean {
  return Boolean(recognitionCtor());
}

/**
 * iOS/iPadOS의 모든 브라우저와 맥 사파리는 WebKit이다.
 *
 * WebKit의 SpeechRecognition은 `continuous = true`로 두고 `onend`에서 같은 인스턴스를
 * 다시 `start()` 하면 두 번째 인식부터 `start_failed`/`aborted`로 실패한다.
 * 그래서 WebKit에서는 한 번 말할 때마다 인식기를 새로 만들고, 끝나면 그대로 정리한다.
 */
export function isAppleWebKit(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return true;
  return /AppleWebKit/i.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|Edg|OPR|SamsungBrowser|Android)/i.test(ua);
}

const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported']);

export function dictationErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '마이크 권한이 꺼져 있어요. 아이폰은 설정 > Safari > 마이크에서 허용해 주시고, 앱(PWA)에서는 키보드의 마이크(받아쓰기) 버튼도 쓸 수 있어요.';
    case 'audio-capture':
      return '마이크를 찾지 못했어요. 다른 앱이 마이크를 쓰고 있지 않은지 확인해 주세요.';
    case 'network':
      return '음성 인식 서버에 연결하지 못했어요. 연결을 확인하고 잠시 뒤 다시 눌러 주세요.';
    case 'no-speech':
      return '소리가 잘 들리지 않았어요. 조금 더 가까이에서 다시 말씀해 주세요.';
    case 'language-not-supported':
      return '이 브라우저는 한국어 받아쓰기를 지원하지 않아요. 키보드의 마이크(받아쓰기)를 써 주세요.';
    case 'start_failed':
      return '음성 인식을 시작하지 못했어요. 잠시 뒤 다시 눌러 주세요.';
    default:
      return '음성 인식을 쓰지 못했어요. 잠시 뒤 다시 시도해 주세요.';
  }
}

export function dictationUnsupportedMessage(): string {
  return '이 브라우저는 음성 입력을 지원하지 않아요. 아이폰 사파리에서는 키보드 오른쪽 아래 마이크(받아쓰기) 버튼으로 말할 수 있어요.';
}

export interface DictationHandle {
  stop: () => void;
  abort: () => void;
}

export interface DictationCallbacks {
  /** finalText: 확정된 받아쓰기 전체, interimText: 지금 말하는 중인 조각 */
  onText: (finalText: string, interimText: string) => void;
  onError: (code: string, message: string) => void;
  onEnd: () => void;
}

export function startDictation(callbacks: DictationCallbacks): DictationHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  let recognition: RecognitionLike;
  try {
    recognition = new Ctor();
  } catch {
    return null;
  }
  const webkit = isAppleWebKit();
  recognition.lang = 'ko-KR';
  recognition.interimResults = true;
  // WebKit은 continuous 모드에서 같은 인스턴스를 재시작하면 실패한다.
  recognition.continuous = !webkit;
  recognition.maxAlternatives = 1;

  let stopped = false;
  let finished = false;
  let finalText = '';
  let silentRounds = 0;

  const finishOnce = () => {
    if (finished) return;
    finished = true;
    callbacks.onEnd();
  };

  recognition.onresult = (event) => {
    let interim = '';
    const startIndex = Number(event.resultIndex) || 0;
    for (let i = startIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const transcript = String(result?.[0]?.transcript || '');
      if (result?.isFinal) finalText += transcript;
      else interim += transcript;
    }
    callbacks.onText(finalText.trim(), interim.trim());
  };
  recognition.onerror = (event) => {
    const code = String(event?.error || 'unknown');
    // 사용자가 마이크를 끄거나 화면을 떠날 때 나오는 aborted 는 정상 신호다.
    if (code === 'aborted' || code === 'abort' || stopped) return;
    if (FATAL_ERRORS.has(code)) stopped = true;
    // 한 번의 침묵은 흘려보내고, 두 번 연속이면 안내한다(이어 듣기는 계속).
    if (code === 'no-speech') {
      silentRounds += 1;
      if (silentRounds >= 2) callbacks.onError(code, dictationErrorMessage(code));
      return;
    }
    silentRounds = 0;
    callbacks.onError(code, dictationErrorMessage(code));
  };
  recognition.onend = () => {
    if (webkit) {
      // WebKit: 같은 인스턴스를 다시 start() 하지 않는다. 말이 끝나면 깔끔하게 정리하고,
      // 이어서 말하려면 마이크를 다시 눌러 **새 인스턴스**로 시작한다.
      finishOnce();
      return;
    }
    if (!stopped) {
      // 침묵으로 잠깐 멈춘 경우엔 계속 듣는다(사용자가 끌 때까지).
      try {
        recognition.start();
        return;
      } catch {
        /* 이어 듣기 실패 → 종료로 처리 */
      }
    }
    finishOnce();
  };

  try {
    recognition.start();
  } catch {
    callbacks.onError('start_failed', dictationErrorMessage('start_failed'));
    finishOnce();
    return null;
  }

  return {
    stop: () => {
      stopped = true;
      try {
        recognition.stop();
      } catch {
        finishOnce();
      }
    },
    abort: () => {
      stopped = true;
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
      finishOnce();
    },
  };
}

// 페이지를 떠나면 읽어주기를 멈춘다(백그라운드에서 소리가 이어지지 않게).
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => stopSpeech());
}
