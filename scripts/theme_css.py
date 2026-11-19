#!/usr/bin/env python3
"""테마 CSS 생성기 (v0.5.6)

`src/` 안의 Tailwind 색 유틸리티(bg-[#..], text-[#..], border-[#..], ring-[#..] ...)를
훑어서
  1) 포인트 컬러 계열은 CSS 변수(--accent*)를 바라보게 하고
  2) 나머지 색은 다크 테마용 색으로 바꾼 규칙을 만든다.

결과: src/theme.generated.css  (커밋 대상)
실행: python3 scripts/theme_css.py [--table]
"""
from __future__ import annotations

import colorsys
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = SRC / "theme.generated.css"

# ----------------------------- 색 계산 -----------------------------


def hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    return int(hex_color[1:3], 16), int(hex_color[3:5], 16), int(hex_color[5:7], 16)


def hsl(hex_color: str) -> tuple[float, float, float]:
    r, g, b = (v / 255 for v in hex_to_rgb(hex_color))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    return h * 360.0, s, l


def from_hsl(h: float, s: float, l: float) -> str:
    r, g, b = colorsys.hls_to_rgb((h % 360.0) / 360.0, max(0.0, min(1.0, l)), max(0.0, min(1.0, s)))
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in (r, g, b))


# ----------------------------- 포인트 컬러 -----------------------------
ACCENT_TEXT = {
    "#7C63F6": "var(--accent-deep)",
    "#8B72F6": "var(--accent-deep)",
    "#8B72F8": "var(--accent-deep)",
    "#7C63FF": "var(--accent-deep)",
    "#7B5CF5": "var(--accent-deep)",
}
ACCENT_FILL = {
    "#8B72F8": "var(--accent)",
    "#7C63F6": "var(--accent)",
    "#A88BFF": "var(--accent)",
    "#A48BFF": "var(--accent)",
}
ACCENT_SOFT = {
    "#F1ECFF": "var(--accent-soft)",
    "#F3EEFF": "var(--accent-soft)",
    "#F5F0FF": "var(--accent-soft)",
    "#F6F2FF": "var(--accent-soft)",
    "#F7F5FF": "var(--accent-soft)",
    "#F7F4FF": "var(--accent-soft)",
    "#F8F5FF": "var(--accent-soft)",
    "#F8F7FC": "var(--accent-soft)",
    "#FAF8FF": "var(--accent-soft)",
    "#FBF8FF": "var(--accent-soft)",
    "#EFE8FF": "var(--accent-soft)",
    "#E7DFFC": "var(--accent-soft)",
    "#FAF9FF": "var(--accent-soft-weak)",
    "#FBFAFF": "var(--accent-soft-weak)",
}
ACCENT_LINE = {
    "#C9B8FF": "var(--accent-line)",
    "#D6C9FF": "var(--accent-line)",
    "#DCD4F7": "var(--accent-line)",
    "#D9D0F8": "var(--accent-line)",
    "#C3B4FF": "var(--accent-line)",
    "#EAE3FF": "var(--accent-line-soft)",
    "#E5DDFF": "var(--accent-line-soft)",
}
ACCENT_MUTED = {
    "#B9A8FF": "var(--accent-muted)",
    "#C9B8FF": "var(--accent-muted)",
    "#8A82B8": "var(--accent-faint)",
    "#7E78A8": "var(--accent-faint)",
}
ACCENT_INK = {
    "#3A2F7A": "var(--accent-ink)",
    "#5B4BC4": "var(--accent-ink)",
    "#4B3F8F": "var(--accent-ink)",
}

# ----------------------------- 중립 표면 -----------------------------
DARK_BG = {
    "#FFFFFF": "var(--pa-surface)",
    "#FCFCFE": "var(--pa-surface-2)",
    "#FBFBFD": "var(--pa-surface-2)",
    "#FDFDFF": "var(--pa-surface-2)",
    "#FEFEFF": "var(--pa-surface-2)",
    "#F6F6FA": "var(--pa-bg)",
    "#F6F4FB": "var(--pa-line-soft)",
    "#FAF9FD": "var(--pa-surface-3)",
    "#FBF9FE": "var(--pa-surface-3)",
    "#F4F3F9": "var(--pa-surface-3)",
    "#FAF8FD": "var(--pa-surface-3)",
    "#F9F8FC": "var(--pa-surface-3)",
    "#FAFAFC": "var(--pa-surface-3)",
    "#FCFAFE": "var(--pa-surface-3)",
}


