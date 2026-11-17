import { NavLink, useLocation } from 'react-router-dom';
import { Activity, LayoutGrid, Lock, MessageCircle } from 'lucide-react';

const tabs = [
  { to: '/', label: 'Chat', icon: MessageCircle, end: true },
  { to: '/monitor', label: 'Monitor', icon: Activity },
  { to: '/vault', label: 'Vault', icon: Lock },
  { to: '/more', label: 'More', icon: LayoutGrid },
];

export default function MobileTabBar() {
  const location = useLocation();
  const moreActive = ['/more', '/tasks', '/settings'].includes(location.pathname);

  return (
    <nav className="pointer-events-none sticky bottom-0 z-20 w-full pb-safe lg:hidden">
      <div className="pointer-events-auto mx-3 mb-1 flex items-stretch justify-between rounded-[26px] border border-[#F1EFF8] bg-white/95 px-2 py-2 shadow-[0_-6px_24px_rgba(90,80,160,0.08)] backdrop-blur">
        {tabs.map((tab) => {
          const active = tab.to === '/more' ? moreActive : tab.end ? location.pathname === '/' : location.pathname.startsWith(tab.to);
          return (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={`flex flex-1 flex-col items-center gap-1 rounded-[20px] py-2 text-[11px] font-medium transition ${
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
