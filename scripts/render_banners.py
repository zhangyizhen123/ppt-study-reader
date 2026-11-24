#!/usr/bin/env python3
"""Compute collision-free placements and render 3x PNG annotation banners for arbitrary slide sizes."""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from PIL import Image, ImageDraw, ImageFont

from _tools import apply_tool_env

SCALE = 3

FONT_CANDIDATES = [
    # Linux / WSL Noto Sans CJK (index 2 = SC in TTC)
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 2),
    ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc", 2),
    # WenQuanYi Zen Hei
    ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
    # WSL -> Windows Fonts
    ("/mnt/c/Windows/Fonts/msyh.ttc", "/mnt/c/Windows/Fonts/msyhbd.ttc", 0),
    ("/mnt/c/Windows/Fonts/simhei.ttf", "/mnt/c/Windows/Fonts/simhei.ttf", 0),
    # Native Windows
    ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc", 0),
    ("C:/Windows/Fonts/simhei.ttf", "C:/Windows/Fonts/simhei.ttf", 0),
    # macOS PingFang / STHeiti
    ("/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/PingFang.ttc", 0),
    ("/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/STHeiti Medium.ttc", 0),
]

THEMES = {
    "high": {
        "badge_label": "★ 重点精读",
        "pill_short": "★ 重点",
        "badge_bg": (22, 163, 74, 245),
        "strip_bg": (236, 253, 245, 240),
        "border": (134, 239, 172, 255),
        "tip_fg": (6, 95, 70, 255),
        "meta_fg": (4, 120, 87, 255),
    },
    "medium": {
        "badge_label": "● 速览了解",
        "pill_short": "● 速览",
        "badge_bg": (217, 119, 6, 245),
        "strip_bg": (255, 251, 235, 240),
        "border": (253, 230, 138, 255),
        "tip_fg": (120, 53, 15, 255),
        "meta_fg": (180, 83, 9, 255),
    },
    "low": {
        "badge_label": "○ 可跳过",
        "pill_short": "○ 跳过",
        "badge_bg": (220, 38, 38, 235),
        "strip_bg": (254, 242, 242, 240),
        "border": (252, 165, 165, 255),
        "tip_fg": (127, 29, 29, 255),
        "meta_fg": (185, 28, 28, 255),
    },
}


def resolve_fonts(reg_override: str, bold_override: str):
    if reg_override and os.path.exists(reg_override):
        b = bold_override if bold_override and os.path.exists(bold_override) else reg_override
        return reg_override, b, 0
    for reg, bold, idx in FONT_CANDIDATES:
        if os.path.exists(reg):
            return reg, bold if os.path.exists(bold) else reg, idx
    print(
        "WARNING: No CJK font found; falling back to Pillow default font. Pass --font-regular to specify one.",
        file=sys.stderr,
    )
    return None, None, 0


class FontSet:
    def __init__(self, reg_path, bold_path, index):
        if reg_path:
            self.full_bold = ImageFont.truetype(bold_path, 25, index=index)
            self.full_reg = ImageFont.truetype(reg_path, 24, index=index)
            self.full_meta = ImageFont.truetype(bold_path, 23, index=index)
            self.pill_bold = ImageFont.truetype(bold_path, 23, index=index)
            self.pill_reg = ImageFont.truetype(reg_path, 22, index=index)
            self.mini_bold = ImageFont.truetype(bold_path, 19, index=index)
            self.mini_reg = ImageFont.truetype(reg_path, 18, index=index)
        else:
            d = ImageFont.load_default()
            self.full_bold = self.full_reg = self.full_meta = d
            self.pill_bold = self.pill_reg = self.mini_bold = self.mini_reg = d


