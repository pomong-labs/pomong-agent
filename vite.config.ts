import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    // v0.6.0: noVNC(@novnc/novnc 1.7)가 최상위 await(TLA)를 쓰므로 es2022로 내보낸다.
    // 대상 기기는 iOS 16+ / 최신 크롬·사파리·엣지(개인 서버 앱)라 문제없다.
    target: ['es2022', 'chrome110', 'safari16', 'firefox110', 'edge110'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3100',
    },
  },
});
