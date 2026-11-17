import { MoreVertical, RotateCcw } from 'lucide-react';
import MascotFace from './MascotFace';
import { AGENT_STATE_META, useAppStore } from '../lib/store';

export default function AppHeader({ onClear, onMore }: { onClear?: () => void; onMore?: () => void }) {
  const { profile, visibleState, agent, keyboardOpen } = useAppStore();
  const meta = AGENT_STATE_META[visibleState];
  const detailText =
    visibleState === 'working' && agent.detail
      ? agent.detail.replace(/_/g, ' ')
      : visibleState === 'thinking'
        ? '잠시만 기다려 주세요'
        : '';

  return (
    <header
      className={`flex items-center gap-3 border-b border-[#F4F2FA] bg-[#FCFCFE]/95 px-4 backdrop-blur transition-all lg:gap-4 lg:px-10 ${
        keyboardOpen ? 'py-2' : 'py-3 lg:py-5'
      }`}
    >
      <div className="relative shrink-0">
        <div
          className={`flex items-center justify-center rounded-full bg-white shadow-[0_6px_18px_rgba(120,100,200,0.14)] ring-1 ring-[#F4F0FF] transition-all ${
            keyboardOpen ? 'h-10 w-10' : 'h-[50px] w-[50px] lg:h-[58px] lg:w-[58px]'
          }`}
        >
          <MascotFace character={profile.character} state={visibleState} size={keyboardOpen ? 30 : 38} className="lg:hidden" />
          <MascotFace character={profile.character} state={visibleState} size={44} className="hidden lg:block" />
        </div>
        <span
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white transition-colors"
          style={{ background: meta.dot }}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[20px] font-bold tracking-[-0.02em] lg:text-[25px]">{profile.agentName || 'Pomong'}</h1>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold lg:text-[13.5px]">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 ${visibleState === 'thinking' || visibleState === 'working' ? 'animate-pulse' : ''}`}
            style={{ background: meta.bg, color: meta.text }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} />
            {meta.label}
          </span>
          {detailText ? <span className="truncate font-medium text-[#A8A5B8]">{detailText}</span> : null}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {onClear ? (
          <button className="rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF]" onClick={onClear} aria-label="대화 지우기">
            <RotateCcw size={19} />
          </button>
        ) : null}
        <button className="rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF]" onClick={onMore} aria-label="더보기">
          <MoreVertical size={20} />
        </button>
      </div>
    </header>
  );
}
