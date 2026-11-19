import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
// 색 유틸리티 → 테마 변수/다크 색 치환 (python3 scripts/theme_css.py 로 생성)
import './theme.generated.css';
import { applyStoredTheme } from './lib/theme';

// 저장된 테마를 먼저 칠한다. 서버 설정을 받아 오면 store가 최신 값으로 다시 칠한다.
applyStoredTheme();

// PWA: 서비스워커를 등록해야 백그라운드 웹 푸시(알림)를 받을 수 있다.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
