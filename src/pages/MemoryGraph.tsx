import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Link2, Minus, Pin, PinOff, Plus, Search, Sparkles, Unlink, Wand2 } from 'lucide-react';
import { api, type MemoryCategory, type MemoryGraph, type MemoryGraphEdge, type MemoryGraphNode } from '../lib/api';
import { formatRelative } from '../lib/format';
import Mascot from '../components/Mascot';

/**
 * v0.7.1 — 내 기억 그래프
 *
 * 저장된 기억을 '나' 를 중심으로 분류(사람·프로젝트·취향·일정…)와 잇고,
 * 기억끼리 비슷한 것끼리 얇게 연결해 보여 준다.
 *   · 상단: 분류 필터 칩 + 검색
 *   · 가운데: SVG 네트워크 그래프(드래그 이동 · 핀치/휠 확대 · 노드 탭 선택)
 *   · 하단: 선택한 노드 상세(연결 수·요약·[연결 편집]·[중요 고정])
 *
 * 색은 --pa-* 변수만 쓰고, 노드만 파스텔 톤을 쓴다(라이트/다크 공통 대비 확보).
 */

const CATEGORY_TINT: Record<string, { fill: string; ink: string; ring: string }> = {
  profile: { fill: '#EFE9FF', ink: '#6F52E8', ring: '#D6C9FF' },
  taste: { fill: '#FFEAF1', ink: '#D14E80', ring: '#FFD3E2' },
  habit: { fill: '#E6F4FF', ink: '#2C7FC4', ring: '#CCE8FF' },
  person: { fill: '#FFF3E0', ink: '#B77C12', ring: '#FFE3BC' },
  promise: { fill: '#E8F8EC', ink: '#31874A', ring: '#CBEDD6' },
  project: { fill: '#F3EDE4', ink: '#7E6444', ring: '#E5DACB' },
  rule: { fill: '#FFE9E9', ink: '#C0453F', ring: '#FFD3D3' },
  other: { fill: '#F2F1F8', ink: '#7A7A8C', ring: '#E3E1EE' },
};

const tint = (category?: string) => CATEGORY_TINT[category || 'other'] || CATEGORY_TINT.other;

/** 필터 칩 — brief 의 '전체·사람·프로젝트·취향·일정' 을 서버 분류에 맞춰 보여 준다. */
const FILTER_ORDER = ['all', 'person', 'project', 'taste', 'promise', 'profile', 'habit', 'rule', 'other'];

interface Point {
  x: number;
  y: number;
}

/** 결정론적 난수(같은 그래프는 항상 같은 모양으로) */
function seeded(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** 간단한 스프링 레이아웃 — 반발 + 연결 인력 + 중심 중력 */
function layoutGraph(nodes: MemoryGraphNode[], edges: MemoryGraphEdge[]): Record<string, Point> {
  const rand = seeded(nodes.length * 7919 + edges.length * 13 + 7);
  const pos: Record<string, Point> = {};
  const categories = nodes.filter((node) => node.kind === 'category');
  const catAngle = new Map<string, number>();
  categories.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, categories.length) - Math.PI / 2;
    catAngle.set(node.id, angle);
    pos[node.id] = { x: 500 + Math.cos(angle) * 175, y: 500 + Math.sin(angle) * 175 };
  });
  pos.me = { x: 500, y: 500 };
  const memories = nodes.filter((node) => node.kind === 'memory');
  const perCat = new Map<string, number>();
  for (const node of memories) {
    const catId = `cat:${node.category}`;
    const angle = catAngle.get(catId) ?? 0;
    const index = perCat.get(catId) || 0;
    perCat.set(catId, index + 1);
    const spread = 0.9;
    const a = angle + (index - 1.5) * (spread / 3);
    const radius = 300 + rand() * 90;
    pos[node.id] = { x: 500 + Math.cos(a) * radius, y: 500 + Math.sin(a) * radius };
  }
  const ids = nodes.map((node) => node.id);
  const spring = edges.filter((edge) => edge.kind !== 'similar');
  const iterations = nodes.length > 120 ? 70 : 120;
  for (let step = 0; step < iterations; step += 1) {
    const force: Record<string, Point> = {};
    for (const id of ids) force[id] = { x: 0, y: 0 };
    // 반발
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = pos[ids[i]];
        const b = pos[ids[j]];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          dx = rand() - 0.5;
          dy = rand() - 0.5;
          dist = 0.5;
        }
        const repulse = 2600 / (dist * dist);
        const fx = (dx / dist) * repulse;
        const fy = (dy / dist) * repulse;
        force[ids[i]].x += fx;
        force[ids[i]].y += fy;
        force[ids[j]].x -= fx;
        force[ids[j]].y -= fy;
      }
    }
    // 연결 인력(중심 쪽으로 당김)
    for (const edge of spring) {
      const a = pos[edge.source];
      const b = pos[edge.target];
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const target = edge.source === 'me' ? 180 : 120;
      const pull = (dist - target) * 0.012 * (0.6 + edge.weight);
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      force[edge.source].x += fx;
      force[edge.source].y += fy;
      force[edge.target].x -= fx;
      force[edge.target].y -= fy;
    }
    // 중심 중력 + 적용
    for (const id of ids) {
      const node = pos[id];
      const gravity = id === 'me' ? 0.06 : 0.012;
      force[id].x += (500 - node.x) * gravity;
      force[id].y += (500 - node.y) * gravity;
      const limit = id === 'me' ? 4 : 14;
      node.x = Math.min(985, Math.max(15, node.x + Math.max(-limit, Math.min(limit, force[id].x))));
      node.y = Math.min(985, Math.max(15, node.y + Math.max(-limit, Math.min(limit, force[id].y))));
    }
  }
  return pos;
}

