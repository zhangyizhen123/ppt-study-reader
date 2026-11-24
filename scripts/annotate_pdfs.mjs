#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, rgb } from "pdf-lib";

function parseArgs() {
  let manifestPath = path.join(os.tmpdir(), "ppt_annot_manifest.json");
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === "--manifest" && process.argv[i + 1]) {
      manifestPath = process.argv[++i];
    } else if (a.startsWith("--manifest=")) {
      manifestPath = a.slice("--manifest=".length);
    }
  }
  return { manifestPath };
}

const STRIPE_COLORS = {
  high: rgb(22 / 255, 163 / 255, 74 / 255),
  medium: rgb(217 / 255, 119 / 255, 6 / 255),
  low: rgb(220 / 255, 38 / 255, 38 / 255),
};

async function main() {
  const { manifestPath } = parseArgs();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let totalPages = 0;

  for (const deck of manifest.decks) {
    const srcBytes = fs.readFileSync(deck.srcPath);
    const pdfDoc = await PDFDocument.load(srcBytes);
    const pages = pdfDoc.getPages();

    if (pages.length !== deck.pageCount) {
      throw new Error(`Page count mismatch for ${deck.file}: ${pages.length} vs ${deck.pageCount}`);
    }

    for (const item of deck.items) {
      const page = pages[item.page - 1];
      const { width, height } = page.getSize();
      const pngBytes = fs.readFileSync(item.png);
      const img = await pdfDoc.embedPng(pngBytes);

      const stripeH = Math.max(3.0, Math.min(4.5, height * 0.0065));
      page.drawRectangle({
        x: 0,
        y: height - stripeH,
        width,
        height: stripeH,
        color: STRIPE_COLORS[item.priority] || STRIPE_COLORS.medium,
        opacity: 0.92,
      });

      const refW = item.pageWidth || 720.0;
      const refH = item.pageHeight || 540.0;
      const scaleX = width / refW;
      const scaleY = height / refH;
      page.drawImage(img, {
        x: item.x * scaleX,
        y: item.y * scaleY,
        width: item.w * scaleX,
        height: item.h * scaleY,
      });
    }

    fs.mkdirSync(path.dirname(deck.dstPath), { recursive: true });
    const outBytes = await pdfDoc.save({ useObjectStreams: true });
    fs.writeFileSync(deck.dstPath, outBytes);
    totalPages += pages.length;
    console.log(`Saved annotated PDF: ${deck.dstPath} (${pages.length} pages)`);
  }

  console.log(`All ${manifest.decks.length} annotated PDFs generated (${totalPages} total pages).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
