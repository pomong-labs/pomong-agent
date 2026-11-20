import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, ChevronLeft, KeyRound, MoreHorizontal, Sparkles, X } from 'lucide-react';
import { useAppStore } from '../lib/store';

const PROVIDER_LABEL: Record<string, string> = { gemini: 'Gemini', openai: 'GPT', claude: 'Claude', exaone: 'EXAONE' };

/** 모델 이름 끝의 짧은 표기(k-exaone_v2.5 → 2.5) */
function modelHint(id: string): string {
  if (/^k-exaone_v/i.test(id)) return id.replace(/^k-exaone_v/i, '');
  return id.split('-').slice(-1)[0];
}

function modelLabel(models: Record<string, string> | undefined, id: string): string {
  return models?.[id] || id.replace(/^gemini-/, '').replace(/-/g, ' ');
}

/**
 * 모델 선택 바 (v0.6.4)
 *
 * - 칩은 절대 두 줄로 접히지 않는다. 항상 한 줄(`flex-nowrap`)이고 넘치면 가로 스크롤.
 * - 평소에는 지금 쓰는 모델만 컴팩트하게 보이고, `⋯`를 누르면 나머지 칩이 오른쪽으로 펼쳐진다.
 *   다시 누르면 접힌다(지금 쓰는 칩만 남는다).
 * - 모델 목록 팝업은 칩의 스크롤 영역 밖(바 루트)에 그려 잘리지 않게 한다.
 */
