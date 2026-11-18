import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * 더보기(/more) 하위 페이지 상단의 뒤로가기 버튼 (v0.5.1).
 *
 * 모바일에는 브라우저 뒤로가기 제스처가 없거나 앱(PWA) 안에서 나오기 어려워서
 * 서브 페이지에서 바로 빠져나올 버튼이 필요했다. 들어온 기록이 있으면 한 단계
 * 되돌아가고, 바로 들어온 경우(새로고침·딥링크)에는 /more 로 보낸다.
 */
export default function BackButton({ to = '/more', label = '뒤로' }: { to?: string; label?: string }) {
  const navigate = useNavigate();
  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(to);
  };
  return (
    <button
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-[#6B677A] transition hover:bg-[#F7F5FF] active:scale-95"
      onClick={goBack}
      aria-label={label}
      title={label}
    >
      <ArrowLeft size={20} />
    </button>
  );
}
