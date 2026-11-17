import { useEffect, useState } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import AppShell from './components/AppShell';
import Mascot from './components/Mascot';
import { api, ApiError } from './lib/api';
import Chat from './pages/Chat';
import Login from './pages/Login';
import Monitor from './pages/Monitor';
import More from './pages/More';
import SettingsPage from './pages/Settings';
import Setup from './pages/Setup';
import Tasks from './pages/Tasks';
import Vault from './pages/Vault';

function Splash() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-[#FBFBFD]">
      <Mascot name="pimong" hero size={96} className="animate-float" />
      <p className="text-[15px] text-[#8A8A9A]">포몽이 깨어나는 중…</p>
    </div>
  );
}

function RequireAuth() {
  const [state, setState] = useState<'loading' | 'ok' | 'login' | 'setup'>('loading');
  const navigate = useNavigate();

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
    if (state === 'login') navigate('/login', { replace: true });
    if (state === 'setup') navigate('/setup', { replace: true });
  }, [state, navigate]);

  if (state === 'loading') return <Splash />;
  if (state !== 'ok') return <Splash />;
  return <Outlet />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<Chat />} />
          <Route path="monitor" element={<Monitor />} />
          <Route path="vault" element={<Vault />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="more" element={<More />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
