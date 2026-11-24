#!/usr/bin/env python3
"""Crop a normalized selection rectangle from a cached slide PNG."""

import argparse
import json
import os
from PIL import Image


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", required=True)
    parser.add_argument("--dst", required=True)
    parser.add_argument("--nx1", type=float, required=True)
    parser.add_argument("--ny1", type=float, required=True)
    parser.add_argument("--nx2", type=float, required=True)
    parser.add_argument("--ny2", type=float, required=True)
    args = parser.parse_args()

    x1 = max(0.0, min(1.0, min(args.nx1, args.nx2)))
    y1 = max(0.0, min(1.0, min(args.ny1, args.ny2)))
    x2 = max(0.0, min(1.0, max(args.nx1, args.nx2)))
    y2 = max(0.0, min(1.0, max(args.ny1, args.ny2)))

    with Image.open(args.src) as im:
        w, h = im.size
        pad = 8
        px1 = max(0, int(x1 * w) - pad)
        py1 = max(0, int(y1 * h) - pad)
        px2 = min(w, int(x2 * w) + pad)
        py2 = min(h, int(y2 * h) + pad)

        if px2 - px1 < 20:
            cx = (px1 + px2) // 2
            px1 = max(0, cx - 12)
            px2 = min(w, cx + 12)
        if py2 - py1 < 20:
            cy = (py1 + py2) // 2
            py1 = max(0, cy - 12)
            py2 = min(h, cy + 12)

        cropped = im.crop((px1, py1, px2, py2))
        os.makedirs(os.path.dirname(args.dst), exist_ok=True)
        cropped.save(args.dst, format="PNG")
        cw, ch = cropped.size

    print(json.dumps({"cropPath": args.dst, "width": cw, "height": ch}))


if __name__ == "__main__":
    main()
