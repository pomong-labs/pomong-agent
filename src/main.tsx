import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
// 색 유틸리티 → 테마 변수/다크 색 치환 (python3 scripts/theme_css.py 로 생성)
import './theme.generated.css';
import { applyStoredTheme } from './lib/theme';
import { installReloadRecovery } from './lib/recover';

// v0.7.3: 배포 직후 옛 번들을 요청해 빈 화면이 남으면 한 번만 자동 새로고침한다.
installReloadRecovery();

// 저장된 테마를 먼저 칠한다. 서버 설정을 받아 오면 store가 최신 값으로 다시 칠한다.
applyStoredTheme();

// PWA: 서비스워커를 등록해야 백그라운드 웹 푸시(알림)를 받을 수 있다.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        // 새 워커가 대기 중이면 기다리지 않고 바로 활성화한다(skipWaiting 과 함께).
        registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              installing.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(() => undefined);
  });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
