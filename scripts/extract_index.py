#!/usr/bin/env python3
"""Extract per-slide outlines and text snippets from all PDFs in a course folder."""

import argparse
import json
import os
import re
import subprocess


def get_page_count(pdf_path: str) -> int:
    info = subprocess.check_output(["pdfinfo", pdf_path], text=True, errors="ignore")
    for line in info.splitlines():
        if line.startswith("Pages:"):
            return int(line.split(":", 1)[1].strip())
    raise RuntimeError(f"Could not determine page count for {pdf_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Scan all PDFs in a course directory and dump slide summaries."
    )
    parser.add_argument("--course-dir", required=True, help="Directory containing course PDFs")
    parser.add_argument(
        "--out",
        default="",
        help="Output JSON path (default: <course-dir>/slides_dump.json)",
    )
    args = parser.parse_args()

    course_dir = os.path.abspath(args.course_dir)
    out_path = os.path.abspath(args.out) if args.out else os.path.join(course_dir, "slides_dump.json")

    pdfs = sorted(
        f
        for f in os.listdir(course_dir)
        if f.lower().endswith(".pdf") and not f.startswith(".")
    )
    if not pdfs:
        raise SystemExit(f"No PDF files found in {course_dir}")

    result = []
    total_pages = 0

    for fname in pdfs:
        pdf_path = os.path.join(course_dir, fname)
        n_pages = get_page_count(pdf_path)
        total_pages += n_pages

        txt = subprocess.check_output(["pdftotext", pdf_path, "-"], text=True, errors="ignore")
        raw_pages = txt.split("\f")
        if len(raw_pages) > n_pages and not raw_pages[-1].strip():
            raw_pages = raw_pages[:n_pages]
        while len(raw_pages) < n_pages:
            raw_pages.append("")

        pages_info = []
        for idx in range(n_pages):
            pg_txt = raw_pages[idx]
            lines = [re.sub(r"\s+", " ", l).strip() for l in pg_txt.splitlines() if l.strip()]
            clean_lines = [l for l in lines if not re.match(r"^\d+$", l)]
            first_3 = clean_lines[:3]
            snippet = " | ".join(clean_lines)[:400]
            pages_info.append({
                "page": idx + 1,
                "first_lines": first_3,
                "snippet": snippet,
                "char_count": len("".join(clean_lines)),
            })

        title = os.path.splitext(fname)[0]
        result.append({
            "file": fname,
            "title": title,
            "day": 1,
            "pageCount": n_pages,
            "pages": pages_info,
        })
        print(f"{fname}: {n_pages} pages")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(
            {"courseDir": course_dir, "totalPages": total_pages, "decks": result},
            f,
            ensure_ascii=False,
            indent=2,
        )

    print(f"Total pages extracted: {total_pages} -> {out_path}")


if __name__ == "__main__":
    main()
