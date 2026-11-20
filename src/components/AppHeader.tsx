import { Menu, MoreVertical, RotateCcw, Search } from 'lucide-react';
import MascotFace from './MascotFace';
import { AGENT_STATE_META, type AgentState, useAppStore } from '../lib/store';

/**
 * 채팅 상단바 (v0.6.5 피클 스타일 플로팅 → v0.6.6 크기·간격 다듬기)
 *
 * 상단바는 채팅 스크롤 영역 위에 겹쳐 뜨고(overlay), 맨 위만 페이드 그라데이션을 준다.
 *
 *   좌: 반투명 유리 원형 ☰   가운데: 캐릭터 + 이름 + 상태 배지   우: 유리 캡슐(🔍 | ⋮)
 *
 * v0.6.6에서 바꾼 것
 * - 캐릭터를 76px → 48px(키보드 34px)로 한 단계 줄여 아래 말풍선을 덜 가린다.
 * - 아이콘–이름–배지 세로 간격을 6·4px로 좁혀 헤더 전체 높이를 슬림하게 만들었다.
 * - 페이드의 불투명 구간을 이름·배지가 끝나는 높이까지 넉넉히 덮어, 뒤쪽 말풍선 글씨가
 *   이름·배지 뒤로 비쳐 보이지 않게 했다.
 * - 페이드 시작색은 본문 배경과 같은 `--pa-surface`(= 상태바 색)라 위아래 색 경계가 보이지 않는다.
 *
 * - 좌우 버튼은 `absolute` 로 두어 가운데(캐릭터·이름·배지)가 화면 정중앙에 온다.
 * - 헤더 전체는 `pointer-events-none` 이라 그 위에서도 채팅 스크롤이 그대로 먹고,
 *   버튼·캡슐만 `pointer-events-auto` 로 클릭을 받는다.
 */

/** 배지가 바뀔 때 크로스페이드할 상태 순서 (모든 상태를 같은 칸에 겹쳐 둔다) */
const STATE_ORDER: AgentState[] = ['idle', 'thinking', 'working', 'responding', 'error'];

/**
 * 헤더가 덮는 높이(px). Chat이 첫 메시지 위쪽 여백으로 쓴다.
 * 배지 아래 끝(약 110px)보다 조금 더 두어 첫 말풍선이 배지에 붙지 않게 한다.
 */
