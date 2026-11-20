import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import Mascot from './components/Mascot';
import { api, ApiError } from './lib/api';
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
 * 마스코트와 로고를 0.6초쯤 보여 주고 부드럽게 사라진다(레이아웃은 그 뒤로 바로 뜬다).
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
        <img src="/pomong-labs-logo.png" alt="" className="mt-5 h-[22px] w-auto dark:hidden" draggable={false} />
        <img src="/pomong-labs-logo-dark.png" alt="" className="mt-5 hidden h-[22px] w-auto dark:block" draggable={false} />
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

export default function App() {
  /** 스플래시: 620ms 보여 주고 300ms 동안 사라진다 */
  const [splash, setSplash] = useState<'show' | 'fading' | 'done'>('show');
  useEffect(() => {
    const fade = window.setTimeout(() => setSplash('fading'), 620);
    const done = window.setTimeout(() => setSplash('done'), 940);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(done);
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