def extract_page_bboxes(pdf_path: str):
    out = subprocess.check_output(["pdftotext", "-bbox", pdf_path, "-"], text=True, encoding="utf-8", errors="ignore")
    chunks = out.split("<page ")[1:]
    pages = []
    size_pat = re.compile(r'width="([\d.]+)"\s+height="([\d.]+)"')
    word_pat = re.compile(r'xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)"')
    for chunk in chunks:
        sm = size_pat.search(chunk)
        pw = float(sm.group(1)) if sm else 720.0
        ph = float(sm.group(2)) if sm else 540.0
        words = [(float(a), float(b), float(c), float(d)) for a, b, c, d in word_pat.findall(chunk)]
        pages.append((pw, ph, words))
    return pages


def collides(rect, words, pad=2.0):
    rx1, ry1, rx2, ry2 = rect
    for x1, y1, x2, y2 in words:
        if x2 + pad > rx1 and x1 - pad < rx2 and y2 + pad > ry1 and y1 - pad < ry2:
            return True
    return False


def choose_slot(pw, ph, words):
    """Return (kind, x, y_top, w, h) in top-left PDF points for arbitrary page size."""
    margin_x = max(8.0, min(14.0, pw * 0.014))
    full_w = pw - margin_x * 2
    full_h = 19.0
    full_yt = ph - full_h - 2.0

    if not collides((margin_x, full_yt, margin_x + full_w, full_yt + full_h), words, pad=1.5):
        return ("full", margin_x, full_yt, full_w, full_h)

    pill_w = min(220.0, pw * 0.31)
    pill_h = 17.0
    candidates = [
        ("pill", pw - pill_w - margin_x, 5.0, pill_w, pill_h),
        ("pill", margin_x, 5.0, pill_w, pill_h),
        ("pill", margin_x, ph - pill_h - 3.0, pill_w, pill_h),
        ("pill", pw - pill_w - margin_x, ph - pill_h - 3.0, pill_w, pill_h),
        ("mini", pw - min(204.0, pw * 0.28) - margin_x, 4.0, min(204.0, pw * 0.28), 13.0),
    ]
    for kind, x, yt, w, h in candidates:
        if not collides((x, yt, x + w, yt + h), words, pad=1.0):
            return (kind, x, yt, w, h)

    return ("mini", pw - min(204.0, pw * 0.28) - margin_x, 4.0, min(204.0, pw * 0.28), 13.0)


def fit_text(draw, text, font, max_w):
    if draw.textlength(text, font=font) <= max_w:
        return text
    cur = text
    while len(cur) > 2 and draw.textlength(cur + "…", font=font) > max_w:
        cur = cur[:-1]
    return cur + "…"


