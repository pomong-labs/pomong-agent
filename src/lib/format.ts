export function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h < 12 ? '오전' : '오후'} ${h < 12 ? h || 12 : h - 12 || 12}:${m}`;
}

export function formatTime(iso: string): string {  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function formatRelative(iso: string | null): string {  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}일 전`;
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
}

/**
 * v0.6.18: 말풍선 시각 — 오늘은 시각만, 지난 날은 날짜가 함께 보이게 한다.
 *  · 오늘       → 오후 7:54
 *  · 어제       → 어제 · 오후 7:54
 *  · 올해       → 11월 19일 · 오후 7:54
 *  · 그 이전     → 2025. 11. 19. · 오후 7:54
 */
export function formatChatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const clock = formatClock(iso);
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return `어제 · ${clock}`;
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일 · ${clock}`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. · ${clock}`;
}

/** v0.6.18: 채팅방 목록용 — 날짜(또는 어제)와 시각을 함께 보여 준다. */
export function formatRoomStampFull(iso: string | null): string {
  if (!iso) return '';
  return formatChatStamp(iso);
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

export function statusLabel(status: string): string {
  if (status === 'healthy') return '정상';
  if (status === 'warning') return '주의';
  if (status === 'critical') return '위험';
  return status;
}

/**
 * v0.6.3: 채팅방 목록·검색 결과의 시각 표기
 * - 오늘: 오전/오후 H:MM
 * - 어제: 어제
 * - 올해: 11월 19일
 * - 그 이전: 2025. 11. 19.
 */
export function formatRoomStamp(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return formatClock(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return '어제';
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
