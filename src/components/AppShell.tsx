import { useLocation, NavLink, Outlet } from 'react-router-dom';
import { Activity, AlarmClock, FolderOpen, Globe, ListChecks, Lock, MessageCircle, Settings as SettingsIcon } from 'lucide-react';
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
  { to: '/automation', label: t.nav.automation, icon: AlarmClock },
  { to: '/files', label: t.nav.files, icon: FolderOpen },
  { to: '/browser', label: t.nav.browser, icon: Globe },
  { to: '/settings', label: t.nav.settings, icon: SettingsIcon },
];

export default function AppShell() {
  const { profile, keyboardOpen, immersive } = useAppStore();
  const location = useLocation();
  const onChat = location.pathname === '/';

  return (
    <div
      className={`pa-app-shell fixed inset-x-0 top-0 w-full bg-[#F6F6FA] lg:p-4 ${keyboardOpen ? '' : 'bottom-0'}`}
      style={{
        // v0.6.11: 평상시에는 `bottom-0`(inset)으로 **화면 물리적 맨 아래까지** 꽉 채운다.
        // v0.6.10까지는 늘 height:var(--app-height)(= visualViewport.height)를 썼는데, iOS PWA에서
        // 이 값이 실제 화면 높이보다 ~30px 짧아 하단 탭바 아래로 빈 공간이 붕 떠 보였다(IMG_3645).
        // 키보드가 올라온 때만 보이는 영역 높이를 그대로 써서 키보드 위에 붙인다.
        ...(keyboardOpen ? { height: 'var(--app-height, 100%)' } : null),
        background: 'var(--pa-bg)',
        // v0.6.7: 키보드가 화면을 밀어 올린 만큼(visualViewport.offsetTop) 셸을 따라 올리는 transform은
        // `html.pa-shifted`일 때만 CSS(index.css)가 건다. 오프셋이 0인 평상시에 transform을 걸어 두면
        // iOS PWA의 fixed 뷰포트가 상태바와 어긋나 흰 띠가 드러나기 때문이다.
      }}
    >
      <div
        className="mx-auto flex h-full w-full max-w-[1600px] overflow-hidden bg-white lg:rounded-[30px] lg:shadow-soft"
        style={{ background: 'var(--pa-surface)' }}
      >
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

        <main
          className="relative flex min-w-0 flex-1 flex-col bg-[#FCFCFE]"
          style={{
            // v0.6.7: 본문 배경과 상태바 영역을 **같은 단일 색**으로 칠한다.
            // v0.6.6까지는 상태바 아래 60px에 걸쳐 표면색으로 넘어가는 그라데이션이 있어,
            // 경계 위치에 따라 미세한 색 띠가 보일 수 있었다(IMG_3637). 이제 그라데이션 없이 한 색이다.
            background: 'var(--pa-surface)',
          }}
        >
          <div
            className="flex min-h-0 flex-1 flex-col"
            style={{
              // v0.6.3: 다크모드 상단 상태바(노치) 아래로 내용이 들어가도 흰 띠가 생기지 않게
              paddingTop: 'env(safe-area-inset-top)',
              ...(onChat && keyboardOpen ? { paddingTop: 0 } : null),
            }}
          >
            {/* v0.6.3: 화면 이동에 부드러운 페이드·슬라이드 전환 */}
            <div key={location.pathname} className="pa-screen-in flex min-h-0 flex-1 flex-col">
              <Outlet context={{ profile: { nickname: profile.nickname, agentName: profile.agentName } } satisfies ShellContext} />
            </div>
          </div>
          {/* v0.6.4: 브라우저 VNC 전체화면처럼 화면을 다 쓰는 동안은 하단 탭바를 숨긴다 */}
          {immersive ? null : <MobileTabBar />}
        </main>
      </div>
    </div>
  );
}