export default function ModelBar() {
  const { models, selectModel } = useAppStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const [menuX, setMenuX] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; needsKey: boolean } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chipRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  /** 펼친 상태에서 다른 모델을 고르면 다시 컴팩트하게 접는다. */
  useLayoutEffect(() => {
    if (open) setExpanded(true);
  }, [open]);

  const active = models?.active;
  const providers = models?.providers || [];
  /** 펼치지 않았을 때는 지금 쓰는 AI 칩 하나만 보여 준다. */
  const visible = expanded || !active ? providers : providers.filter((p) => p.id === active.provider);
  const hiddenCount = Math.max(0, providers.length - visible.length);

  const openMenu = (providerId: string) => {
    const chip = chipRefs.current[providerId];
    const wrap = wrapRef.current;
    if (chip && wrap) {
      const chipRect = chip.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      // 팝업 폭(212px)이 화면 밖으로 넘치지 않게 왼쪽 위치를 보정한다.
      const maxX = Math.max(0, wrapRect.width - 216);
      setMenuX(Math.min(maxX, Math.max(0, chipRect.left - wrapRect.left)));
    }
    setOpen((prev) => (prev === providerId ? null : providerId));
  };

  const pick = async (provider: string, model?: string) => {
    setBusy(provider);
    const result = await selectModel(provider, model);
    setBusy(null);
    if (result.ok) {
      setOpen(null);
      setExpanded(false);
      setNotice({ text: `${PROVIDER_LABEL[provider] || provider} · ${modelLabel(models?.labels, model || '')} 로 전환했어요`, needsKey: false });
      return;
    }
    setOpen(null);
    setNotice({ text: result.message || '전환하지 못했어요', needsKey: Boolean(result.needsKey) });
  };

  const openProvider = open ? providers.find((p) => p.id === open) : null;

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-1.5 pb-0.5">
        <span className="flex shrink-0 items-center gap-1 pl-1 pr-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#B4B1C2]">
          <Sparkles size={11} /> 모델
        </span>
        {/* 한 줄 고정 + 가로 스크롤 (절대 줄바꿈하지 않는다) */}
        <div className="no-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto overscroll-x-contain py-0.5">
          {visible.map((provider) => {
            const isActive = active?.provider === provider.id;
            const label =
              provider.id === 'gemini' && isActive
                ? modelLabel(models?.labels, active?.model || '')
                : PROVIDER_LABEL[provider.id] || provider.label;
            return (
              <div
                key={provider.id}
                className="relative shrink-0 animate-pop"
                ref={(el) => {
                  chipRefs.current[provider.id] = el;
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    if (provider.id === 'gemini') {
                      if (!provider.connected) {
                        setNotice({ text: 'Gemini 키가 아직 없어요. 설정에서 연결해 주세요.', needsKey: true });
                        return;
                      }
                      openMenu(provider.id);
                      return;
                    }
                    if (!provider.connected) {
                      setNotice({ text: `${provider.label} 키가 아직 없어요. 설정에서 연결하면 바로 쓸 수 있어요.`, needsKey: true });
                      return;
                    }
                    if (isActive) {
                      openMenu(provider.id);
                      return;
                    }
                    void pick(provider.id, provider.defaultModel);
                  }}
                  disabled={busy === provider.id}
                  className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1.5 text-[12.5px] font-semibold transition ${
                    isActive
                      ? 'border-[#D6C9FF] bg-[#F5F0FF] text-[#7C63F6]'
                      : provider.connected
                        ? 'border-[#EDEAF7] bg-white text-[#6B677A] hover:border-[#DCD4F7]'
                        : 'border-dashed border-[#E7E3F3] bg-[#FBFAFE] text-[#B4B1C2]'
                  }`}
                  title={provider.connected ? `${provider.label} 모델 선택` : `${provider.label} 키 연결 필요`}
                  aria-expanded={open === provider.id}
                >
                  {!provider.connected ? <KeyRound size={11} /> : null}
                  <span className={busy === provider.id ? 'animate-pulse' : ''}>{label}</span>
                  {provider.id === 'gemini' || isActive ? (
                    <ChevronDown size={11} className={open === provider.id ? 'rotate-180 transition' : 'transition'} />
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
        {providers.length > 1 ? (
          <button
            type="button"
            onClick={() => {
              setOpen(null);
              setExpanded((v) => !v);
            }}
            className="flex h-[26px] shrink-0 items-center gap-0.5 rounded-full border border-[#EDEAF7] bg-white px-2 text-[11.5px] font-bold text-[#8A8A9A] transition hover:border-[#DCD4F7] hover:text-[#7C63F6] active:scale-95"
            aria-expanded={expanded}
            aria-label={expanded ? '모델 칩 접기' : '다른 모델 칩 펼치기'}
            title={expanded ? '접기' : hiddenCount > 0 ? `모델 ${hiddenCount}개 더 보기` : '접기'}
          >
            {expanded ? <ChevronLeft size={13} /> : <MoreHorizontal size={14} />}
          </button>
        ) : null}
      </div>

      {openProvider ? (
        <div
          className="absolute bottom-[calc(100%+8px)] z-40 w-[212px] animate-pop overflow-hidden rounded-2xl border border-[#EFEDF6] bg-white p-1.5 shadow-[0_18px_40px_rgba(90,80,160,0.18)] dark:bg-[#232030]"
          style={{ left: menuX }}
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[#B4B1C2]">
            {openProvider.label} 모델
          </p>
          <div className="pa-scroll max-h-[46vh] overflow-y-auto">
            {openProvider.models.map((m) => {
              const selected = active?.provider === openProvider.id && active?.model === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => void pick(openProvider.id, m)}
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium transition ${
                    selected ? 'bg-[#F5F0FF] text-[#7C63F6]' : 'text-[#4B4856] hover:bg-[#FAF9FF]'
                  }`}
                >
                  <span className="truncate">{modelLabel(models?.labels, m)}</span>
                  {selected ? <Check size={14} strokeWidth={3} /> : <span className="shrink-0 text-[10.5px] text-[#C0BCCD]">{modelHint(m)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {notice ? (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 flex w-full max-w-[420px] items-center gap-2 rounded-2xl border border-[#EFEAFB] bg-white px-3 py-2 text-[12.5px] font-medium text-[#5B5866] shadow-[0_12px_30px_rgba(90,80,160,0.14)] dark:bg-[#232030]">
          <span className="min-w-0 flex-1">{notice.text}</span>
          {notice.needsKey ? (
            <button className="shrink-0 rounded-full bg-[#F3EEFF] px-2.5 py-1 text-[11.5px] font-semibold text-[#7C63F6]" onClick={() => navigate('/settings')}>
              설정 열기
            </button>
          ) : null}
          <button className="shrink-0 text-[#B4B1C2]" onClick={() => setNotice(null)} aria-label="닫기">
            <X size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}
