import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import Mascot, { brandLogoUrl } from './components/Mascot';
import { api, ApiError } from './lib/api';
import { preloadMascotAssets } from './lib/preload';
import { AppStoreProvider, useAppStore } from './lib/store';
import Automation from './pages/Automation';
import Browser from './pages/Browser';
import Chat from './pages/Chat';
import Login from './pages/Login';
import FilesPage from './pages/Files';
import MemoryPage from './pages/Memory';
import Monitor from './pages/Monitor';
import More from './pages/More';
import SettingsPage from './pages/Settings';
import Setup from './pages/Setup';
import Tasks from './pages/Tasks';
import Tools from './pages/Tools';
import Services from './pages/Services';
import Vault from './pages/Vault';

/** 불러오는 동안 보여 주는 화면(테마 변수 사용 — 다크모드에서도 흰 화면이 뜨지 않는다) */
function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4" style={{ background: 'var(--pa-bg)' }}>
      <Mascot name="pimong" hero size={96} className="animate-float" />
      <p className="text-[15px]" style={{ color: 'var(--pa-mute)' }}>
        포몽이 깨어나는 중…
      </p>
    </div>
  );
}

/**
 * v0.6.3: 앱 첫 진입 스플래시
 * 마스코트와 로고를 잠깐 보여 주고 부드럽게 사라진다(레이아웃은 그 뒤로 바로 뜬다).
 * v0.6.17: 이 시간 동안 마스코트 PNG 를 미리 받아 디코드해 둔다(핵심 그림이 준비되면 조금 일찍 넘어간다).
 */
function SplashOverlay({ fading }: { fading: boolean }) {
  return (
    <div
      className={`pointer-events-none fixed inset-0 z-[120] flex flex-col items-center justify-center gap-5 transition-opacity duration-300 ${
        fading ? 'opacity-0' : 'opacity-100'
      }`}
      style={{ background: 'var(--pa-bg)' }}
      aria-hidden
    >
      <div className="pa-splash-in flex flex-col items-center">
        <Mascot name="pimong" hero size={112} />
        <img src={brandLogoUrl()} alt="" className="mt-5 h-[22px] w-auto dark:hidden" draggable={false} />
        <img src={brandLogoUrl(true)} alt="" className="mt-5 hidden h-[22px] w-auto dark:block" draggable={false} />
      </div>
    </div>
  );
}

function RequireAuth() {
  const [state, setState] = useState<'loading' | 'ok' | 'login' | 'setup'>('loading');
  const navigate = useNavigate();
  const { refreshAll } = useAppStore();

  useEffect(() => {
    api
      .get('/api/auth/me')
      .then(() => setState('ok'))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'unauthorized') {
          setState('login');
        } else {
          setState('login');
        }
      });
  }, []);

  useEffect(() => {
    if (state === 'ok') void refreshAll();
  }, [state, refreshAll]);

  useEffect(() => {
    if (state === 'login') navigate('/login', { replace: true });
    if (state === 'setup') navigate('/setup', { replace: true });
  }, [state, navigate]);

  if (state === 'loading') return <Splash />;
  if (state !== 'ok') return <Splash />;
  return <Outlet />;
}

/**
 * v0.6.8: iOS 홈 화면 앱(standalone)인지.
 * 이 경우 iOS가 `apple-touch-startup-image` 네이티브 스플래시를 먼저 보여 주므로
 * React 스플래시까지 뜨면 같은 화면이 두 번 연속 나온다.
 */
function standalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  const displayMode = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  return Boolean(displayMode || iosStandalone);
}

/**
 * v0.6.17 스플래시 시간
 *  - 최소 620ms: 너무 빨리 깜빡이고 사라지지 않게
 *  - 최대 1600ms: 네트워크가 느려 프리로드가 늦어도 여기서 끊고 앱을 보여 준다(무한 대기 금지)
 *  - 300ms: 사라지는 페이드
 */
const SPLASH_MIN_MS = 620;
const SPLASH_MAX_WAIT_MS = 1600;
const SPLASH_FADE_MS = 300;

export default function App() {
  /** PWA 실행이면 이미 네이티브 스플래시가 떴다 — 처음부터 'done'으로 시작해 건너뛴다 */
  const [splash, setSplash] = useState<'show' | 'fading' | 'done'>(() => (standalonePwa() ? 'done' : 'show'));

  useEffect(() => {
    const bootedAt = Date.now();
    // v0.6.17: 부팅과 동시에 마스코트 PNG(기본·상태별 표정)를 미리 받아 decode 해 둔다.
    // standalone PWA 는 네이티브 스플래시와 겹쳐 React 스플래시를 생략하지만, 프리로드는 똑같이 돌린다.
    const assets = preloadMascotAssets();
    if (standalonePwa()) return;

    let cancelled = false;
    let fading = false;
    let fadeTimer = 0;
    let doneTimer = 0;
    const beginFade = () => {
      if (cancelled || fading) return;
      fading = true;
      setSplash('fading');
      doneTimer = window.setTimeout(() => {
        if (!cancelled) setSplash('done');
      }, SPLASH_FADE_MS);
    };

    // 핵심 이미지가 늦게 와도 스플래시에 갇히지 않는다.
    const capTimer = window.setTimeout(beginFade, SPLASH_MAX_WAIT_MS);
    void assets.then(() => {
      if (cancelled || fading) return;
      const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - bootedAt));
      fadeTimer = window.setTimeout(beginFade, wait);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(capTimer);
      window.clearTimeout(fadeTimer);
      window.clearTimeout(doneTimer);
    };
  }, []);

  return (
    <AppStoreProvider>
      {splash !== 'done' ? <SplashOverlay fading={splash === 'fading'} /> : null}
      <Routes>
        <Route path="/setup" element={<Setup />} />
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route index element={<Chat />} />
            <Route path="monitor" element={<Monitor />} />
            <Route path="vault" element={<Vault />} />
            <Route path="tasks" element={<Tasks />} />
            <Route path="automation" element={<Automation />} />
            <Route path="browser" element={<Browser />} />
            <Route path="memory" element={<MemoryPage />} />
            <Route path="services" element={<Services />} />
            <Route path="tools" element={<Tools />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="files" element={<FilesPage />} />
            <Route path="more" element={<More />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppStoreProvider>
  );
}