# 색 이름으로 쓰는 토큰(bg-white 등) — 다크에서 변수로 갈아 끼운다.
TOKEN_RULES = [
    ("html.dark .bg-white", "background-color: var(--pa-surface);"),
    ("html.dark .bg-pomong-bg", "background-color: var(--pa-bg);"),
    ("html.dark .bg-pomong-lavender", "background-color: var(--accent-soft);"),
    ("html.dark .text-pomong-ink", "color: var(--pa-ink);"),
    ("html.dark .text-pomong-sub", "color: var(--pa-mute);"),
    ("html.dark .border-pomong-line", "border-color: var(--pa-line);"),
    ("html.dark .border-white", "border-color: var(--pa-surface);"),
    ("html.dark .bg-white\\/60", "background-color: var(--pa-surface);"),
    ("html.dark .bg-white\\/70", "background-color: var(--pa-surface);"),
    ("html.dark .bg-white\\/80", "background-color: var(--pa-surface);"),
    ("html.dark .bg-white\\/90", "background-color: var(--pa-surface);"),
    ("html.dark .bg-white\\/95", "background-color: var(--pa-surface);"),
]
# 실제 화면에서 쓰는 투명도 변형만 남긴다(위 목록에 없는 값은 무시).
TOKEN_RE_NAMES = ("bg-white/60", "bg-white/70", "bg-white/80", "bg-white/90", "bg-white/95")


def dark_for(hex_color: str) -> str:
    h, s, l = hsl(hex_color)
    if s < 0.09:
        h, s = 258.0, 0.06
    if l >= 0.965:
        return from_hsl(h, min(s, 0.10), 0.115)
    if l >= 0.945:
        return from_hsl(h, min(s, 0.12), 0.135)
    if l >= 0.90:
        return from_hsl(h, min(s, 0.16), 0.17)
    if l >= 0.85:
        return from_hsl(h, min(s, 0.20), 0.21)
    if l >= 0.78:
        return from_hsl(h, min(s, 0.24), 0.25)
    if l >= 0.60:
        return from_hsl(h, min(s, 0.30), 0.32)
    return from_hsl(h, min(s, 0.35), 0.40)


def dark_text_for(hex_color: str) -> str:
    h, s, l = hsl(hex_color)
    colorful = s > 0.32
    if l <= 0.32:
        out = from_hsl(h, min(s, 0.28), 0.93)
    elif l <= 0.45:
        out = from_hsl(h, min(s, 0.32), 0.84)
    elif l <= 0.62:
        out = from_hsl(h, min(s, 0.38), 0.76)
    elif l <= 0.72:
        out = from_hsl(h, min(s, 0.30), 0.66)
    elif l <= 0.82:
        out = from_hsl(h, min(s, 0.25), 0.56)
    else:
        out = from_hsl(h, min(s, 0.20), 0.48)
    if colorful and l > 0.32:
        out = from_hsl(h, min(s, 0.62), min(0.82, l + 0.22))
    return out


def dark_line_for(hex_color: str) -> str:
    h, s, l = hsl(hex_color)
    if s > 0.45 and l < 0.75:
        return from_hsl(h, min(s, 0.50), 0.42)
    if l >= 0.90:
        return from_hsl(h, min(s, 0.18), 0.22)
    if l >= 0.80:
        return from_hsl(h, min(s, 0.20), 0.28)
    return from_hsl(h, min(s, 0.25), 0.34)


# ----------------------------- 수집 -----------------------------
TOKEN_RE = re.compile(
    r"""(?:(?<=^)|(?<=[\s"'`]))"""
    r"""((?:(?:[a-z-]+):)*(?:bg|text|border|ring|divide|from|to|via|placeholder|fill|stroke)-\[#[0-9a-fA-F]{3,8}\](?:/\d+)?)"""
    r"""(?=$|[\s"'`])""",
    re.MULTILINE,
)
UTIL_RE = re.compile(
    r"^(bg|text|border|ring|divide|from|to|via|placeholder|fill|stroke)-\[(#[0-9a-fA-F]{3,8})\](?:/\d+)?$"
)


