import { NavLink, useLocation } from 'react-router-dom';
import { Activity, AlarmClock, LayoutGrid, Lock, MessageCircle } from 'lucide-react';
import { t } from '../lib/i18n';

const tabs = [
  { to: '/', label: t.nav.chat, icon: MessageCircle, end: true },
  { to: '/monitor', label: t.nav.monitor, icon: Activity },
  { to: '/automation', label: t.nav.automation, icon: AlarmClock },
  { to: '/vault', label: t.nav.vault, icon: Lock },
  { to: '/more', label: t.nav.more, icon: LayoutGrid },
];

/**
 * 하단 탭바 (v0.6.13)
 *
 * v0.6.12까지는 화면 폭 전체를 채우는 도킹형 바(`border-t bg-white`)였다.
 * 이제는 화면 하단 중앙에 **둥근 플로팅 유리 알약**이 떠 있는 형태다.
 *
 * - 배경은 상단바 유리 버튼(☰ · 🔍·⋮ · 이름 배지)과 **같은 `.pa-glass`** 를 쓴다.
 *   (반투명 + 은은한 1px 테두리 + 그림자, 라이트/다크 공통)
 * - `max-w-[460px]` 로 넓은 폰에서도 알약이 지나치게 늘어나지 않게 한다.
 * - 세로 여백은 `.pb-safe` 하나로 관리한다 — 아이폰(세이프 에어리어 34px)에서 16px,
 *   세이프 에어리어가 없는 기기에서 8px 만큼 홈 인디케이터 위로 띄운다.
 * - 이 nav 는 셸의 flex 흐름에 남아(shrink-0) 자기 높이만큼 본문 영역을 줄인다.
 *   그래서 채팅·관제실·자동화·금고·더보기 어디서도 스크롤 끝이 알약에 가리지 않는다.
 * - 키보드가 올라오면(`html.kb-open`) index.css 가 `.pa-tabbar` 를 숨긴다.
 */
export default function MobileTabBar() {
  const location = useLocation();
  const moreActive = ['/more', '/tasks', '/settings', '/tools', '/browser', '/files'].includes(location.pathname);

  return (
    <nav className="pa-tabbar z-20 w-full shrink-0 px-3 pt-0.5 pb-safe lg:hidden">
      <div className="pa-glass pa-tabbar-pill mx-auto flex w-full max-w-[460px] items-center justify-between gap-0.5 rounded-full px-1.5 py-[7px]">
        {tabs.map((tab) => {
          const active = tab.to === '/more' ? moreActive : tab.end ? location.pathname === '/' : location.pathname.startsWith(tab.to);
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={`pa-tab-item flex min-w-0 flex-1 flex-col items-center justify-center gap-[3px] rounded-full py-1.5 text-[10.5px] font-semibold leading-none transition active:scale-[0.96] ${
                active ? 'pa-tab-item-active' : ''
              }`}
            >
              <tab.icon size={21} strokeWidth={active ? 2.3 : 1.9} />
              <span className="max-w-full truncate">{tab.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
