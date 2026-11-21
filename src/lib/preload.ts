/**
 * v0.6.17 — 마스코트 이미지 프리로드
 *
 * iOS 홈 화면 앱(PWA)은 첫 화면을 그린 뒤에야 이미지 요청을 시작하는 경우가 많아,
 * 첫 상태 전환(대기 → 생각 중)에서 표정 PNG 가 늦게 도착하며 캐릭터가 한 프레임 비어 보였다.
 * 그래서 앱이 부팅하는 순간(스플래시가 떠 있는 동안) 마스코트 PNG 를
 * `Image` + `img.decode()` 로 미리 받아 디코드해 두고, 화면은 이미 준비된 그림만 바꿔 끼운다.
 *
 * - `preloadMascotAssets()` 는 **지금 보여 줄 핵심 그림**(기본 캐릭터 표정 · 스플래시 히어로 · 로고)이
 *   준비되면 resolve 된다. 나머지 캐릭터는 백그라운드로 이어서 받는다.
 * - 네트워크가 느려도 App 의 스플래시가 최대 1.6초에서 끊고 넘어가므로 무한 대기하지 않는다.
 * - 이미지 주소에는 `?v=` 에셋 버전이 붙는다(assetUrl). 배포 때마다 새 그림을 받는다.
 */
import { assetUrl } from './version';

/** 상태별 표정 PNG(`/mascots/face/*.png`)를 가진 캐릭터 */
export const FACE_CHARACTERS = ['pimong', 'pongi', 'poding', 'lamong', 'mello', 'minti'] as const;

/** 캐릭터 표정 종류 — MascotFace 의 상태 순서와 같다 */
export const FACE_STATES = ['idle', 'thinking', 'working', 'responding', 'error'] as const;

export type FaceCharacter = (typeof FACE_CHARACTERS)[number];
export type FaceState = (typeof FACE_STATES)[number];

/** `/mascots/{이름}.png` (기본·히어로·상황별 소품) */
export function mascotSrc(name: string): string {
  return assetUrl(`/mascots/${name}.png`);
}

/** `/mascots/face/{캐릭터}-{상태}.png` */
export function mascotFaceSrc(character: string, state: string): string {
  return assetUrl(`/mascots/face/${character}-${state}.png`);
}

/** 앱이 쓰는 마스코트 기본 PNG (public/mascots/*.png) */
export const MASCOT_BASE_NAMES = [
  'pimong',
  'pongi',
  'poding',
  'lamong',
  'mello',
  'minti',
  'pimong-hero',
  'pongi-hero',
  'poding-hero',
  'pimong-cheer',
  'pimong-think',
  'pimong-surprised',
  'pongi-check',
  'pongi-alert',
  'poding-key',
  'mello-check',
] as const;

export const MASCOT_BASE_URLS: readonly string[] = MASCOT_BASE_NAMES.map((name) => mascotSrc(name));

export const MASCOT_FACE_URLS: readonly string[] = FACE_CHARACTERS.flatMap((character) =>
  FACE_STATES.map((state) => mascotFaceSrc(character, state))
);

/** 스플래시·로그인 화면의 포몽랩스 로고 */
export const BRAND_URLS: readonly string[] = [assetUrl('/pomong-labs-logo.png'), assetUrl('/pomong-labs-logo-dark.png')];

/** 스플래시·로그인 화면에 크게 나오는 히어로 그림 — 다른 것보다 먼저 받는다 */
export const HERO_URLS: readonly string[] = [mascotSrc('pimong-hero'), mascotSrc('pongi-hero')];

/** 앱이 부팅할 때 미리 받아 둘 전체 정적 이미지 */
export function mascotAssetUrls(): string[] {
  return [...MASCOT_BASE_URLS, ...MASCOT_FACE_URLS, ...BRAND_URLS];
}

/** 디코드까지 끝난 이미지 주소 (동기 확인용 — MascotFace 가 첫 프레임에 쓰는 그림을 고른다) */
const ready = new Set<string>();
/** 지금 받는 중인 이미지 (같은 주소를 여러 컴포넌트가 요청해도 한 번만 받는다) */
const inflight = new Map<string, Promise<boolean>>();

export function isImageReady(src: string): boolean {
  return Boolean(src) && ready.has(src);
}

/**
 * 이미지 하나를 받아 디코드까지 마친다. 실패해도 reject 하지 않고 false 로 알린다
 * (표정 그림이 없으면 MascotFace 가 기본 캐릭터로 넘어간다).
 */
export function preloadImage(src: string): Promise<boolean> {
  if (!src) return Promise.resolve(false);
  if (ready.has(src)) return Promise.resolve(true);
  const running = inflight.get(src);
  if (running) return running;

  const promise = new Promise<boolean>((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(false);
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) ready.add(src);
      inflight.delete(src);
      resolve(ok);
    };
    img.onload = () => {
      // decode() 는 Safari 구버전·일부 이미지에서 거부될 수 있다. 그림 자체는 이미 받았으므로 성공으로 본다.
      const decoded = typeof img.decode === 'function' ? img.decode() : Promise.resolve();
      decoded.then(() => finish(true)).catch(() => finish(true));
    };
    img.onerror = () => finish(false);
    img.src = src;
  });

  inflight.set(src, promise);
  return promise;
}

export function preloadImages(urls: readonly string[]): Promise<boolean[]> {
  return Promise.all(urls.map((url) => preloadImage(url)));
}

/**
 * 여러 장을 한꺼번에 요청하지 않고 몇 개씩 나눠 받는다.
 * 백그라운드 프리로드가 모바일 네트워크를 독차지해 첫 화면·API 응답을 늦추지 않도록.
 */
async function preloadQueue(urls: readonly string[], concurrency = 4): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < urls.length) {
      const url = urls[index];
      index += 1;
      await preloadImage(url);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), urls.length) }, () => worker());
  await Promise.all(workers);
}

/** 캐릭터 하나의 기본 그림 + 상태별 표정 5장 (캐릭터를 바꿨을 때 바로 쓴다) */
export function characterAssetUrls(character: string): string[] {
  return [mascotSrc(character), ...FACE_STATES.map((state) => mascotFaceSrc(character, state))];
}

/** 캐릭터 하나를 즉시 프리로드한다. MascotFace 가 마운트될 때 자기 캐릭터를 우선 확보한다. */
export function preloadCharacter(character: string): Promise<boolean[]> {
  return preloadImages(characterAssetUrls(character));
}

let bulkStarted = false;

/**
 * 부팅 프리로드.
 * 핵심 그림(기본 캐릭터 표정 + 스플래시 로고)이 끝나면 resolve 되고,
 * 나머지 캐릭터·소품 그림은 백그라운드에서 이어서 받는다.
 */
export function preloadMascotAssets(): Promise<void> {
  const core = [...characterAssetUrls('pimong'), ...HERO_URLS, ...BRAND_URLS];
  const coreDone = preloadImages(core).then(() => undefined);

  if (!bulkStarted) {
    bulkStarted = true;
    const rest = mascotAssetUrls().filter((url) => !core.includes(url));
    // 스플래시를 붙잡지 않도록 기다리지 않는다(4장씩 나눠 받는다).
    void preloadQueue(rest, 4).catch(() => undefined);
  }

  return coreDone;
}
