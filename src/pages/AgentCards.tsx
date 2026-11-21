import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Plus,
  QrCode,
  Trash2,
  IdCard,
  Globe,
  Lock,
  MessageSquare,
  Pencil,
  Power,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import Mascot from '../components/Mascot';
import {
  api,
  ApiError,
  type AgentCard,
  type CardPurpose,
  type CollectField,
  type DeliveryMode,
  type GuestSessionView,
} from '../lib/api';

/**
 * v0.7.3 — 더보기 → 에이전트 명함 (주인 화면)
 *
 * v0.7.2의 공개 명함(링크·QR·용도 프리셋·PIN·커스텀 도메인)에 실사용 개선 7가지를 더했다.
 *  · 시트를 풀스크린(z-100)으로 올리고 iOS 세이프 에어리어 안쪽에 붙였다(상단 입력칸·하단 버튼 가림 없음).
 *  · 손님 화면의 '용건·연락 남기기' 시트 대신, 대화가 끝나면 서버가 자동으로 전달한다.
 *  · 응답 방식(대화 완료 시 전달 / 자유 Q&A), 1인 1회, 보관 기간을 명함마다 정한다.
 *  · '이 명함만 쓸 모델'은 연결된 모델만 고르는 드롭다운이다.
 *  · 받은 응답은 상태·시각·턴·요약·항목 표로 한눈에 보고, 전체 대화는 접었다 편다.
 */

interface PurposeMeta {
  id: CardPurpose;
  label: string;
  hint: string;
  examplePrompt: string;
}

interface DeliveryModeMeta {
  id: DeliveryMode;
  label: string;
  hint: string;
}

interface ModelOption {
  value: string;
  model: string;
  label: string;
}

interface ModelGroup {
  provider: string;
  label: string;
  defaultModel: string;
  models: ModelOption[];
}

interface ModelsResponse {
  active: { provider: string; model: string; label: string };
  groups: ModelGroup[];
}

interface CardForm {
  id: string | null;
  title: string;
  slug: string;
  purpose: CardPurpose;
  bioText: string;
  systemGuide: string;
  quickPrompts: string[];
  collectFields: CollectField[];
  deliveryMode: DeliveryMode;
  oncePerVisitor: boolean;
  retentionDays: number;
  customDomain: string;
  pin: string;
  pinEnabled: boolean;
  maxTurnsPerSession: number;
  dailyLimit: number;
  modelOverride: string;
  expiresAt: string;
  enabled: boolean;
}

const RETENTION_LABELS: Record<number, string> = {
  0: '영구 보관',
  7: '7일',
  14: '14일',
  30: '30일',
  90: '90일',
  180: '180일',
  365: '1년',
};

const PRESETS: Record<CardPurpose, { bioText: string; systemGuide: string; quickPrompts: string[]; collectFields: CollectField[] }> = {
  intro: {
    bioText: '안녕하세요! 제 소개와 하는 일을 편하게 물어보세요.',
    systemGuide:
      '이 명함은 소개·질문 응대용입니다. 소개문에 적힌 내용만 근거로 답하고, 더 깊은 이야기나 협업 문의는 대화에서 받을 항목을 물어 정리하세요.',
    quickPrompts: ['자기소개 해줘', '요즘 어떤 일을 하고 있어?'],
    collectFields: [
      { key: 'name', label: '이름', kind: 'text', required: false, hint: '닉네임도 괜찮아요' },
      { key: 'contact', label: '연락처', kind: 'text', required: false, hint: '이메일이나 전화번호' },
    ],
  },
  meeting: {
    bioText: '미팅 일정을 조율해 드려요. 가능한 시간대를 안내하고, 원하시는 일정을 여쭤볼게요.',
    systemGuide:
      '이 명함은 미팅 일정 조율용입니다. 아래 "가능한 시간대"에 적힌 범위 안에서만 안내하세요. 약속을 확정하지 말고 "주인에게 전달하겠다"고 말한 뒤, 희망 일시·이름·연락처를 대화로 물어보세요.\n\n가능한 시간대: 평일 오후 7시 이후, 주말 오후 (정확한 일정은 주인이 확인 후 회신)',
    quickPrompts: ['미팅 가능한 시간 알려줘', '어떤 방식으로 진행돼?'],
    collectFields: [
      { key: 'name', label: '이름', kind: 'text', required: true },
      { key: 'contact', label: '연락처', kind: 'text', required: true, hint: '회신받을 이메일·전화번호' },
      { key: 'schedule', label: '희망 일시', kind: 'text', required: false, hint: '예: 다음 주 화요일 오후 3시' },
    ],
  },
  survey: {
    bioText: '짧은 설문에 참여해 주세요. 몇 가지만 여쭤보고 답을 정리해 전달받아요.',
    systemGuide:
      '이 명함은 대화형 설문용입니다. 한 번에 질문 하나씩 자연스럽게 물어보세요. 아래 받을 항목의 질문을 모두 들으면 답을 정리해 마무리하세요. 답을 유도하거나 평가하지 말고 사실만 정리하세요.',
    quickPrompts: ['설문 시작할게요', '질문이 몇 개예요?'],
    collectFields: [
      { key: 'name', label: '이름(또는 닉네임)', kind: 'text', required: false },
      { key: 'contact', label: '연락처', kind: 'text', required: false },
      { key: 'answer1', label: '가장 만족스러웠던 점', kind: 'longtext', required: false },
      { key: 'answer2', label: '개선하면 좋을 점', kind: 'longtext', required: false },
    ],
  },
  custom: {
    bioText: '궁금한 점을 편하게 물어보세요.',
    systemGuide: '안내 지침에 적힌 범위에서만 답하고, 그 밖의 요청은 정중히 거절하세요.',
    quickPrompts: ['무엇을 도와줄 수 있어?', '자세히 알려줘'],
    collectFields: [
      { key: 'name', label: '이름', kind: 'text', required: false },
      { key: 'contact', label: '연락처', kind: 'text', required: false },
    ],
  },
};

