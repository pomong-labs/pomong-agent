/**
 * v0.6.12: 한국어 조사 헬퍼
 *
 * 화면 문구에 설정된 비서 이름(profile.agentName)을 넣을 때, 이름에 받침이 있는지에 따라
 * 주격 조사(이/가)를 골라 준다. "라몽이 생각 중…", "퐁이가 생각 중…", "멜로가 작업 중…" 처럼
 * 이름을 무엇으로 바꿔도 문장이 자연스럽게 읽힌다.
 */

/** 이름 끝 글자의 받침 유무로 '이'/'가'를 붙인다. 빈 이름이면 '포몽이'로 돌려준다. */
export function subjectName(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return '포몽이';
  const code = trimmed.charCodeAt(trimmed.length - 1);
  // 한글 음절(가~힣)만 받침을 따진다. 종성 인덱스가 0이면 받침 없음 → '가'.
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? `${trimmed}가` : `${trimmed}이`;
  // 영문·숫자·기호로 끝나면 '가'로 붙인다(예: "Agent 가").
  return `${trimmed}가`;
}
