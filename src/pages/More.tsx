import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlarmClock, Brain, ChevronRight, FolderOpen, Globe, LayoutGrid, ListChecks, Lock, LogOut, Settings as SettingsIcon, Wrench } from 'lucide-react';
import Mascot from '../components/Mascot';
import { api } from '../lib/api';

export default function More() {
  const navigate = useNavigate();
  const [version, setVersion] = useState('0.6.0');

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
    { label: '파일함', desc: '받은 파일 · AI 결과물 모아 보기', icon: FolderOpen, to: '/files', tint: '#F1ECFF', color: '#7C63F6' },
    { label: '도구', desc: 'AI가 쓸 수 있는 기능과 예시', icon: Wrench, to: '/tools', tint: '#EAFBF1', color: '#12B886' },
    { label: '할 일', desc: '오늘의 태스크 관리', icon: ListChecks, to: '/tasks', tint: '#EFF7FF', color: '#4A90FF' },
    { label: '자동화', desc: '예약 실행 · 웹 변화 감시', icon: AlarmClock, to: '/automation', tint: '#F1ECFF', color: '#7C63F6' },
    { label: '기억함', desc: 'AI가 기억한 취향·약속 관리', icon: Brain, to: '/memory', tint: '#FFEFF3', color: '#E2568B' },
    { label: '연결된 앱 및 서비스', desc: '깃허브·쿠팡·네이버 등 연결', icon: LayoutGrid, to: '/services', tint: '#EAF6FF', color: '#2F86D8' },
    { label: '브라우저', desc: 'AI가 직접 열고, 로그인은 내가', icon: Globe, to: '/browser', tint: '#EAF6FF', color: '#2F86D8' },
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
        {/* v0.6.3: 라이트/다크에 맞는 로고를 따로 보여 준다(다크모드는 흰색 글자) */}
        <img src="/pomong-labs-logo.png" alt="Pomong Labs" className="h-5 w-auto opacity-90 dark:hidden" draggable={false} />
        <img src="/pomong-labs-logo-dark.png" alt="Pomong Labs" className="hidden h-5 w-auto opacity-90 dark:block" draggable={false} />
      </div>
    </div>
  );
}