function blankForm(): CardForm {
  const preset = PRESETS.intro;
  return {
    id: null,
    title: '',
    slug: '',
    purpose: 'intro',
    bioText: preset.bioText,
    systemGuide: preset.systemGuide,
    quickPrompts: [...preset.quickPrompts],
    collectFields: preset.collectFields.map((field) => ({ ...field })),
    deliveryMode: 'collect',
    oncePerVisitor: false,
    retentionDays: 30,
    customDomain: '',
    pin: '',
    pinEnabled: false,
    maxTurnsPerSession: 20,
    dailyLimit: 100,
    modelOverride: '',
    expiresAt: '',
    enabled: true,
  };
}

function formOf(card: AgentCard): CardForm {
  return {
    id: card.id,
    title: card.title,
    slug: card.slug,
    purpose: card.purpose,
    bioText: card.bioText,
    systemGuide: card.systemGuide,
    quickPrompts: [...card.quickPrompts],
    collectFields: card.collectFields.map((field) => ({ ...field })),
    deliveryMode: card.deliveryMode,
    oncePerVisitor: card.oncePerVisitor,
    retentionDays: card.retentionDays,
    customDomain: card.customDomain || '',
    pin: '',
    pinEnabled: card.pinRequired,
    maxTurnsPerSession: card.maxTurnsPerSession,
    dailyLimit: card.dailyLimit,
    modelOverride: card.modelOverride || '',
    expiresAt: card.expiresAt ? card.expiresAt.slice(0, 10) : '',
    enabled: card.enabled,
  };
}

