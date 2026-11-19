import { Menu, MoreVertical, RotateCcw, Search } from 'lucide-react';
import MascotFace from './MascotFace';
import { AGENT_STATE_META, useAppStore } from '../lib/store';

/**
 * 채팅 상단바 (v0.5.4)
 *
 * 캐릭터 아이콘을 **화면 가운데**로 옮기고, 그 아래에 AI 이름 → 그 아래에 상태표시
 * (작업 중·생각 중 등)를 세로로 깔끔하게 쌓았다. 왼쪽 위에는 대화방 목록을 여는
 * 햄버거(☰) 버튼, 오른쪽에는 메시지 검색·더보기 버튼이 있다.
 */
export default function AppHeader({
  onMenu,
  onSearch,
  onClear,
  onMore,
}: {
  onMenu?: () => void;
  onSearch?: () => void;
  onClear?: () => void;
  onMore?: () => void;
}) {
  const { profile, visibleState, agent, keyboardOpen, sessions, activeSession } = useAppStore();
  const meta = AGENT_STATE_META[visibleState];
  const detailText =
    visibleState === 'working' && agent.detail
      ? agent.detail.replace(/_/g, ' ')
      : visibleState === 'thinking'
        ? '잠시만 기다려 주세요'
        : '';
  const room = sessions.find((s) => s.id === activeSession);
  const roomLabel = room && sessions.length > 1 ? room.title : '';

  return (
    <header
      className={`relative flex items-center gap-2 border-b border-[#F4F2FA] bg-[#FCFCFE]/95 px-3 backdrop-blur transition-all lg:px-6 ${
        keyboardOpen ? 'py-1.5' : 'py-2.5 lg:py-3'
      }`}
    >
      {/* 좌측: 대화방 드로어 */}
      <button
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[#6B677A] transition hover:bg-[#F7F5FF]"
        onClick={onMenu}
        aria-label="대화방 목록"
        title="대화방 목록"
      >
        <Menu size={21} />
      </button>

      {/* 가운데: 캐릭터 → AI 이름 → 상태 */}
      <div className="pointer-events-none flex min-w-0 flex-1 flex-col items-center">
        <div className="relative shrink-0">
          <div
            className={`flex items-center justify-center rounded-full bg-white shadow-[0_6px_18px_rgba(120,100,200,0.14)] ring-1 ring-[#F4F0FF] transition-all ${
              keyboardOpen ? 'h-9 w-9' : 'h-11 w-11 lg:h-12 lg:w-12'
            }`}
          >
            <MascotFace character={profile.character} state={visibleState} size={keyboardOpen ? 26 : 32} />
          </div>
          <span
            className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white transition-colors"
            style={{ background: meta.dot }}
          />
        </div>
        <h1
          className={`mt-1 max-w-[190px] truncate text-center font-bold leading-none tracking-[-0.01em] ${
            keyboardOpen ? 'text-[13px]' : 'text-[15px] lg:text-[16px]'
          }`}
        >
          {profile.agentName || 'Pomong'}
        </h1>
        <div className="mt-1 flex max-w-[240px] min-w-0 items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-[2px] text-[10.5px] font-semibold ${
              visibleState === 'thinking' || visibleState === 'working' ? 'animate-pulse' : ''
            }`}
            style={{ background: meta.bg, color: meta.text }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.dot }} />
            {meta.label}
          </span>
          {detailText ? (
            <span className="truncate text-[10.5px] font-medium text-[#A8A5B8]">{detailText}</span>
          ) : roomLabel ? (
            <span className="truncate text-[10.5px] font-medium text-[#B4B1C2]">{roomLabel}</span>
          ) : null}
        </div>
      </div>

      {/* 우측: 검색·비우기·더보기 */}
      <div className="flex shrink-0 items-center gap-0.5">
        {onSearch ? (
          <button
            className="rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF]"
            onClick={onSearch}
            aria-label="메시지 검색"
            title="메시지 검색"
          >
            <Search size={19} />
          </button>
        ) : null}
        {onClear ? (
          <button
            className="hidden rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF] sm:block"
            onClick={onClear}
            aria-label="대화 비우기"
            title="이 대화 비우기"
          >
            <RotateCcw size={18} />
          </button>
        ) : null}
        <button
          className="rounded-xl p-2.5 text-[#6B677A] transition hover:bg-[#F7F5FF]"
          onClick={onMore}
          aria-label="더보기"
        >
          <MoreVertical size={20} />
        </button>
      </div>
    </header>
  );
}