def render_banner_png(out_path, kind, w_pt, h_pt, page_info, deck_day, page_count, fonts: FontSet):
    w_px = int(round(w_pt * SCALE))
    h_px = int(round(h_pt * SCALE))
    prio = page_info["priority"]
    th = THEMES[prio]

    img = Image.new("RGBA", (w_px, h_px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if kind == "full":
        draw.rounded_rectangle(
            [0, 0, w_px - 1, h_px - 1],
            radius=12,
            fill=th["strip_bg"],
            outline=th["border"],
            width=2,
        )

        badge_text = f"{th['badge_label']} · {page_info['tag']}"
        bw = int(draw.textlength(badge_text, font=fonts.full_bold)) + 30
        draw.rounded_rectangle([3, 3, 3 + bw, h_px - 4], radius=10, fill=th["badge_bg"])
        draw.text((18, h_px // 2), badge_text, font=fonts.full_bold, fill=(255, 255, 255, 255), anchor="lm")

        day_prefix = f"Day {deck_day} · " if deck_day and deck_day > 0 else ""
        meta_text = f"{day_prefix}P{page_info['page']}/{page_count}"
        mw = int(draw.textlength(meta_text, font=fonts.full_meta)) + 24
        draw.text((w_px - 16, h_px // 2), meta_text, font=fonts.full_meta, fill=th["meta_fg"], anchor="rm")

        tip_x = 3 + bw + 18
        tip_max_w = max(80, (w_px - mw - 18) - tip_x)
        tip = fit_text(draw, page_info["tip"], fonts.full_reg, tip_max_w)
        draw.text((tip_x, h_px // 2), tip, font=fonts.full_reg, fill=th["tip_fg"], anchor="lm")
    else:
        f_bold = fonts.pill_bold if kind == "pill" else fonts.mini_bold
        f_reg = fonts.pill_reg if kind == "pill" else fonts.mini_reg
        r = 11 if kind == "pill" else 8

        draw.rounded_rectangle(
            [0, 0, w_px - 1, h_px - 1],
            radius=r,
            fill=th["strip_bg"],
            outline=th["border"],
            width=2,
        )
        badge_text = th["pill_short"]
        bw = int(draw.textlength(badge_text, font=f_bold)) + 20
        draw.rounded_rectangle([2, 2, 2 + bw, h_px - 3], radius=r - 2, fill=th["badge_bg"])
        draw.text((12, h_px // 2), badge_text, font=f_bold, fill=(255, 255, 255, 255), anchor="lm")

        day_prefix = f"D{deck_day} " if deck_day and deck_day > 0 else ""
        right_txt = f"{page_info['tag']} · {day_prefix}P{page_info['page']}"
        rx = 2 + bw + 12
        right_fitted = fit_text(draw, right_txt, f_reg, max(40, w_px - rx - 10))
        draw.text((rx, h_px // 2), right_fitted, font=f_reg, fill=th["tip_fg"], anchor="lm")

    img.save(out_path, format="PNG", compress_level=6)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--course-dir", required=True)
    parser.add_argument("--annotations", required=True)
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--cache-dir", default=os.path.join(tempfile.gettempdir(), "ppt_annot_banners"))
    parser.add_argument("--manifest", default=os.path.join(tempfile.gettempdir(), "ppt_annot_manifest.json"))
    parser.add_argument("--font-regular", default="")
    parser.add_argument("--font-bold", default="")
    args = parser.parse_args()

    course_dir = os.path.abspath(args.course_dir)
    out_dir = os.path.abspath(args.out_dir) if args.out_dir else os.path.join(course_dir, "标注版PPT")

    with open(args.annotations, "r", encoding="utf-8") as f:
        ann = json.load(f)

    reg_path, bold_path, font_idx = resolve_fonts(args.font_regular, args.font_bold)
    fonts = FontSet(reg_path, bold_path, font_idx)

    os.makedirs(args.cache_dir, exist_ok=True)
    os.makedirs(os.path.dirname(os.path.abspath(args.manifest)), exist_ok=True)

    manifest = {"decks": []}
    slot_counts = {"full": 0, "pill": 0, "mini": 0}

    for deck_idx, deck in enumerate(ann["decks"]):
        fname = deck["file"]
        pdf_path = os.path.join(course_dir, fname)
        per_page = extract_page_bboxes(pdf_path)
        assert len(per_page) == deck["pageCount"], f"bbox page count mismatch for {fname}"

        items = []
        for pinfo in deck["pages"]:
            pnum = pinfo["page"]
            pw, ph, words = per_page[pnum - 1]
            kind, x, yt, w, h = choose_slot(pw, ph, words)
            slot_counts[kind] += 1
            pdf_y = ph - (yt + h)
            png_path = os.path.join(args.cache_dir, f"d{deck_idx+1}_p{pnum:03d}.png")
            render_banner_png(
                png_path, kind, w, h, pinfo, deck.get("day", 0), deck["pageCount"], fonts
            )
            items.append({
                "page": pnum,
                "priority": pinfo["priority"],
                "kind": kind,
                "pageWidth": pw,
                "pageHeight": ph,
                "x": x,
                "y": pdf_y,
                "w": w,
                "h": h,
                "png": png_path,
            })

        manifest["decks"].append({
            "file": fname,
            "srcPath": pdf_path,
            "dstPath": os.path.join(out_dir, fname),
            "pageCount": deck["pageCount"],
            "items": items,
        })
        print(f"Rendered banners for {fname}: {len(items)} pages")

    with open(args.manifest, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)

    print("Placement stats:", slot_counts)


if __name__ == "__main__":
    apply_tool_env()
    main()
