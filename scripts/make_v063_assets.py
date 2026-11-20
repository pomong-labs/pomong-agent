#!/usr/bin/env python3
"""v0.6.3 자산 생성

1) public/pomong-labs-logo.png
   - 글자(O·A·B 안쪽 구멍)와 외곽에 남은 흰/회색 잔여물을 투명하게 정리
2) public/pomong-labs-logo-dark.png
   - 다크모드용: 글자를 선명한 흰색(#FFFFFF)으로
3) public/splash/{W}x{H}-{light|dark}.png
   - iOS PWA 시작 화면(마스코트 + 로고)
"""
from __future__ import annotations

import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")


def luminance(r: int, g: int, b: int) -> float:
    return 0.299 * r + 0.587 * g + 0.114 * b


def clean_wordmark(img: Image.Image, color_map: dict[str, tuple[int, int, int]] | None) -> Image.Image:
    """텍스트 영역(x>=290)의 잉크를 알파 마스크로 다시 만든다.

    - 흰 카운터(글자 구멍)와 잔여 배경은 알파 0
    - color_map 이 있으면 영역별로 단색으로 다시 칠한다(다크모드 흰 로고).
    """
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    TEXT_X = 290
    # POMONG(어두운 회색) / LABS(연한 회색) 의 기준 휘도
    for x in range(TEXT_X, w):
        base_lum = 76.0 if x < 860 else 181.0
        base_cov = max(0.02, 1.0 - base_lum / 255.0)
        for y in range(h):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            lum = luminance(r, g, b)
            cov = (1.0 - lum / 255.0) / base_cov
            cov = max(0.0, min(1.0, cov))
            if cov < 0.035:
                px[x, y] = (0, 0, 0, 0)
                continue
            alpha = int(round(a * cov))
            if color_map:
                key = "main" if x < 860 else "sub"
                cr, cg, cb = color_map[key]
                px[x, y] = (cr, cg, cb, alpha)
            else:
                px[x, y] = (r, g, b, alpha)
    return img


def build_logos() -> None:
    src_path = os.path.join(PUBLIC, "pomong-labs-logo.png")
    src = Image.open(src_path)
    light = clean_wordmark(src, None)
    light.save(os.path.join(PUBLIC, "pomong-labs-logo.png"), optimize=True)

    dark = clean_wordmark(src, {"main": (255, 255, 255), "sub": (255, 255, 255)})
    dark.save(os.path.join(PUBLIC, "pomong-labs-logo-dark.png"), optimize=True)
    print("logos: ok")


def build_splash() -> None:
    out_dir = os.path.join(PUBLIC, "splash")
    os.makedirs(out_dir, exist_ok=True)
    mascot = Image.open(os.path.join(PUBLIC, "mascots", "pimong-hero.png")).convert("RGBA")
    light_logo = Image.open(os.path.join(PUBLIC, "pomong-labs-logo.png")).convert("RGBA")
    dark_logo = Image.open(os.path.join(PUBLIC, "pomong-labs-logo-dark.png")).convert("RGBA")

    sizes = [(1170, 2532), (1179, 2556), (1290, 2796), (1125, 2436)]
    for width, height in sizes:
        for theme in ("light", "dark"):
            bg_color = (251, 251, 253, 255) if theme == "light" else (16, 15, 22, 255)
            canvas = Image.new("RGBA", (width, height), bg_color)
            # 마스코트: 화면 폭의 46%
            mw = int(width * 0.46)
            mh = int(mascot.height * (mw / mascot.width))
            pet = mascot.resize((mw, mh), Image.LANCZOS)
            logo_src = light_logo if theme == "light" else dark_logo
            lw = int(width * 0.42)
            lh = int(logo_src.height * (lw / logo_src.width))
            logo = logo_src.resize((lw, lh), Image.LANCZOS)
            # 세로 중앙: 마스코트 + 40px + 로고
            gap = max(24, int(height * 0.018))
            total = mh + gap + lh
            top = (height - total) // 2
            canvas.alpha_composite(pet, ((width - mw) // 2, top))
            canvas.alpha_composite(logo, ((width - lw) // 2, top + mh + gap))
            canvas.convert("RGB").save(os.path.join(out_dir, f"{width}x{height}-{theme}.png"), optimize=True)
    print("splash: ok")


if __name__ == "__main__":
    build_logos()
    build_splash()