def collect() -> set[str]:
    found: set[str] = set()
    for path in SRC.rglob("*"):
        if path.suffix not in {".ts", ".tsx"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in TOKEN_RE.finditer(text):
            found.add(match.group(1))
    return found


def prop_for(kind: str) -> str | None:
    if kind == "bg":
        return "background-color"
    if kind in ("fill", "stroke"):
        return kind
    if kind in ("text", "placeholder"):
        return "color"
    if kind in ("from", "to"):
        return f"--tw-gradient-{kind}"
    if kind == "ring":
        return "--tw-ring-color"
    if kind == "divide":
        return "border-color"
    if kind == "border":
        return "border-color"
    return None


PSEUDO = {"hover": ":hover", "focus": ":focus", "active": ":active", "disabled": ":disabled", "visited": ":visited"}


def css_escape(cls: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", lambda m: "\\" + m.group(0), cls)


def selector_for(cls: str, dark: bool) -> str:
    parts = cls.split(":")
    parts.pop()
    pseudo = ""
    group = False
    for variant in parts:
        if variant in PSEUDO:
            pseudo += PSEUDO[variant]
        elif variant == "group-hover":
            group = True
        elif variant == "placeholder":
            pseudo += "::placeholder"
    return f"{'html.dark ' if dark else ''}{'.group:hover ' if group else ''}.{css_escape(cls)}{pseudo}"


def main() -> None:
    classes = collect()
    accent_rules: list[str] = []
    dark_rules: list[str] = []
    seen: set[str] = set()

    for cls in sorted(classes):
        utility = cls.split(":")[-1]
        match = UTIL_RE.match(utility)
        if not match:
            continue
        kind, hex_raw = match.group(1), match.group(2)
        hex_color = hex_raw.upper()
        alpha = "/" in utility.split("]")[-1]
        if alpha and hex_color not in DARK_BG:
            # 투명도 있는 어두운 오버레이(bg-[#1F1D2B]/30 등)는 라이트·다크 모두 그대로 둔다.
            continue

        accent_var = None
        if kind in ("text", "placeholder"):
            accent_var = ACCENT_TEXT.get(hex_color) or ACCENT_MUTED.get(hex_color) or ACCENT_INK.get(hex_color)
        if accent_var is None and kind == "bg":
            accent_var = ACCENT_FILL.get(hex_color) or ACCENT_SOFT.get(hex_color)
        if accent_var is None and kind in ("from", "to"):
            accent_var = ACCENT_FILL.get(hex_color) or ACCENT_SOFT.get(hex_color)
        if accent_var is None and kind in ("border", "ring", "divide"):
            accent_var = ACCENT_LINE.get(hex_color) or ACCENT_SOFT.get(hex_color)
        if accent_var is None and kind in ("fill", "stroke"):
            accent_var = ACCENT_FILL.get(hex_color)

        if accent_var:
            prop = prop_for(kind)
            if prop:
                extra = ""
                if kind == "bg" and hex_color in ACCENT_FILL:
                    # 채워진 포인트 배지·버튼은 글자색도 대비에 맞춘다(노란 포인트에서 흰 글자 방지).
                    extra = " color: var(--accent-contrast);"
                accent_rules.append(f"{selector_for(cls, False)} {{ {prop}: {accent_var};{extra} }}")
            continue

        if alpha and hex_color not in DARK_BG:
            continue

        if kind == "bg":
            value = DARK_BG.get(hex_color) or dark_for(hex_color)
        elif kind in ("text", "placeholder", "fill", "stroke"):
            value = dark_text_for(hex_color)
        elif kind in ("border", "ring", "divide"):
            value = dark_line_for(hex_color)
        elif kind in ("from", "to"):
            value = dark_for(hex_color)
        else:
            continue

        prop = prop_for(kind)
        if not prop:
            continue
        selector = selector_for(cls, True)
        if (selector, prop) in seen:
            continue
        seen.add((selector, prop))
        dark_rules.append(f"{selector} {{ {prop}: {value}; }}")

    header = (
        "/*\n"
        " * AUTO-GENERATED by scripts/theme_css.py — 직접 고치지 말고 생성기를 돌려 주세요.\n"
        " *   python3 scripts/theme_css.py\n"
        " * 포인트 컬러: var(--accent*) / 다크 테마: html.dark 아래 규칙\n"
        " */\n"
    )
    token_lines = [f"{sel} {{ {decl} }}" for sel, decl in TOKEN_RULES]
    body = (
        f"{header}\n/* ---------- 포인트 컬러 ---------- */\n"
        + "\n".join(accent_rules)
        + "\n\n/* ---------- 다크 테마 ---------- */\n"
        + "\n".join(token_lines)
        + "\n"
        + "\n".join(dark_rules)
        + "\n"
    )
    OUT.write_text(body, encoding="utf-8")
    print(f"classes: {len(classes)}, accent rules: {len(accent_rules)}, dark rules: {len(dark_rules)}")
    print(f"written: {OUT.relative_to(ROOT)}")

    if "--table" in sys.argv:
        for cls in sorted(classes):
            utility = cls.split(":")[-1]
            m = UTIL_RE.match(utility)
            if not m:
                continue
            kind, hex_raw = m.group(1), m.group(2).upper()
            if kind == "bg":
                mapped = DARK_BG.get(hex_raw) or dark_for(hex_raw)
            elif kind == "text":
                mapped = dark_text_for(hex_raw)
            elif kind in ("border", "ring", "divide"):
                mapped = dark_line_for(hex_raw)
            else:
                mapped = "-"
            print(f"{cls}\t{hex_raw}\t{mapped}")


if __name__ == "__main__":
    main()
