import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import Logo from '../components/Logo';
import Mascot from '../components/Mascot';
import { api } from '../lib/api';

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState('0.3.0');

  useEffect(() => {
    api
      .get<{ version: string }>('/api/version')
      .then((r) => setVersion(r.version))
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { username, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pa-scroll relative flex h-full items-center justify-center overflow-y-auto overflow-x-hidden bg-pomong-bg px-4 py-10">
      <div className="pointer-events-none absolute -left-20 top-10 h-72 w-72 rounded-full bg-[#FFE4EE] opacity-40 blur-3xl" />
      <div className="pointer-events-none absolute -right-16 bottom-0 h-72 w-72 rounded-full bg-[#E4F4FF] opacity-50 blur-3xl" />

      <div className="relative w-full max-w-[420px]">
        <div className="flex justify-center gap-2">
          <Mascot name="pimong" hero size={112} className="animate-float" />
          <Mascot name="pongi" hero size={96} className="animate-float translate-y-3" />
        </div>
        <form onSubmit={submit} className="relative -mt-4 rounded-[32px] bg-white px-7 py-9 shadow-soft">
          <div className="flex flex-col items-center">
            <Logo size={30} withText={false} />
            <h1 className="mt-3 text-[24px] font-bold tracking-[-0.02em]">Pomong Agent</h1>
            <p className="mt-1.5 text-[14px] text-pomong-sub">다시 만나서 반가워요!</p>
          </div>

          <div className="mt-7 space-y-3.5">
            <input
              className="pa-input"
              placeholder="아이디"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
            <div className="relative">
              <input
                className="pa-input pr-12"
                type={show ? 'text' : 'password'}
                placeholder="비밀번호"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#A8A5B8] hover:bg-[#F7F5FF]"
                onClick={() => setShow((v) => !v)}
                aria-label="비밀번호 표시"
              >
                {show ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </div>

          {error ? <p className="mt-4 rounded-xl bg-[#FFF1F1] px-3 py-2.5 text-[13px] font-medium text-[#E5484D]">{error}</p> : null}

          <button type="submit" className="pa-btn-primary mt-5 w-full" disabled={busy || !username || !password}>
            {busy ? '로그인 중…' : '로그인'}
            {!busy ? <ArrowRight size={17} /> : null}
          </button>

          <p className="mt-5 text-center text-[12px] leading-relaxed text-[#A8A5B8]">
            내 서버에서만 동작하는 개인 AI 비서 · v{version}
          </p>
        </form>
      </div>
    </div>
  );
}
