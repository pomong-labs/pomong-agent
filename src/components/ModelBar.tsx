import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronDown, KeyRound, Sparkles, X } from 'lucide-react';
import { useAppStore } from '../lib/store';

const PROVIDER_LABEL: Record<string, string> = { gemini: 'Gemini', openai: 'GPT', claude: 'Claude' };

function modelLabel(models: Record<string, string> | undefined, id: string): string {
  return models?.[id] || id.replace(/^gemini-/, '').replace(/-/g, ' ');
}

export default function ModelBar() {
  const { models, selectModel } = useAppStore();
  const navigate = useNavigate();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; needsKey: boolean } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  const active = models?.active;
  const providers = models?.providers || [];

  const pick = async (provider: string, model?: string) => {
    setBusy(provider);
    const result = await selectModel(provider, model);
    setBusy(null);
    if (result.ok) {
      setOpen(null);
      setNotice({ text: `${PROVIDER_LABEL[provider] || provider} · ${modelLabel(models?.labels, model || '')} 로 전환했어요`, needsKey: false });
      return;
    }
    setOpen(null);
    setNotice({ text: result.message || '전환하지 못했어요', needsKey: Boolean(result.needsKey) });
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5 pb-0.5">
        <span className="flex items-center gap-1 pl-1 pr-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-[#B4B1C2]">
          <Sparkles size={11} /> 모델
        </span>
        {providers.map((provider) => {
          const isActive = active?.provider === provider.id;
          const label = provider.id === 'gemini' && isActive ? modelLabel(models?.labels, active?.model || '') : PROVIDER_LABEL[provider.id] || provider.label;
          return (
            <div key={provider.id} className="relative">
              <button
                type="button"
                onClick={() => {
                  if (provider.id === 'gemini') {
                    if (!provider.connected) {
                      setNotice({ text: 'Gemini 키가 아직 없어요. 설정에서 연결해 주세요.', needsKey: true });
                      return;
                    }
                    setOpen((prev) => (prev === provider.id ? null : provider.id));
                    return;
                  }
                  if (!provider.connected) {
                    setNotice({ text: `${provider.label} 키가 아직 없어요. 설정에서 연결하면 바로 쓸 수 있어요.`, needsKey: true });
                    return;
                  }
                  if (isActive) {
                    setOpen((prev) => (prev === provider.id ? null : provider.id));
                    return;
                  }
                  void pick(provider.id, provider.defaultModel);
                }}
                disabled={busy === provider.id}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-1.5 text-[12.5px] font-semibold transition ${
                  isActive
                    ? 'border-[#D6C9FF] bg-[#F5F0FF] text-[#7C63F6]'
                    : provider.connected
                      ? 'border-[#EDEAF7] bg-white text-[#6B677A] hover:border-[#DCD4F7]'
                      : 'border-dashed border-[#E7E3F3] bg-[#FBFAFE] text-[#B4B1C2]'
                }`}
                title={provider.connected ? `${provider.label} 모델 선택` : `${provider.label} 키 연결 필요`}
              >
                {!provider.connected ? <KeyRound size={11} /> : null}
                <span className={busy === provider.id ? 'animate-pulse' : ''}>{label}</span>
                {provider.id === 'gemini' || isActive ? <ChevronDown size={11} className={open === provider.id ? 'rotate-180 transition' : 'transition'} /> : null}
              </button>

              {open === provider.id ? (
                <div className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-[212px] animate-pop overflow-hidden rounded-2xl border border-[#EFEDF6] bg-white p-1.5 shadow-[0_18px_40px_rgba(90,80,160,0.18)]">
                  <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-[#B4B1C2]">{provider.label} 모델</p>
                  {provider.models.map((m) => {
                    const selected = isActive && active?.model === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => void pick(provider.id, m)}
                        className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-[13px] font-medium transition ${
                          selected ? 'bg-[#F5F0FF] text-[#7C63F6]' : 'text-[#4B4856] hover:bg-[#FAF9FF]'
                        }`}
                      >
                        <span className="truncate">{modelLabel(models?.labels, m)}</span>
                        {selected ? <Check size={14} strokeWidth={3} /> : <span className="shrink-0 text-[10.5px] text-[#C0BCCD]">{m.split('-').slice(-1)[0]}</span>}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {notice ? (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 flex w-full max-w-[420px] items-center gap-2 rounded-2xl border border-[#EFEAFB] bg-white px-3 py-2 text-[12.5px] font-medium text-[#5B5866] shadow-[0_12px_30px_rgba(90,80,160,0.14)]">
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
