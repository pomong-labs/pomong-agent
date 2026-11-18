import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, ListChecks, Lock, LogOut, Settings as SettingsIcon, Wrench } from 'lucide-react';
import Mascot from '../components/Mascot';
import { api } from '../lib/api';

export default function More() {
  const navigate = useNavigate();
  const [version, setVersion] = useState('0.3.1');

  useEffect(() => {
    api
      .get<{ version: string }>('/api/version')
      .then((r) => setVersion(r.version))
      .catch(() => undefined);
  }, []);

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    navigate('/login', { replace: true });
  };

  const items = [
    { label: '도구', desc: 'AI가 쓸 수 있는 기능과 예시', icon: Wrench, to: '/tools', tint: '#EAFBF1', color: '#12B886' },
    { label: '할 일', desc: '오늘의 태스크 관리', icon: ListChecks, to: '/tasks', tint: '#EFF7FF', color: '#4A90FF' },
    { label: '금고', desc: 'API 키 · 로그인 · 메모', icon: Lock, to: '/vault', tint: '#FFF6E7', color: '#E49B18' },
    { label: '설정', desc: '프로필 · AI 연결', icon: SettingsIcon, to: '/settings', tint: '#F3EEFF', color: '#8B72F6' },
  ];

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-8 pt-5">
      <header className="flex items-center gap-3">
        <Mascot name="minti" size={52} />
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.02em]">더보기</h1>
          <p className="text-[13px] text-pomong-sub">포몽 에이전트 메뉴</p>
        </div>
      </header>

      <ul className="mt-5 space-y-2">
        {items.map((item) => (
          <li key={item.to}>
            <button
              onClick={() => navigate(item.to)}
              className="flex w-full items-center gap-3.5 rounded-[20px] bg-white px-4 py-3.5 text-left shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#F6F4FB]"
            >
              <span className="flex h-11 w-11 items-center justify-center rounded-2xl" style={{ background: item.tint, color: item.color }}>
                <item.icon size={20} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15.5px] font-semibold text-[#1F1D2B]">{item.label}</span>
                <span className="block text-[12.5px] text-pomong-sub">{item.desc}</span>
              </span>
              <ChevronRight size={18} className="text-[#C9C5D6]" />
            </button>
          </li>
        ))}
      </ul>

      <button className="mt-4 flex w-full items-center justify-center gap-2 rounded-[20px] bg-white px-4 py-3.5 text-[14.5px] font-semibold text-[#F2568B] shadow-[0_4px_16px_rgba(90,80,160,0.05)] ring-1 ring-[#FFE6EE]" onClick={logout}>
        <LogOut size={17} /> 로그아웃
      </button>

      <div className="mt-8 flex flex-col items-center gap-2.5">
        <p className="text-center text-[12px] text-[#B4B1C2]">Pomong Agent v{version} · Pomong Labs</p>
        <img src="/pomong-labs-logo.png" alt="Pomong Labs" className="h-5 w-auto opacity-80" draggable={false} />
      </div>
    </div>
  );
}