export default function AgentCards() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [cards, setCards] = useState<AgentCard[]>([]);
  const [purposes, setPurposes] = useState<PurposeMeta[]>([]);
  const [deliveryModes, setDeliveryModes] = useState<DeliveryModeMeta[]>([]);
  const [retentionChoices, setRetentionChoices] = useState<number[]>([7, 30, 90, 180, 365, 0]);
  const [modelGroups, setModelGroups] = useState<ModelGroup[]>([]);
  const [activeModelLabel, setActiveModelLabel] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState<CardForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [copied, setCopied] = useState('');
  const [qr, setQr] = useState<{ url: string; dataUrl: string; card: string } | null>(null);
  const [openSessions, setOpenSessions] = useState('');
  const [sessions, setSessions] = useState<GuestSessionView[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  /** 알림 딥링크(?card=)로 들어오면 그 명함의 대화를 바로 펼친다 */
  const deepLinkDone = useRef(false);
  /** 어느 명함의 받은 응답을 펼쳐 두었는지(SSE 로 그 명함만 다시 불러오기 위해) */
  const openSessionsRef = useRef('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{
        cards: AgentCard[];
        purposes: PurposeMeta[];
        deliveryModes?: DeliveryModeMeta[];
        retentionChoices?: number[];
      }>('/api/agent-cards');
      setCards(res.cards);
      setPurposes(res.purposes || []);
      if (res.deliveryModes?.length) setDeliveryModes(res.deliveryModes);
      if (res.retentionChoices?.length) setRetentionChoices(res.retentionChoices);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '명함 목록을 불러오지 못했어요.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<ModelsResponse>('/api/agent-cards/models')
      .then((res) => {
        setModelGroups(res.groups || []);
        setActiveModelLabel(res.active?.label || '');
      })
      .catch(() => {
        // 모델 목록을 못 받아도 명함 편집은 그대로 쓸 수 있다(기본 모델 사용).
        setModelGroups([]);
      });
  }, [load]);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      setCopied('');
    }
  };

  const toggle = async (card: AgentCard) => {
    setBusyId(card.id);
    try {
      await api.put(`/api/agent-cards/${card.id}`, { enabled: !card.enabled });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '변경하지 못했어요.');
    } finally {
      setBusyId('');
    }
  };

  const remove = async (card: AgentCard) => {
    setBusyId(card.id);
    try {
      await api.del(`/api/agent-cards/${card.id}`);
      setConfirmDelete('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '삭제하지 못했어요.');
    } finally {
      setBusyId('');
    }
  };

  const showQr = async (card: AgentCard) => {
    setBusyId(card.id);
    try {
      const res = await api.post<{ url: string; dataUrl: string }>(`/api/agent-cards/${card.id}/qr`);
      setQr({ ...res, card: card.title });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'QR을 만들지 못했어요.');
    } finally {
      setBusyId('');
    }
  };

  const loadSessions = async (card: AgentCard) => {
    if (openSessions === card.id) {
      setOpenSessions('');
      openSessionsRef.current = '';
      return;
    }
    setOpenSessions(card.id);
    openSessionsRef.current = card.id;
    setSessionsLoading(true);
    setSessions([]);
    try {
      const res = await api.get<{ sessions: GuestSessionView[] }>(`/api/agent-cards/${card.id}/sessions`);
      setSessions(res.sessions);
      // 상단 '받은 응답 N건'도 함께 최신화한다.
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '대화를 불러오지 못했어요.');
    } finally {
      setSessionsLoading(false);
    }
  };

  /** 펼쳐 둔 받은 응답만 다시 불러온다(새 응답 도착 시) */
  const refreshSessions = useCallback(async (cardId: string) => {
    try {
      const res = await api.get<{ sessions: GuestSessionView[] }>(`/api/agent-cards/${cardId}/sessions`);
      if (openSessionsRef.current === cardId) setSessions(res.sessions);
    } catch {
      /* 다음 이벤트·새로고침에서 다시 시도한다 */
    }
  }, []);

  // v0.7.3: 새 응답(채팅 자동 완료)이 도착하면 탭 이동 없이 목록·카운트를 바로 갱신한다.
  useEffect(() => {
    let source: EventSource | null = null;
    try {
      source = new EventSource('/api/events');
    } catch {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      try {
        const payload = JSON.parse(String(event.data)) as { type?: string; data?: { cardId?: string } };
        const cardId = payload?.data?.cardId;
        if (!cardId) return;
        void load();
        if (openSessionsRef.current === cardId) void refreshSessions(cardId);
      } catch {
        /* 다른 종류의 이벤트는 무시 */
      }
    };
    source.addEventListener('message', onMessage);
    return () => {
      source?.removeEventListener('message', onMessage);
      source?.close();
    };
  }, [load, refreshSessions]);

  // 다른 앱에 다녀오거나 알림에서 돌아온 때도 최신 카운트를 다시 읽는다.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  useEffect(() => {
    if (deepLinkDone.current || !cards.length) return;
    const id = new URLSearchParams(window.location.search).get('card');
    if (!id) return;
    const target = cards.find((card) => card.id === id);
    if (!target) return;
    deepLinkDone.current = true;
    void loadSessions(target);
    window.history.replaceState(null, '', window.location.pathname);
  }, [cards]);

  const save = async () => {
    if (!form || saving) return;
    if (!form.title.trim()) {
      setFormError('명함 이름을 입력해 주세요.');
      return;
    }
    setSaving(true);
    setFormError('');
    const payload = {
      title: form.title.trim(),
      slug: form.slug.trim() || undefined,
      purpose: form.purpose,
      bioText: form.bioText,
      systemGuide: form.systemGuide,
      quickPrompts: form.quickPrompts.map((item) => item.trim()).filter(Boolean),
      collectFields: form.collectFields,
      deliveryMode: form.deliveryMode,
      oncePerVisitor: form.oncePerVisitor,
      retentionDays: form.retentionDays,
      customDomain: form.customDomain.trim() || null,
      pin: form.pinEnabled ? form.pin : null,
      clearPin: !form.pinEnabled,
      maxTurnsPerSession: form.maxTurnsPerSession,
      dailyLimit: form.dailyLimit,
      modelOverride: form.modelOverride.trim() || null,
      expiresAt: form.expiresAt || null,
      enabled: form.enabled,
    };
    try {
      if (form.id) await api.put(`/api/agent-cards/${form.id}`, payload);
      else await api.post('/api/agent-cards', payload);
      setForm(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '저장하지 못했어요.');
    } finally {
      setSaving(false);
    }
  };

  const applyPurpose = (purpose: CardPurpose) => {
    if (!form) return;
    const preset = PRESETS[purpose];
    setForm({
      ...form,
      purpose,
      bioText: preset.bioText,
      systemGuide: preset.systemGuide,
      quickPrompts: [...preset.quickPrompts],
      collectFields: preset.collectFields.map((field) => ({ ...field })),
      // v0.7.3: 대화형 설문 프리셋은 1인 1회 참여가 기본이다.
      oncePerVisitor: purpose === 'survey' ? true : form.oncePerVisitor,
    });
  };

  const stats = useMemo(() => {
    const live = cards.filter((card) => card.enabled).length;
    // 전달하지 않는(qna_only) 명함의 대화는 '받은 응답'에 세지 않는다.
    const total = cards
      .filter((card) => card.deliveryMode !== 'qna_only')
      .reduce((sum, card) => sum + (card.submittedCount || 0), 0);
    const conversations = cards.reduce((sum, card) => sum + (card.sessions || 0), 0);
    return { live, sessions: total, conversations };
  }, [cards]);

  return (
    <div className="pa-scroll h-full min-h-0 overflow-y-auto px-4 pb-10 pt-5 lg:px-8">
      <div className="mx-auto w-full max-w-[900px]">
        <header className="flex items-center gap-2">
          <button
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl transition hover:bg-[#F7F5FF] dark:hover:bg-[#232030]"
            style={{ color: 'var(--pa-mute)' }}
            onClick={() => navigate('/more')}
            aria-label="뒤로"
          >
            <ArrowLeft size={20} />
          </button>
          <Mascot name="poding" size={44} className="hidden shrink-0 lg:block" />
          <div className="min-w-0 flex-1">
            <h1 className="text-[22px] font-bold tracking-[-0.02em] lg:text-[26px]" style={{ color: 'var(--pa-ink-strong)' }}>
              에이전트 명함
            </h1>
            <p className="text-[12.5px]" style={{ color: 'var(--pa-mute)' }}>
              손님에게 건넬 공개 명함 {cards.length}개 · 응대 중 {stats.live}개 · 받은 응답 {stats.sessions}건
            </p>
          </div>
          <button className="pa-btn-primary shrink-0 px-4 py-2.5 text-[13.5px]" onClick={() => setForm(blankForm())}>
            <Plus size={16} /> 새 명함
          </button>
        </header>

        <section
          className="mt-4 rounded-[20px] px-4 py-3.5"
          style={{ background: 'var(--accent-soft-weak)', border: '1px solid var(--accent-line-soft)' }}
        >
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-ink)' }}>
            공개 명함은 <b>로그인 없이</b> 열리는 손님 전용 대화 화면이에요. 손님에게는 이 명함에 적은 소개·지침만 보이고,
            기억·금고·메일·파일·브라우저·쉘은 <b>아예 연결되지 않습니다</b>. 대화에서 받을 항목을 다 들으면 AI가 정리해{' '}
            <b>주인에게 자동으로 전달</b>하고, 손님 화면은 입력이 잠겨요. 전달이 필요 없는 명함은 <b>자유 Q&amp;A</b>로 두면 됩니다.
            주소를 숨기고 싶으면 커스텀 도메인(예: <code>card.example.com</code>)을 연결하면 그 도메인에서는 공개 명함만 열리고 관리
            화면은 전부 404로 막혀요.
          </p>
        </section>

        {error ? (
          <p className="mt-3 rounded-xl bg-[#FFF1F1] px-3 py-2 text-[12.5px] font-medium text-[#D93A3A]" role="alert">
            {error}
          </p>
        ) : null}

        {loading ? (
          <div className="mt-10 flex flex-col items-center gap-3">
            <Loader2 size={22} className="animate-spin" style={{ color: 'var(--accent)' }} />
            <p className="text-[13px]" style={{ color: 'var(--pa-mute)' }}>
              명함을 불러오는 중…
            </p>
          </div>
        ) : cards.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-3 text-center">
            <Mascot name="pimong" size={92} className="animate-float" />
            <h2 className="text-[17px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
              아직 만든 명함이 없어요
            </h2>
            <p className="max-w-[360px] text-[13px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
              자기소개, 미팅 일정, 대화형 설문 중 골라서 첫 명함을 만들어 보세요. 링크 하나로 손님 응대를 맡길 수 있어요.
            </p>
            <button className="pa-btn-primary mt-1 px-5 py-3" onClick={() => setForm(blankForm())}>
              <Plus size={16} /> 첫 명함 만들기
            </button>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {cards.map((card) => (
              <li
                key={card.id}
                className="rounded-[22px] p-4"
                style={{ background: 'var(--pa-surface)', border: '1px solid var(--pa-line-soft)', boxShadow: 'var(--pa-shadow)' }}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}
                  >
                    <IdCard size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-[15.5px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                        {card.title}
                      </h2>
                      <span
                        className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                        style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }}
                      >
                        {purposes.find((item) => item.id === card.purpose)?.label || card.purpose}
                      </span>
                      <span
                        className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                        style={
                          card.deliveryMode === 'qna_only'
                            ? { background: '#EEF3FF', color: '#4B6BB5' }
                            : { background: 'var(--accent-soft)', color: 'var(--accent-ink)' }
                        }
                      >
                        {card.deliveryMode === 'qna_only' ? '자유 Q&A' : '응답 전달'}
                      </span>
                      {card.oncePerVisitor ? (
                        <span className="flex items-center gap-0.5 rounded-full bg-[#F3EEFF] px-2 py-0.5 text-[10.5px] font-bold text-[#7057D6]">
                          <UserCheck size={10} /> 1인 1회
                        </span>
                      ) : null}
                      <span
                        className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                        style={
                          card.enabled
                            ? { background: '#EAFBF1', color: '#0F9668' }
                            : { background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }
                        }
                      >
                        {card.enabled ? '공개 중' : '꺼짐'}
                      </span>
                      {card.pinRequired ? (
                        <span className="flex items-center gap-0.5 rounded-full bg-[#FFF6E7] px-2 py-0.5 text-[10.5px] font-bold text-[#B77A0B]">
                          <Lock size={10} /> PIN
                        </span>
                      ) : null}
                      {card.customDomain ? (
                        <span className="flex items-center gap-0.5 rounded-full bg-[#EAF6FF] px-2 py-0.5 text-[10.5px] font-bold text-[#2F86D8]">
                          <Globe size={10} /> {card.customDomain}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                      {card.bioText || '소개문이 비어 있어요.'}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: 'var(--pa-mute-2)' }}>
                      <span>/c/{card.slug}</span>
                      <span>오늘 {card.dailyCount}/{card.dailyLimit}명</span>
                      <span>세션당 {card.maxTurnsPerSession}턴</span>
                      <span>보관 {card.retentionDays > 0 ? `${card.retentionDays}일` : '영구'}</span>
                      {card.deliveryMode !== 'qna_only' ? <span>받은 응답 {card.submittedCount || 0}건</span> : null}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <button
                    className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                    style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
                    onClick={() => void copy(card.links?.url || card.links?.domain || '', card.id)}
                  >
                    {copied === card.id ? <Check size={13} /> : <Copy size={13} />}
                    {copied === card.id ? '복사됨' : '링크 복사'}
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                    style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
                    onClick={() => void showQr(card)}
                  >
                    {busyId === card.id ? <Loader2 size={13} className="animate-spin" /> : <QrCode size={13} />} QR
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                    style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
                    onClick={() => void loadSessions(card)}
                  >
                    <MessageSquare size={13} /> 받은 응답
                    {card.deliveryMode !== 'qna_only' && card.submittedCount ? ` (${card.submittedCount})` : ''}
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                    style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
                    onClick={() => {
                      setForm(formOf(card));
                      setFormError('');
                    }}
                  >
                    <Pencil size={13} /> 수정
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-semibold"
                    style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
                    onClick={() => void toggle(card)}
                  >
                    <Power size={13} /> {card.enabled ? '끄기' : '켜기'}
                  </button>
                  {confirmDelete === card.id ? (
                    <span className="flex items-center gap-1.5">
                      <button
                        className="rounded-full bg-[#E5484D] px-3 py-1.5 text-[12px] font-bold text-white"
                        onClick={() => void remove(card)}
                      >
                        정말 삭제
                      </button>
                      <button
                        className="rounded-full px-2 py-1.5 text-[12px] font-semibold"
                        style={{ color: 'var(--pa-mute)' }}
                        onClick={() => setConfirmDelete('')}
                      >
                        취소
                      </button>
                    </span>
                  ) : (
                    <button
                      className="ml-auto flex items-center gap-1 rounded-full px-2.5 py-1.5 text-[12px] font-semibold text-[#D93A3A]"
                      onClick={() => setConfirmDelete(card.id)}
                    >
                      <Trash2 size={13} /> 삭제
                    </button>
                  )}
                </div>

                {openSessions === card.id ? (
                  <div className="mt-3 rounded-[18px] p-3" style={{ background: 'var(--pa-surface-3)' }}>
                    {sessionsLoading ? (
                      <p className="flex items-center gap-2 text-[12.5px]" style={{ color: 'var(--pa-mute)' }}>
                        <Loader2 size={13} className="animate-spin" /> 불러오는 중…
                      </p>
                    ) : card.deliveryMode === 'qna_only' ? (
                      <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                        자유 Q&amp;A 명함은 응답을 전달하지 않아 대화가 여기에 쌓이지 않아요.
                      </p>
                    ) : sessions.length === 0 ? (
                      <p className="text-[12.5px]" style={{ color: 'var(--pa-mute)' }}>
                        아직 들어온 응답이 없어요. 링크를 건네면 여기에 쌓여요.
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {sessions.map((session) => (
                          <SessionCard key={session.id} session={session} card={card} />
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-center text-[11px]" style={{ color: 'var(--pa-mute-2)' }}>
          손님 대화는 이 명함에만 저장되고 주인 채팅방과 섞이지 않아요. 보관 기간이 지나면 서버가 실제로 삭제하고,
          욕설·도배·프롬프트 탈취 시도는 AI를 부르기 전에 차단합니다.
        </p>
      </div>

      {form ? (
        <CardEditor
          form={form}
          purposes={purposes}
          deliveryModes={deliveryModes}
          retentionChoices={retentionChoices}
          modelGroups={modelGroups}
          activeModelLabel={activeModelLabel}
          saving={saving}
          error={formError}
          onChange={setForm}
          onPurpose={applyPurpose}
          onSave={() => void save()}
          onClose={() => setForm(null)}
        />
      ) : null}

      {qr ? (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 pa-fade-in px-4"
          role="dialog"
          aria-modal="true"
          style={{
            // v0.7.3: 상태바·홈 인디케이터에 QR 창이 닿지 않게 세이프 에어리어를 더한다.
            paddingTop: 'calc(env(safe-area-inset-top) + 16px)',
            paddingBottom: 'calc(env(safe-area-inset-bottom) + 16px)',
          }}
        >
          <div className="pa-sheet-in pa-scroll max-h-full w-full max-w-[340px] overflow-y-auto rounded-[26px] p-5 text-center" style={{ background: 'var(--pa-surface)' }}>
            <h2 className="text-[16px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
              {qr.card} QR
            </h2>
            <img src={qr.dataUrl} alt="명함 QR 코드" className="mx-auto mt-3 w-[220px] rounded-2xl" />
            <p className="mt-2 break-all text-[11.5px]" style={{ color: 'var(--pa-mute)' }}>
              {qr.url}
            </p>
            <div className="mt-4 flex gap-2">
              <button className="pa-btn-ghost flex-1 py-2.5 text-[13px]" onClick={() => void copy(qr.url, 'qr')}>
                {copied === 'qr' ? <Check size={14} /> : <Copy size={14} />} 링크 복사
              </button>
              <button className="pa-btn-primary flex-1 py-2.5 text-[13px]" onClick={() => setQr(null)}>
                닫기
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 받은 응답 한 건 — 상태·시각·턴·요약·항목 표 + 접히는 전체 대화        */
/* ------------------------------------------------------------------ */

function SessionCard({ session, card }: { session: GuestSessionView; card: AgentCard }) {
  const [open, setOpen] = useState(false);
  const badge =
    session.status === 'submitted'
      ? { label: '완료', background: '#EAFBF1', color: '#0F9668' }
      : session.status === 'blocked'
        ? { label: '차단', background: 'var(--pa-surface-3)', color: 'var(--pa-mute)' }
        : { label: '진행중', background: 'var(--accent-soft)', color: 'var(--accent-ink)' };
  const structured = session.structured || {};
  const rows = card.collectFields
    .filter((field) => structured[field.key])
    .map((field) => ({ key: field.key, label: field.label, value: structured[field.key] }));
  const known = new Set(rows.map((row) => row.key));
  const extra = Object.entries(structured)
    .filter(([key]) => !known.has(key) && key !== 'note')
    .map(([key, value]) => ({ key, label: key, value }));
  const note = structured.note || '';
  const hasFields = Boolean(rows.length || extra.length || note);

  return (
    <li
      className="rounded-[16px] px-3.5 py-3"
      style={{ background: 'var(--pa-surface)', border: '1px solid var(--pa-line-soft)' }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-full px-2 py-0.5 text-[10.5px] font-bold" style={{ background: badge.background, color: badge.color }}>
          {badge.label}
        </span>
        <span className="text-[13px] font-bold" style={{ color: 'var(--pa-ink)' }}>
          {session.visitorName || '이름 없음'}
        </span>
        {session.visitorContact ? (
          <span className="text-[11.5px]" style={{ color: 'var(--pa-mute)' }}>
            {session.visitorContact}
          </span>
        ) : null}
        <span className="ml-auto whitespace-nowrap text-[11px]" style={{ color: 'var(--pa-mute-2)' }}>
          {stampFull(session.createdAt)} 참여 · {session.turnCount}턴
        </span>
      </div>

      {/* 항목 표가 있으면 같은 내용의 요약 박스는 생략한다(중복 표시 방지). */}
      {!hasFields && session.summary ? (
        <p
          className="mt-2 whitespace-pre-wrap rounded-[12px] px-3 py-2 text-[12px] leading-relaxed"
          style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
        >
          {session.summary}
        </p>
      ) : null}

      {hasFields ? (
        <dl className="mt-2 space-y-1">
          {[...rows, ...extra].map((row) => (
            <div key={row.key} className="flex gap-2 rounded-[10px] px-2.5 py-1.5" style={{ background: 'var(--pa-surface-3)' }}>
              <dt className="w-[40%] shrink-0 whitespace-pre-wrap break-words text-[11.5px] font-semibold leading-snug" style={{ color: 'var(--pa-mute)' }}>
                {row.label}
              </dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed" style={{ color: 'var(--pa-ink)' }}>
                {row.value}
              </dd>
            </div>
          ))}
          {note ? (
            <div className="flex gap-2 rounded-[10px] px-2.5 py-1.5" style={{ background: 'var(--pa-surface-3)' }}>
              <dt className="w-[40%] shrink-0 text-[11.5px] font-semibold" style={{ color: 'var(--pa-mute)' }}>
                남긴 말
              </dt>
              <dd className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12px] leading-relaxed" style={{ color: 'var(--pa-ink)' }}>
                {note}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : !session.summary ? (
        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
          {session.messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' / ') || '대화만 있고 남긴 항목이 없어요.'}
        </p>
      ) : null}

      {session.messages.length ? (
        <div className="mt-2">
          <button
            className="flex items-center gap-1 text-[11.5px] font-semibold"
            style={{ color: 'var(--accent-ink)' }}
            onClick={() => setOpen((prev) => !prev)}
            aria-expanded={open}
          >
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {open ? '전체 대화 접기' : `전체 대화 보기 (${session.messages.length})`}
          </button>
          {open ? (
            <div className="mt-2 max-h-[320px] space-y-1.5 overflow-y-auto pa-scroll rounded-[12px] p-2.5" style={{ background: 'var(--pa-surface-3)' }}>
              {session.messages.map((message, index) => (
                <div key={index} className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                  <p
                    className="max-w-[88%] whitespace-pre-wrap break-words rounded-[12px] px-2.5 py-1.5 text-[12px] leading-relaxed"
                    style={
                      message.role === 'user'
                        ? { background: 'var(--accent-soft)', color: 'var(--pa-ink)' }
                        : { background: 'var(--pa-surface)', color: 'var(--pa-ink)', border: '1px solid var(--pa-line-soft)' }
                    }
                  >
                    {message.content}
                  </p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* 편집 시트 — iOS 세이프 에어리어 안쪽 풀스크린(z-100)                  */
/* ------------------------------------------------------------------ */

function CardEditor({
  form,
  purposes,
  deliveryModes,
  retentionChoices,
  modelGroups,
  activeModelLabel,
  saving,
  error,
  onChange,
  onPurpose,
  onSave,
  onClose,
}: {
  form: CardForm;
  purposes: PurposeMeta[];
  deliveryModes: DeliveryModeMeta[];
  retentionChoices: number[];
  modelGroups: ModelGroup[];
  activeModelLabel: string;
  saving: boolean;
  error: string;
  onChange: (next: CardForm) => void;
  onPurpose: (purpose: CardPurpose) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const patch = (part: Partial<CardForm>) => onChange({ ...form, ...part });
  const purposeList = purposes.length
    ? purposes
    : (['intro', 'meeting', 'survey', 'custom'] as CardPurpose[]).map((id) => ({ id, label: id, hint: '', examplePrompt: '' }));
  const modeList: DeliveryModeMeta[] = deliveryModes.length
    ? deliveryModes
    : [
        { id: 'collect', label: '대화 완료 시 주인에게 전달', hint: '정해 둔 항목을 대화로 물어보고, 다 받으면 정리해 전달해요' },
        { id: 'qna_only', label: '지침 내 자유 Q&A · 전달 안 함', hint: '소개·안내 범위에서 답만 하고, 제출·알림 없이 끝나요' },
      ];
  const collect = form.deliveryMode === 'collect';
  const modelValues = new Set(modelGroups.flatMap((group) => group.models.map((model) => model.value)));

  const setPrompt = (index: number, value: string) => {
    const next = [...form.quickPrompts];
    next[index] = value;
    patch({ quickPrompts: next });
  };

  const setField = (index: number, part: Partial<CollectField>) => {
    const next = form.collectFields.map((field, i) => (i === index ? { ...field, ...part } : field));
    patch({ collectFields: next });
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-stretch justify-center bg-black/40 pa-fade-in lg:items-center lg:p-4" role="dialog" aria-modal="true">
      <div
        className="pa-sheet-in pa-scroll flex h-full w-full flex-col overflow-y-auto bg-[var(--pa-surface)] lg:h-auto lg:max-h-[92vh] lg:max-w-[620px] lg:rounded-[28px]"
        style={{
          // v0.7.3: iOS 상태바·홈 인디케이터 아래로 가려지지 않게 세이프 에어리어를 더한다.
          paddingTop: 'calc(env(safe-area-inset-top) + 16px)',
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
          paddingLeft: 20,
          paddingRight: 20,
        }}
      >
        <div className="mb-3 flex items-center gap-2">
          <button className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ color: 'var(--pa-mute)' }} onClick={onClose} aria-label="닫기">
            <ArrowLeft size={19} />
          </button>
          <h2 className="flex-1 text-[17px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
            {form.id ? '명함 수정' : '새 명함'}
          </h2>
          <button className="pa-btn-primary px-4 py-2 text-[13px]" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} 저장
          </button>
        </div>

        <div className="space-y-3.5 pb-1">
          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              명함 이름
            </span>
            <input
              className="pa-input"
              value={form.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="예: 소개 명함"
              maxLength={60}
            />
          </label>

          <div>
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              용도 프리셋
            </span>
            <div className="flex flex-wrap gap-1.5">
              {purposeList.map((item) => (
                <button
                  key={item.id}
                  className="rounded-full border px-3 py-1.5 text-[12.5px] font-medium"
                  style={
                    form.purpose === item.id
                      ? { borderColor: 'transparent', background: 'var(--accent-grad)', color: 'var(--accent-contrast)' }
                      : { borderColor: 'var(--pa-line)', color: 'var(--pa-ink)' }
                  }
                  onClick={() => onPurpose(item.id)}
                  title={item.hint}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
              프리셋을 고르면 안내문·추천 질문·받을 항목이 기본값으로 채워져요. 그대로 고쳐도 됩니다.
            </p>
          </div>

          <div>
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              응답 방식
            </span>
            <div className="space-y-1.5">
              {modeList.map((mode) => (
                <button
                  key={mode.id}
                  className="flex w-full items-start gap-2.5 rounded-[14px] border px-3 py-2.5 text-left transition"
                  style={
                    form.deliveryMode === mode.id
                      ? { borderColor: 'var(--accent-line)', background: 'var(--accent-soft-weak)' }
                      : { borderColor: 'var(--pa-line)', background: 'var(--pa-surface)' }
                  }
                  onClick={() => patch({ deliveryMode: mode.id, oncePerVisitor: mode.id === 'qna_only' ? false : form.oncePerVisitor })}
                  aria-pressed={form.deliveryMode === mode.id}
                >
                  <span
                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border"
                    style={{
                      borderColor: form.deliveryMode === mode.id ? 'var(--accent)' : 'var(--pa-line)',
                      background: form.deliveryMode === mode.id ? 'var(--accent)' : 'transparent',
                    }}
                  >
                    {form.deliveryMode === mode.id ? <Check size={10} className="text-white" /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                      {mode.label}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
                      {mode.hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              주소 (비워 두면 자동)
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[13px]" style={{ color: 'var(--pa-mute)' }}>
                /c/
              </span>
              <input
                className="pa-input"
                value={form.slug}
                onChange={(e) => patch({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                placeholder="meeting"
                maxLength={40}
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              소개문 (손님 화면에 그대로 보여요)
            </span>
            <textarea
              className="pa-input min-h-[70px] resize-none"
              value={form.bioText}
              onChange={(e) => patch({ bioText: e.target.value })}
              maxLength={2000}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              안내 지침 (AI가 지킬 규칙 · 손님에게는 보이지 않아요)
            </span>
            <textarea
              className="pa-input min-h-[110px] resize-none"
              value={form.systemGuide}
              onChange={(e) => patch({ systemGuide: e.target.value })}
              maxLength={4000}
            />
          </label>

          <div>
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              추천 질문 칩 (최대 3개)
            </span>
            <div className="space-y-1.5">
              {[0, 1, 2].map((index) => (
                <input
                  key={index}
                  className="pa-input"
                  value={form.quickPrompts[index] || ''}
                  onChange={(e) => setPrompt(index, e.target.value)}
                  placeholder={index === 0 ? '자기소개 해줘' : '비워 두면 쓰지 않아요'}
                  maxLength={40}
                />
              ))}
            </div>
          </div>

          {collect ? (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                  대화에서 받을 항목
                </span>
                <button
                  className="flex items-center gap-0.5 text-[11.5px] font-semibold"
                  style={{ color: 'var(--accent-ink)' }}
                  onClick={() =>
                    patch({
                      collectFields: [
                        ...form.collectFields,
                        { key: `q${form.collectFields.length + 1}`, label: '', kind: 'text', required: false },
                      ],
                    })
                  }
                >
                  <Plus size={12} /> 항목 추가
                </button>
              </div>
              <p className="mb-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
                AI가 대화에서 하나씩 물어보고, 필수 항목이 다 차면 답을 정리해 주인에게 전달해요.
              </p>
              <div className="space-y-1.5">
                {form.collectFields.map((field, index) => (
                  <div key={field.key} className="flex items-center gap-1.5">
                    <input
                      className="pa-input flex-1"
                      value={field.label}
                      onChange={(e) => setField(index, { label: e.target.value })}
                      placeholder="항목 이름 (예: 희망 일시)"
                      maxLength={40}
                    />
                    <select
                      className="pa-input w-[74px]"
                      value={field.required ? '1' : '0'}
                      onChange={(e) => setField(index, { required: e.target.value === '1' })}
                      aria-label="필수 여부"
                    >
                      <option value="0">선택</option>
                      <option value="1">필수</option>
                    </select>
                    <button
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[#D93A3A]"
                      onClick={() => patch({ collectFields: form.collectFields.filter((_, i) => i !== index) })}
                      aria-label="항목 삭제"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {!form.collectFields.length ? (
                  <p className="text-[11.5px]" style={{ color: 'var(--pa-mute-2)' }}>
                    항목이 없으면 이름·연락처만 받아요.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                세션당 최대 턴
              </span>
              <input
                className="pa-input"
                type="number"
                min={1}
                max={200}
                value={form.maxTurnsPerSession}
                onChange={(e) => patch({ maxTurnsPerSession: Number(e.target.value) || 1 })}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                하루 응대 인원
              </span>
              <input
                className="pa-input"
                type="number"
                min={1}
                max={5000}
                value={form.dailyLimit}
                onChange={(e) => patch({ dailyLimit: Number(e.target.value) || 1 })}
              />
            </label>
          </div>

          <div className={collect ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-1 gap-2'}>
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                대화 보관 기간
              </span>
              <select
                className="pa-input"
                value={String(form.retentionDays)}
                onChange={(e) => patch({ retentionDays: Number(e.target.value) })}
              >
                {retentionChoices.map((days) => (
                  <option key={days} value={days}>
                    {RETENTION_LABELS[days] || `${days}일`}
                  </option>
                ))}
              </select>
            </label>
            {collect ? (
              <label className="flex items-end">
                <span
                  className="flex w-full items-center justify-between rounded-[12px] px-3 py-2.5"
                  style={{ background: 'var(--pa-surface-3)' }}
                >
                  <span className="flex items-center gap-1.5 text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                    <UserCheck size={14} /> 1인 1회 참여
                  </span>
                  <input
                    type="checkbox"
                    checked={form.oncePerVisitor}
                    onChange={(e) => patch({ oncePerVisitor: e.target.checked })}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                </span>
              </label>
            ) : null}
          </div>
          <p className="-mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
            {collect
              ? '보관 기간이 지나면 서버가 대화·연락처를 실제로 영구 삭제해요. 1인 1회를 켜면 응답을 마친 방문자는 다시 참여할 수 없어요.'
              : '자유 Q&A 명함의 대화는 서버 DB에 저장하지 않고 메모리에 최대 2시간만 두었다가 사라져요. IP 기록도 남기지 않아요.'}
          </p>

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              커스텀 도메인 (선택)
            </span>
            <input
              className="pa-input"
              value={form.customDomain}
              onChange={(e) => patch({ customDomain: e.target.value })}
              placeholder="card.example.com"
              maxLength={120}
            />
            <span className="mt-1 block text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
              도메인 DNS 연결과 리버스 프록시(Cloudflare·Nginx·Caddy) SSL 설정이 필요해요. 연결된 도메인에서는 공개 명함만 열리고
              로그인·관리 화면은 404로 차단돼요.
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              공개 기간 (비우면 계속)
            </span>
            <input
              className="pa-input"
              type="date"
              value={form.expiresAt}
              onChange={(e) => patch({ expiresAt: e.target.value })}
            />
          </label>

          <div className="rounded-[16px] px-3.5 py-3" style={{ background: 'var(--pa-surface-3)' }}>
            <label className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                <Lock size={14} /> PIN 잠금
              </span>
              <input
                type="checkbox"
                checked={form.pinEnabled}
                onChange={(e) => patch({ pinEnabled: e.target.checked })}
                className="h-4 w-4 accent-[var(--accent)]"
              />
            </label>
            {form.pinEnabled ? (
              <input
                className="pa-input mt-2 text-center tracking-[0.3em]"
                type="password"
                inputMode="numeric"
                value={form.pin}
                onChange={(e) => patch({ pin: e.target.value.replace(/\D/g, '').slice(0, 12) })}
                placeholder={form.id ? '바꾸지 않으려면 비워 두세요' : '4~12자리 숫자'}
              />
            ) : null}
            <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
              PIN은 암호화(해시)되어 저장되고 화면에 다시 보이지 않아요.
            </p>
          </div>

          <label className="block">
            <span className="mb-1 block text-[12.5px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              이 명함만 쓸 모델 (선택)
            </span>
            <select
              className="pa-input"
              value={form.modelOverride}
              onChange={(e) => patch({ modelOverride: e.target.value })}
            >
              <option value="">기본 모델 사용{activeModelLabel ? ` (${activeModelLabel})` : ' (평소 쓰는 모델)'}</option>
              {modelGroups.map((group) => (
                <optgroup key={group.provider} label={group.label}>
                  {group.models.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                    </option>
                  ))}
                </optgroup>
              ))}
              {/* 연결이 끊긴 프로바이더의 예전 선택값도 잃지 않게 그대로 보여 준다. */}
              {form.modelOverride && !modelValues.has(form.modelOverride) ? (
                <option value={form.modelOverride}>{form.modelOverride} (연결 안 됨)</option>
              ) : null}
            </select>
            <span className="mt-1 block text-[11px] leading-relaxed" style={{ color: 'var(--pa-mute-2)' }}>
              지금 API 키가 연결된 프로바이더의 모델만 보여요. 비우면 평소 쓰는 모델을 그대로 써요.
            </span>
          </label>

          <label className="flex items-center justify-between rounded-[16px] px-3.5 py-3" style={{ background: 'var(--pa-surface-3)' }}>
            <span className="flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
              <Sparkles size={14} /> 지금 바로 공개
            </span>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>

          {error ? (
            <p className="text-[12.5px] font-medium text-[#D93A3A]" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2 pb-1">
            <button className="pa-btn-ghost flex-1 py-3" onClick={onClose}>
              취소
            </button>
            <button className="pa-btn-primary flex-[1.4] py-3" onClick={onSave} disabled={saving}>
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
              {saving ? '저장하는 중…' : form.id ? '수정 저장' : '명함 만들기'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function stampFull(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${month}월 ${day}일 ${hh}:${mm}`;
}
