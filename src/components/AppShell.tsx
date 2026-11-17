import { useLocation, NavLink, Outlet } from 'react-router-dom';
import { Activity, ListChecks, Lock, MessageCircle, Settings as SettingsIcon } from 'lucide-react';
import Logo from './Logo';
import MiniStatus from './MiniStatus';
import MobileTabBar from './MobileTabBar';
import { useAppStore } from '../lib/store';
import { t } from '../lib/i18n';

export interface ShellContext {
  profile: { nickname: string; agentName: string };
}

const nav = [
  { to: '/', label: t.nav.chat, icon: MessageCircle, end: true },
  { to: '/monitor', label: t.nav.monitor, icon: Activity },
  { to: '/vault', label: t.nav.vault, icon: Lock },
  { to: '/tasks', label: t.nav.tasks, icon: ListChecks },
  { to: '/settings', label: t.nav.settings, icon: SettingsIcon },
];

export default function AppShell() {
  const { profile, keyboardOpen } = useAppStore();
  const location = useLocation();
  const onChat = location.pathname === '/';

  return (
    <div
      className="fixed inset-x-0 top-0 w-full bg-[#F6F6FA] lg:p-4"
      style={{
        height: 'var(--app-height, 100%)',
        // iOS가 키보드 때문에 화면을 밀어 올린 만큼(visualViewport.offsetTop) 셸도 따라 올린다.
        transform: 'translate3d(var(--app-offset-x, 0px), var(--app-offset, 0px), 0)',
      }}
    >
      <div className="mx-auto flex h-full w-full max-w-[1600px] overflow-hidden bg-white lg:rounded-[30px] lg:shadow-soft">
        <aside className="hidden w-[300px] shrink-0 flex-col border-r border-[#F0EFF6] px-6 py-8 lg:flex">
          <div className="px-1">
            <Logo />
          </div>
          <nav className="mt-10 flex flex-col gap-1.5">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `group flex items-center gap-4 rounded-2xl px-4 py-3.5 text-[17px] font-medium transition ${
                    isActive ? 'bg-[#F1ECFF] text-[#7C63F6]' : 'text-[#4B4856] hover:bg-[#FAF9FF]'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={22} strokeWidth={isActive ? 2.3 : 1.9} />
                    <span>{item.label}</span>
                  </>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto pt-6">
            <MiniStatus />
          </div>
        </aside>

        <main className="relative flex min-w-0 flex-1 flex-col bg-[#FCFCFE]">
          <div
            className="flex min-h-0 flex-1 flex-col"
            style={onChat && keyboardOpen ? { paddingTop: 0 } : undefined}
          >
            <Outlet context={{ profile: { nickname: profile.nickname, agentName: profile.agentName } } satisfies ShellContext} />
          </div>
          <MobileTabBar />
        </main>
      </div>
    </div>
  );
}
