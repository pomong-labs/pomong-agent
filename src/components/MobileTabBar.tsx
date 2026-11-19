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

export default function MobileTabBar() {
  const location = useLocation();
  const moreActive = ['/more', '/tasks', '/settings', '/tools', '/browser', '/files'].includes(location.pathname);

  return (
    <nav className="pa-tabbar z-20 w-full shrink-0 border-t border-[#F1EFF8] bg-white pb-safe lg:hidden">
      <div className="flex items-stretch justify-between px-3 pt-1.5">
        {tabs.map((tab) => {
          const active = tab.to === '/more' ? moreActive : tab.end ? location.pathname === '/' : location.pathname.startsWith(tab.to);
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={`flex flex-1 flex-col items-center gap-1 rounded-[18px] py-2 text-[11px] font-medium transition ${
                active ? 'bg-[#F1ECFF] text-[#7C63F6]' : 'text-[#8A8A9A]'
              }`}
            >
              <tab.icon size={22} strokeWidth={active ? 2.3 : 1.9} />
              <span>{tab.label}</span>
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}
