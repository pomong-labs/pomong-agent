/**
 * 정적 에셋 캐시 버전.
 *
 * 캐릭터 표정 PNG처럼 파일 이름이 고정된 이미지는, 배포 후 PWA·브라우저 캐시에
 * 옛 그림이 남아 계속 보이는 일이 있다. 그래서 이미지 URL 뒤에 이 버전을 붙여
 * (`?v=0.4.0`) 새로 배포될 때마다 무조건 다시 받아오게 한다.
 * 앱 버전(server/config.ts의 APP_VERSION, public/sw.js의 VERSION)과 함께 올린다.
 */
export const ASSET_VERSION = '0.6.18';

/** 버전 쿼리가 붙은 정적 에셋 경로 */
export function assetUrl(path: string): string {
  if (!path) return path;
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}v=${ASSET_VERSION}`;
}