function nodeRadius(node: MemoryGraphNode): number {
  if (node.kind === 'me') return 46;
  if (node.kind === 'category') return 30;
  const importance = node.importance || 2;
  return 10 + importance * 2.2;
}

export default function MemoryGraphPage() {
  const [graph, setGraph] = useState<MemoryGraph | null>(null);
  const [categories, setCategories] = useState<MemoryCategory[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [linkMode, setLinkMode] = useState(false);
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string | null; start: Point; moved: boolean; panning: boolean }>({
    id: null,
    start: { x: 0, y: 0 },
    moved: false,
    panning: false,
  });
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const [graphRes, memoryRes] = await Promise.all([
        api.get<{ graph: MemoryGraph }>('/api/memory/graph'),
        api.get<{ categories: MemoryCategory[] }>('/api/memory').catch(() => ({ categories: [] as MemoryCategory[] })),
      ]);
      setGraph(graphRes.graph);
      setCategories(memoryRes.categories || []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '기억 그래프를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!graph) return;
    setPositions(layoutGraph(graph.nodes, graph.edges));
  }, [graph]);

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice(''), 2200);
  };

  const visible = useMemo(() => {
    if (!graph) return { nodes: [] as MemoryGraphNode[], edges: [] as MemoryGraphEdge[] };
    const q = query.trim().toLowerCase();
    const match = (node: MemoryGraphNode) => {
      if (q && node.kind === 'memory' && !(node.content || node.label).toLowerCase().includes(q)) return false;
      if (q && node.kind === 'category' && !node.label.toLowerCase().includes(q)) return false;
      return true;
    };
    const filtered = graph.nodes.filter(match);
    const ids = new Set(filtered.map((node) => node.id));
    // 분류 노드는 남은 기억이 있을 때만 보여 준다.
    const keptCategories = new Set(filtered.filter((node) => node.kind === 'category').map((node) => node.id));
    const nodes = filtered.filter((node) => {
      if (node.kind !== 'memory') return true;
      const catId = `cat:${node.category}`;
      return ids.has(catId) && keptCategories.has(catId);
    });
    const nodeIds = new Set(nodes.map((node) => node.id));
    return { nodes, edges: graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) };
  }, [graph, query]);

  const counts = graph?.counts || { memories: 0, categories: 0, links: 0, superseded: 0 };
  const selectedNode = visible.nodes.find((node) => node.id === selected) || null;
  const selectedMemories = useMemo(() => {
    if (!selectedNode) return [] as MemoryGraphNode[];
    if (selectedNode.kind === 'me') return visible.nodes.filter((node) => node.kind === 'memory');
    const catId = selectedNode.kind === 'category' ? selectedNode.id : `cat:${selectedNode.category}`;
    return visible.nodes.filter((node) => node.kind === 'memory' && node.id !== selectedNode.id && node.category === selectedNode.category && catId);
  }, [selectedNode, visible.nodes]);
  const linksForSelected = useMemo(() => {
    if (!selectedNode) return [] as MemoryGraphEdge[];
    return visible.edges.filter(
      (edge) => edge.kind === 'link' && (edge.source === selectedNode.id || edge.target === selectedNode.id)
    );
  }, [selectedNode, visible.edges]);

  const labelOf = (id: string) => visible.nodes.find((node) => node.id === id)?.label || '기억';

  const pickCategory = (id: string) => {
    setFilter(id);
    setSelected(id === 'all' ? null : `cat:${id}`);
    setLinkMode(false);
  };

  /* ---------------------------- 상호작용 ---------------------------- */

  const toGraph = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scale = 1000 / rect.width;
    return { x: (clientX - rect.left) * scale, y: (clientY - rect.top) * scale };
  };

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const point = toGraph(event.clientX, event.clientY);
    dragRef.current = { id: null, start: point, moved: false, panning: true };
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
  };

  const onNodePointerDown = (event: React.PointerEvent<SVGGElement>, node: MemoryGraphNode) => {
    event.stopPropagation();
    const point = toGraph(event.clientX, event.clientY);
    dragRef.current = { id: node.id, start: point, moved: false, panning: false };
    (event.currentTarget as SVGGElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag.id && !drag.panning) return;
    const point = toGraph(event.clientX, event.clientY);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
    if (drag.id) {
      setPositions((prev) => {
        const current = prev[drag.id as string];
        if (!current) return prev;
        return { ...prev, [drag.id as string]: { x: current.x + dx, y: current.y + dy } };
      });
    } else if (drag.panning) {
      setZoom((prev) => ({ ...prev, x: prev.x + dx * 0.6, y: prev.y + dy * 0.6 }));
    }
    dragRef.current = { ...drag, start: point };
  };

  const onPointerUp = (event: React.PointerEvent<SVGElement>, node?: MemoryGraphNode) => {
    const drag = dragRef.current;
    dragRef.current = { id: null, start: { x: 0, y: 0 }, moved: false, panning: false };
    if (!node || drag.moved) return;
    void selectNode(node);
  };

  const selectNode = async (node: MemoryGraphNode) => {
    if (linkMode && selected && node.kind === 'memory' && node.id !== selected) {
      await link(selected, node.id);
      return;
    }
    setSelected(node.id);
  };

  const link = async (a: string, b: string, action: 'link' | 'unlink' = 'link') => {
    setBusy(true);
    setError('');
    try {
      const res = await api.post<{ graph: MemoryGraph }>('/api/memory/graph/edge', { a, b, action });
      setGraph(res.graph);
      setLinkMode(false);
      flash(action === 'link' ? '두 기억을 이었어요.' : '연결을 풀었어요.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '연결을 바꾸지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async () => {
    if (!selectedNode || selectedNode.kind !== 'memory') return;
    setBusy(true);
    try {
      await api.patch(`/api/memory/${selectedNode.id}`, { pinned: !selectedNode.pinned });
      flash(selectedNode.pinned ? '중요 고정을 풀었어요.' : '중요 기억으로 고정했어요. 매 대화에 들어가요.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '고정하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const consolidate = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ superseded: number }>('/api/memory/consolidate');
      flash(res.superseded ? `${res.superseded}개의 옛 기억을 '이전 버전'으로 정리했어요.` : '정리할 중복 기억이 없어요.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '정리에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const onWheel = (event: React.WheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.92 : 1.08;
    setZoom((prev) => ({ ...prev, scale: Math.min(2.6, Math.max(0.45, prev.scale * factor)) }));
  };

  const onTouchStart = (event: React.TouchEvent<SVGSVGElement>) => {
    if (event.touches.length === 2) {
      const [a, b] = [event.touches[0], event.touches[1]];
      pinchRef.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale: zoom.scale };
    }
  };

  const onTouchMove = (event: React.TouchEvent<SVGSVGElement>) => {
    if (event.touches.length === 2 && pinchRef.current) {
      const [a, b] = [event.touches[0], event.touches[1]];
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (pinchRef.current.distance > 0) {
        const next = (distance / pinchRef.current.distance) * pinchRef.current.scale;
        setZoom((prev) => ({ ...prev, scale: Math.min(2.6, Math.max(0.45, next)) }));
      }
    }
  };

  const onTouchEnd = () => {
    pinchRef.current = null;
  };

  const transform = `translate(${zoom.x} ${zoom.y}) translate(500 500) scale(${zoom.scale}) translate(-500 -500)`;

  return (
    <div className="pa-scroll relative h-full min-h-0 overflow-y-auto px-4 pb-10 pt-5 lg:px-10 lg:pt-9">
      <div className="mx-auto w-full max-w-[860px]">
        <header className="flex items-center gap-2">
          <button
            className="flex h-10 w-10 items-center justify-center rounded-2xl transition hover:bg-[#F7F5FF] dark:hover:bg-[#232030]"
            style={{ color: 'var(--pa-mute)' }}
            onClick={() => window.history.back()}
            aria-label="뒤로"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-[24px] font-bold tracking-[-0.02em] lg:text-[30px]">내 기억 그래프</h1>
            <p className="mt-0.5 text-[12.5px]" style={{ color: 'var(--pa-mute)' }}>
              기억 <b style={{ color: 'var(--accent-deep)' }}>{counts.memories}</b>개 · 분류 {counts.categories}개 · 연결{' '}
              {counts.links}개
              {counts.superseded ? ` · 이전 버전 ${counts.superseded}` : ''}
            </p>
          </div>
          <Mascot name="minti" size={44} className="shrink-0" />
        </header>

        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--pa-mute-2)' }} />
            <input
              className="pa-input pl-9"
              placeholder="기억 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => void consolidate()}
            disabled={busy}
            className="shrink-0 rounded-xl px-3 py-2.5 text-[12px] font-bold disabled:opacity-50"
            style={{ background: 'var(--pa-surface-3)', color: 'var(--accent-deep)' }}
          >
            <Wand2 size={14} className="mr-1 inline" /> 중복 정리
          </button>
        </div>

        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
          {FILTER_ORDER.map((id) => {
            const category = categories.find((item) => item.id === id);
            const label = id === 'all' ? '전체' : category?.label || (id === 'promise' ? '약속·일정' : id);
            const exists = id === 'all' || visible.nodes.some((node) => node.kind === 'category' && node.id === `cat:${id}`);
            if (!exists) return null;
            return (
              <button
                key={id}
                onClick={() => pickCategory(id)}
                className={`pa-chip shrink-0 ${filter === id ? 'pa-chip-active' : ''}`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {error ? (
          <p className="mt-3 rounded-2xl bg-[#FFF1F1] px-4 py-2.5 text-[12.5px] font-medium text-[#E5484D]">{error}</p>
        ) : null}
        {notice ? (
          <p
            className="mt-3 rounded-2xl px-4 py-2.5 text-[12.5px] font-semibold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
          >
            {notice}
          </p>
        ) : null}

        {/* 그래프 */}
        <section
          className="relative mt-3 overflow-hidden rounded-[22px] border"
          style={{ background: 'var(--pa-surface)', borderColor: 'var(--pa-line)', boxShadow: '0 4px 16px rgba(90,80,160,0.05)' }}
        >
          <svg
            ref={svgRef}
            viewBox="0 0 1000 1000"
            className="h-[62vh] max-h-[640px] w-full touch-none select-none"
            style={{ background: 'var(--pa-surface-2)' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => onPointerUp(event)}
            onWheel={onWheel}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            role="img"
            aria-label="내 기억 그래프"
          >
            <g transform={transform}>
              {visible.edges.map((edge) => {
                const a = positions[edge.source];
                const b = positions[edge.target];
                if (!a || !b) return null;
                const color = edge.kind === 'link' ? 'var(--accent)' : edge.kind === 'similar' ? 'var(--accent-line)' : 'var(--pa-line)';
                const width = edge.kind === 'link' ? 2.4 : edge.kind === 'similar' ? 1.4 : 1.8 + edge.weight * 1.6;
                const active = selectedNode && (edge.source === selectedNode.id || edge.target === selectedNode.id);
                return (
                  <line
                    key={edge.id}
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={color}
                    strokeWidth={active ? width + 1.4 : width}
                    strokeOpacity={active ? 0.95 : edge.kind === 'similar' ? 0.45 : 0.7}
                    strokeDasharray={edge.kind === 'similar' ? '4 5' : undefined}
                  />
                );
              })}
              {visible.nodes.map((node) => {
                const point = positions[node.id];
                if (!point) return null;
                const radius = nodeRadius(node);
                const color = node.kind === 'memory' || node.kind === 'category' ? tint(node.category) : null;
                const isSelected = selectedNode?.id === node.id;
                return (
                  <g
                    key={node.id}
                    transform={`translate(${point.x} ${point.y})`}
                    onPointerDown={(event) => onNodePointerDown(event, node)}
                    onPointerUp={(event) => {
                      event.stopPropagation();
                      onPointerUp(event, node);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    {node.kind === 'me' ? (
                      <>
                        <circle r={radius} fill="var(--accent-grad)" opacity={0.95} />
                        <text textAnchor="middle" dy="6" fontSize={26} fontWeight={800} fill="var(--accent-contrast)">
                          나
                        </text>
                      </>
                    ) : (
                      <>
                        <circle
                          r={radius + (isSelected ? 4 : 0)}
                          fill={color?.fill}
                          stroke={isSelected ? 'var(--accent)' : color?.ring}
                          strokeWidth={isSelected ? 3 : 1.5}
                          opacity={0.98}
                        />
                        {node.kind === 'memory' && node.pinned ? (
                          <circle r={3} cx={radius * 0.72} cy={-radius * 0.72} fill="var(--accent)" />
                        ) : null}
                        <text
                          textAnchor="middle"
                          dy={node.kind === 'category' ? 5 : radius + 14}
                          fontSize={node.kind === 'category' ? 22 : 17}
                          fontWeight={node.kind === 'category' ? 800 : 600}
                          fill={node.kind === 'category' ? color?.ink : 'var(--pa-mute)'}
                        >
                          {node.kind === 'category' ? node.label : ''}
                        </text>
                        {node.kind === 'category' ? (
                          <text textAnchor="middle" dy={-6} fontSize={15} fontWeight={700} fill={color?.ink} opacity={0.7}>
                            {node.count}
                          </text>
                        ) : null}
                      </>
                    )}
                  </g>
                );
              })}
            </g>
          </svg>

          <div className="absolute bottom-3 right-3 flex flex-col gap-1">
            <button
              type="button"
              onClick={() => setZoom((prev) => ({ ...prev, scale: Math.min(2.6, prev.scale * 1.15) }))}
              className="flex h-8 w-8 items-center justify-center rounded-xl"
              style={{ background: 'var(--pa-surface)', color: 'var(--pa-mute)', border: '1px solid var(--pa-line)' }}
              aria-label="확대"
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              onClick={() => setZoom((prev) => ({ ...prev, scale: Math.max(0.45, prev.scale / 1.15) }))}
              className="flex h-8 w-8 items-center justify-center rounded-xl"
              style={{ background: 'var(--pa-surface)', color: 'var(--pa-mute)', border: '1px solid var(--pa-line)' }}
              aria-label="축소"
            >
              <Minus size={15} />
            </button>
            <button
              type="button"
              onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}
              className="flex h-8 w-8 items-center justify-center rounded-xl text-[10px] font-bold"
              style={{ background: 'var(--pa-surface)', color: 'var(--pa-mute)', border: '1px solid var(--pa-line)' }}
              aria-label="처음 크기로"
            >
              1:1
            </button>
          </div>

          {!visible.nodes.filter((node) => node.kind === 'memory').length ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center">
              <Sparkles size={22} style={{ color: 'var(--accent-mute)' }} />
              <p className="text-[13px] font-semibold" style={{ color: 'var(--pa-ink)' }}>
                아직 그릴 기억이 없어요
              </p>
              <p className="text-[11.5px]" style={{ color: 'var(--pa-mute)' }}>
                대화를 나누면 AI가 스스로 기억을 모아 여기에 이어 줍니다.
              </p>
            </div>
          ) : null}
        </section>

        {linkMode ? (
          <p
            className="mt-2 rounded-xl px-3 py-2 text-[12px] font-semibold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}
          >
            이어 줄 다른 기억을 눌러 주세요. (취소하려면 [연결 편집]을 다시 누르세요)
          </p>
        ) : null}

        {/* 선택 노드 상세 */}
        <section
          className="mt-3 rounded-[22px] border p-4"
          style={{ background: 'var(--pa-surface)', borderColor: 'var(--pa-line)', boxShadow: '0 4px 16px rgba(90,80,160,0.05)' }}
        >
          {!selectedNode ? (
            <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--pa-mute)' }}>
              노드를 누르면 그 기억의 내용과 연결을 볼 수 있어요. 드래그로 옮기고, 두 손가락(또는 휠)으로 확대할 수 있어요.
            </p>
          ) : selectedNode.kind === 'me' ? (
            <div>
              <p className="text-[15px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                나 — 모든 기억의 중심
              </p>
              <p className="mt-1 text-[12.5px]" style={{ color: 'var(--pa-mute)' }}>
                기억 {counts.memories}개가 {counts.categories}개 분류로 이어져 있어요. 분류를 누르면 그 안의 기억만 보여요.
              </p>
            </div>
          ) : selectedNode.kind === 'category' ? (
            <div>
              <p className="flex items-center gap-2 text-[15px] font-bold" style={{ color: 'var(--pa-ink-strong)' }}>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: tint(selectedNode.category).ink }} />
                {selectedNode.label}
              </p>
              <p className="mt-1 text-[12.5px]" style={{ color: 'var(--pa-mute)' }}>
                이 분류에 기억 {selectedMemories.length}개
              </p>
              <div className="mt-2 space-y-1">
                {selectedMemories.slice(0, 5).map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => setSelected(node.id)}
                    className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-[12px]"
                    style={{ background: 'var(--pa-surface-3)', color: 'var(--pa-ink)' }}
                  >
                    {node.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: tint(selectedNode.category).ink }}>
                    {categories.find((item) => item.id === selectedNode.category)?.label || '기타'}
                    {selectedNode.pinned ? (
                      <span className="flex items-center gap-0.5 rounded-md px-1 py-0.5" style={{ background: 'var(--accent-soft)', color: 'var(--accent-deep)' }}>
                        <Pin size={9} /> 고정
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[13.5px] leading-[1.6]" style={{ color: 'var(--pa-ink-strong)' }}>
                    {selectedNode.content}
                  </p>
                  <p className="mt-1.5 text-[11px]" style={{ color: 'var(--pa-mute-2)' }}>
                    중요도 {selectedNode.importance || 2}/5 · 연결 {linksForSelected.length}개
                    {selectedNode.updatedAt ? ` · ${formatRelative(selectedNode.updatedAt)} 갱신` : ''}
                  </p>
                </div>
              </div>

              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setLinkMode((prev) => !prev)}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-bold disabled:opacity-50"
                  style={
                    linkMode
                      ? { background: 'var(--accent)', color: 'var(--accent-contrast)' }
                      : { background: 'var(--pa-surface-3)', color: 'var(--accent-deep)' }
                  }
                >
                  <Link2 size={13} /> 연결 편집
                </button>
                <button
                  type="button"
                  onClick={() => void togglePin()}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-bold disabled:opacity-50"
                  style={{ background: 'var(--pa-surface-3)', color: selectedNode.pinned ? 'var(--accent-deep)' : 'var(--pa-mute)' }}
                >
                  {selectedNode.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                  {selectedNode.pinned ? '고정 해제' : '중요 고정'}
                </button>
              </div>

              {linksForSelected.length ? (
                <div className="mt-2 space-y-1">
                  {linksForSelected.map((edge) => {
                    const otherId = edge.source === selectedNode.id ? edge.target : edge.source;
                    return (
                      <div
                        key={edge.id}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5"
                        style={{ background: 'var(--pa-surface-3)' }}
                      >
                        <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: 'var(--pa-ink)' }}>
                          {labelOf(otherId)}
                        </span>
                        <button
                          type="button"
                          onClick={() => void link(selectedNode.id, otherId, 'unlink')}
                          disabled={busy}
                          className="flex shrink-0 items-center gap-1 text-[11px] font-semibold disabled:opacity-50"
                          style={{ color: 'var(--pa-mute)' }}
                        >
                          <Unlink size={12} /> 해제
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          )}
        </section>

        <p className="mt-5 text-center text-[11.5px]" style={{ color: 'var(--pa-mute-2)' }}>
          기억은 지우지 않고 '이전 버전'으로만 표시해요 · 중복 정리 후에도 복원할 수 있어요
        </p>
      </div>
    </div>
  );
}