export const HEADER_SPACE = { normal: 122, compact: 86 };

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
  const { profile, visibleState, keyboardOpen } = useAppStore();
  const meta = AGENT_STATE_META[visibleState];
  const compact = keyboardOpen;
  // v0.6.6: 76px → 48px. 캐릭터가 말풍선을 가리지 않을 만큼만 남긴다.
  const avatar = compact ? 34 : 48;
  const buttonSize = compact ? 32 : 36;
  const sideTop = (avatar - buttonSize) / 2;
  const busy = visibleState === 'thinking' || visibleState === 'working' || visibleState === 'responding';
  // 페이드: 배지가 끝나는 지점까지 불투명, 그 아래로 서서히 투명
  const fadeSolid = compact ? 70 : 112;
  const fadeHeight = compact ? 108 : 168;

  return (
    <header className="pointer-events-none absolute inset-x-0 top-0 z-30">
      {/* 상단 페이드 — 맨 위는 본문 배경·상태바와 같은 색(--pa-surface), 아래로 갈수록 투명해져
          메시지가 스며들 듯 사라진다. 이름·배지가 끝나는 높이까지는 불투명하게 덮는다. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: fadeHeight,
          background: `linear-gradient(to bottom, var(--pa-surface) 0px, var(--pa-surface) ${fadeSolid}px, transparent ${fadeHeight}px)`,
        }}
        aria-hidden
      />

      <div className={`relative mx-auto w-full max-w-[880px] ${compact ? 'pb-1 pt-1' : 'pb-1.5 pt-2'}`}>
        <div className="relative flex items-start justify-center px-3 lg:px-4">
          {/* 좌측: 대화방 드로어 (반투명 유리 원형 버튼) */}
          <div className="absolute left-3 lg:left-4" style={{ top: sideTop }}>
            <button
              type="button"
              className="pa-glass pointer-events-auto flex items-center justify-center rounded-full active:scale-95"
              style={{ width: buttonSize, height: buttonSize, color: 'var(--pa-ink)' }}
              onClick={onMenu}
              aria-label="대화방 목록"
              title="대화방 목록"
            >
              <Menu size={compact ? 16 : 18} />
            </button>
          </div>

          {/* 우측: 검색 · 더보기 (하나의 유리 캡슐) */}
          <div className="absolute right-3 lg:right-4" style={{ top: sideTop }}>
            <div
              className="pa-glass pointer-events-auto flex items-center overflow-hidden rounded-full"
              style={{ height: buttonSize, color: 'var(--pa-ink)' }}
            >
              {onSearch ? (
                <button
                  type="button"
                  className="flex items-center justify-center transition active:scale-95"
                  style={{ width: buttonSize, height: buttonSize }}
                  onClick={onSearch}
                  aria-label="메시지 검색"
                  title="메시지 검색"
                >
                  <Search size={compact ? 15 : 17} />
                </button>
              ) : null}
              {onSearch ? <span className="h-3.5 w-px shrink-0" style={{ background: 'var(--pa-line)' }} /> : null}
              {/* v0.6.5: 대화 비우기는 넓은 화면에서만 캡슐 안에 함께 둔다(모바일은 대화방 드로어에 있다) */}
              {onClear ? (
                <>
                  <button
                    type="button"
                    className="hidden items-center justify-center transition active:scale-95 sm:flex"
                    style={{ width: buttonSize, height: buttonSize }}
                    onClick={onClear}
                    aria-label="대화 비우기"
                    title="이 대화 비우기"
                  >
                    <RotateCcw size={compact ? 14 : 16} />
                  </button>
                  <span className="hidden h-3.5 w-px shrink-0 sm:block" style={{ background: 'var(--pa-line)' }} />
                </>
              ) : null}
              <button
                type="button"
                className="flex items-center justify-center transition active:scale-95"
                style={{ width: buttonSize, height: buttonSize }}
                onClick={onMore}
                aria-label="더보기"
                title="더보기"
              >
                <MoreVertical size={compact ? 16 : 18} />
              </button>
            </div>
          </div>

          {/* 가운데: 캐릭터 → 이름 → 상태 배지 (간격은 타이트하게) */}
          <div className="flex min-w-0 flex-col items-center">
            <div className="relative shrink-0" style={{ width: avatar, height: avatar }}>
              {/* 바깥의 은은한 원형 링 */}
              <span
                className="pointer-events-none absolute rounded-full border"
                style={{
                  inset: compact ? -3 : -4,
                  borderColor: 'color-mix(in srgb, var(--pa-line) 45%, transparent)',
                }}
                aria-hidden
              />
              <div
                className="relative flex h-full w-full items-center justify-center rounded-full"
                style={{
                  background:
                    'radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--pa-surface-3) 92%, var(--pa-line)) 0%, var(--pa-surface) 78%)',
                  boxShadow:
                    '0 0 0 1px color-mix(in srgb, var(--pa-line) 90%, transparent), 0 6px 16px rgba(90,80,160,0.14)',
                }}
              >
                <MascotFace character={profile.character} state={visibleState} size={Math.round(avatar * 0.86)} />
              </div>
              {/* 상태 점 — 배지와 함께 색이 부드럽게 바뀐다 */}
              <span
                className="absolute rounded-full transition-colors duration-300 ease-out"
                style={{
                  width: compact ? 11 : 14,
                  height: compact ? 11 : 14,
                  right: compact ? 0 : -1,
                  bottom: compact ? 0 : -1,
                  background: meta.dot,
                  boxShadow: '0 0 0 2.5px var(--pa-surface)',
                }}
                aria-hidden
              />
            </div>

            <h1
              className={`max-w-[54vw] truncate text-center font-bold tracking-[-0.01em] sm:max-w-[220px] ${
                compact ? 'mt-0.5 text-[12.5px]' : 'mt-1.5 text-[15px]'
              }`}
              style={{ color: 'var(--pa-ink-strong)' }}
            >
              {profile.agentName || 'Pomong'}
            </h1>

            {/* 상태 배지 — 대기 중 ↔ 작업 중이 부드럽게 크로스페이드된다 */}
            <div
              className={`relative flex min-w-0 items-center justify-center rounded-full transition-all duration-300 ease-out ${
                compact ? 'mt-0.5 gap-1 px-2 py-[1px]' : 'mt-1 gap-1.5 px-2.5 py-[2px]'
              }`}
              style={{ background: meta.bg, color: meta.text }}
              aria-live="polite"
            >
              <span
                className={`shrink-0 rounded-full transition-colors duration-300 ease-out ${busy ? 'animate-pulse' : ''}`}
                style={{ width: compact ? 5 : 6, height: compact ? 5 : 6, background: meta.dot }}
                aria-hidden
              />
              <span className="relative grid place-items-center">
                {STATE_ORDER.map((id) => (
                  <span
                    key={id}
                    className={`col-start-1 row-start-1 whitespace-nowrap font-bold leading-none transition-all duration-300 ease-out ${
                      compact ? 'text-[10px]' : 'text-[11.5px]'
                    } ${id === visibleState ? 'translate-y-0 opacity-100' : 'translate-y-[3px] opacity-0'}`}
                    aria-hidden={id !== visibleState}
                  >
                    {AGENT_STATE_META[id].label}
                  </span>
                ))}
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
