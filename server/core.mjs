import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CROP_ID_RE = /^crop_[a-zA-Z0-9_.-]+\.png$/;

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

function unescapeXml(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseBboxHtml(html) {
  const pageMatch = html.match(/<page\s+width="([\d.]+)"\s+height="([\d.]+)"/);
  const pageWidth = pageMatch ? parseFloat(pageMatch[1]) : 720;
  const pageHeight = pageMatch ? parseFloat(pageMatch[2]) : 540;
  const words = [];
  const wordRe =
    /<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([\s\S]*?)<\/word>/g;
  let m;
  while ((m = wordRe.exec(html)) !== null) {
    const text = unescapeXml(m[5]).trim();
    if (!text) continue;
    words.push({
      text,
      xMin: parseFloat(m[1]),
      yMin: parseFloat(m[2]),
      xMax: parseFloat(m[3]),
      yMax: parseFloat(m[4]),
    });
  }
  return { pageWidth, pageHeight, words };
}

function joinWordsSnippet(words, maxChars = 1200) {
  const text = words.map((w) => w.text).join(" ");
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

export function createPptCore({
  pluginRoot,
  dataDir,
  envCourseDir = "",
  envAnnotationsPath = "",
}) {
  const CACHE_DIR = path.join(dataDir, "cache");
  const CROPS_DIR = path.join(dataDir, "crops");
  const STATE_PATH = path.join(dataDir, "state.json");
  const OVERRIDES_PATH = path.join(dataDir, "overrides.json");
  const PENDING_PATH = path.join(dataDir, "pending_question.json");
  const CROP_HELPER_PATH = path.join(pluginRoot, "scripts", "crop_helper.py");

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(CROPS_DIR, { recursive: true });

  function resolveCourseConfig(overrideCourseDir, overrideAnnPath) {
    const saved = readJsonSafe(STATE_PATH, {});
    const courseDir =
      (overrideCourseDir || "").trim() ||
      (saved.courseDir || "").trim() ||
      envCourseDir.trim();

    let annotationsPath = (overrideAnnPath || "").trim();
    if (!annotationsPath && !overrideCourseDir && (saved.annotationsPath || "").trim()) {
      annotationsPath = saved.annotationsPath.trim();
    }
    if (!annotationsPath && !overrideCourseDir && envAnnotationsPath.trim()) {
      annotationsPath = envAnnotationsPath.trim();
    }
    if (!annotationsPath && courseDir) {
      const candidates = [
        path.join(courseDir, "标注版PPT", "study_annotations.json"),
        path.join(courseDir, "study_annotations.json"),
      ];
      annotationsPath = candidates.find((p) => fs.existsSync(p)) || "";
    }
    return { courseDir, annotationsPath, saved };
  }

  async function getPdfPageCount(pdfPath) {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath], {
      maxBuffer: 2 * 1024 * 1024,
    });
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith("Pages:")) {
        const n = parseInt(line.slice("Pages:".length).trim(), 10);
        if (Number.isInteger(n) && n > 0) return n;
      }
    }
    throw new Error(`Could not determine page count for ${pdfPath}`);
  }

  async function synthesizeAnnotationsFromDir(courseDir) {
    if (!courseDir || !fs.existsSync(courseDir)) return null;
    const pdfFiles = fs
      .readdirSync(courseDir)
      .filter((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."))
      .sort((a, b) => a.localeCompare(b, "zh-CN"));

    if (!pdfFiles.length) return null;

    const decks = [];
    let totalPages = 0;
    for (const file of pdfFiles) {
      const fullPath = path.join(courseDir, file);
      const pageCount = await getPdfPageCount(fullPath);
      totalPages += pageCount;
      const title = file.replace(/\.pdf$/i, "");
      const pages = [];
      for (let p = 1; p <= pageCount; p++) {
        pages.push({
          page: p,
          priority: "medium",
          tag: "未分级",
          title: `第 ${p} 页`,
          tip: "尚未生成 AI 标注：可点击左侧分级徽章手动标记，或让 AI 按课程大纲批量生成重点标注",
        });
      }
      decks.push({
        file,
        title,
        day: 1,
        pageCount,
        summary: { high: 0, medium: pageCount, low: 0 },
        pages,
      });
    }

    return {
      courseDir,
      annotatedDir: path.join(courseDir, "标注版PPT"),
      synthesized: true,
      totalPages,
      summary: { high: 0, medium: totalPages, low: 0 },
      decks,
    };
  }

  async function loadMergedAnnotations(overrideCourseDir, overrideAnnPath) {
    const { courseDir, annotationsPath } = resolveCourseConfig(
      overrideCourseDir,
      overrideAnnPath,
    );

    let base = null;
    if (annotationsPath && fs.existsSync(annotationsPath)) {
      base = readJsonSafe(annotationsPath, null);
    }
    if (!base && courseDir) {
      base = await synthesizeAnnotationsFromDir(courseDir);
    }
    if (!base || !Array.isArray(base.decks) || !base.decks.length) {
      return {
        configured: false,
        courseDir: courseDir || "",
        annotationsPath: annotationsPath || "",
        totalPages: 0,
        summary: { high: 0, medium: 0, low: 0 },
        decks: [],
      };
    }

    const effectiveCourseDir = courseDir || base.courseDir || "";
    const overrides = readJsonSafe(OVERRIDES_PATH, {});
    const totalSummary = { high: 0, medium: 0, low: 0 };

    const decks = base.decks.map((d) => {
      const summary = { high: 0, medium: 0, low: 0 };
      const pages = d.pages.map((p) => {
        const key = `${effectiveCourseDir}::${d.file}::${p.page}`;
        const legacyKey = `${d.file}::${p.page}`;
        const ov = overrides[key] || overrides[legacyKey];
        const merged = ov
          ? {
              ...p,
              priority: ov.priority || p.priority,
              tip: typeof ov.tip === "string" && ov.tip.trim() ? ov.tip.trim() : p.tip,
              overridden: true,
            }
          : p;
        summary[merged.priority] = (summary[merged.priority] || 0) + 1;
        totalSummary[merged.priority] = (totalSummary[merged.priority] || 0) + 1;
        return merged;
      });
      return { ...d, summary, pages };
    });

    return {
      ...base,
      configured: true,
      courseDir: effectiveCourseDir,
      annotationsPath,
      summary: totalSummary,
      decks,
    };
  }

  function validateDeckAndPage(annotations, deckName, pageNum) {
    const deck = annotations.decks.find((d) => d.file === deckName);
    if (!deck) {
      throw new Error(`Unknown deck: ${deckName}`);
    }
    const page = Number(pageNum);
    if (!Number.isInteger(page) || page < 1 || page > deck.pageCount) {
      throw new Error(`Invalid page ${pageNum} for ${deckName} (1..${deck.pageCount})`);
    }
    return { deck, page };
  }

  function slideCacheKey(courseDir, deckFile) {
    return crypto
      .createHash("sha1")
      .update(`${courseDir}::${deckFile}`)
      .digest("hex")
      .slice(0, 14);
  }

  async function ensureSlideAssets(annotations, deckFile, page) {
    const courseDir = annotations.courseDir;
    const key = slideCacheKey(courseDir, deckFile);
    const pngPrefix = path.join(CACHE_DIR, `${key}_p${page}`);
    const pngPath = `${pngPrefix}.png`;
    const bboxPath = path.join(CACHE_DIR, `${key}_p${page}.bbox.json`);

    const origPdfPath = path.join(courseDir, deckFile);
    if (!fs.existsSync(origPdfPath)) {
      throw new Error(`PDF file not found: ${origPdfPath}`);
    }

    if (!fs.existsSync(pngPath)) {
      await execFileAsync(
        "pdftoppm",
        ["-png", "-r", "150", "-f", String(page), "-l", String(page), "-singlefile", origPdfPath, pngPrefix],
        { maxBuffer: 15 * 1024 * 1024 },
      );
    }

    let bboxData = readJsonSafe(bboxPath, null);
    if (!bboxData) {
      const { stdout } = await execFileAsync(
        "pdftotext",
        ["-bbox", "-f", String(page), "-l", String(page), origPdfPath, "-"],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      bboxData = parseBboxHtml(stdout);
      writeJsonSafe(bboxPath, bboxData);
    }

    return { pngPath, bboxData };
  }

  function pruneOldCrops(maxKeep = 40) {
    try {
      const files = fs
        .readdirSync(CROPS_DIR)
        .filter((f) => f.endsWith(".png"))
        .map((f) => {
          const full = path.join(CROPS_DIR, f);
          return { full, mtime: fs.statSync(full).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      for (const item of files.slice(maxKeep)) {
        fs.unlinkSync(item.full);
      }
    } catch (err) {
      console.error("Failed to prune crops:", err);
    }
  }

  async function openReader(args = {}) {
    const annotations = await loadMergedAnnotations(args.courseDir, args.annotationsPath);
    if (!annotations.configured) {
      return {
        configured: false,
        courseDir: annotations.courseDir,
        decks: [],
      };
    }

    const saved = readJsonSafe(STATE_PATH, {});
    const sameCourse = saved.courseDir === annotations.courseDir;
    let deckName = args.deck || (sameCourse ? saved.deck : "") || annotations.decks[0].file;
    let matchedDeck = annotations.decks.find((d) => d.file === deckName);
    if (!matchedDeck) {
      matchedDeck = annotations.decks[0];
      deckName = matchedDeck.file;
    }

    let page = Number.isInteger(args.page)
      ? args.page
      : sameCourse
        ? saved.page || 1
        : 1;
    page = Math.max(1, Math.min(matchedDeck.pageCount, page));
    const filter = ["all", "high", "nonlow"].includes(args.filter)
      ? args.filter
      : saved.filter || "all";

    writeJsonSafe(STATE_PATH, {
      courseDir: annotations.courseDir,
      annotationsPath: annotations.annotationsPath,
      deck: deckName,
      page,
      filter,
    });

    const compactDecks = annotations.decks.map((d) => ({
      file: d.file,
      title: d.title,
      day: d.day,
      pageCount: d.pageCount,
      summary: d.summary,
    }));

    return {
      configured: true,
      courseDir: annotations.courseDir,
      synthesized: Boolean(annotations.synthesized),
      initialDeck: deckName,
      initialDeckTitle: matchedDeck.title,
      initialPage: page,
      initialDeckPageCount: matchedDeck.pageCount,
      initialFilter: filter,
      totalPages: annotations.totalPages,
      decks: compactDecks,
    };
  }

  async function listDecks() {
    const annotations = await loadMergedAnnotations();
    const saved = readJsonSafe(STATE_PATH, {});
    return {
      configured: annotations.configured,
      courseDir: annotations.courseDir,
      synthesized: Boolean(annotations.synthesized),
      totalPages: annotations.totalPages,
      summary: annotations.summary,
      savedState: saved,
      decks: annotations.decks,
    };
  }

  async function getSlide({ deck: deckName, page: pageNum }) {
    const annotations = await loadMergedAnnotations();
    if (!annotations.configured) {
      throw new Error("Course directory is not configured.");
    }
    const { deck, page } = validateDeckAndPage(annotations, deckName, pageNum);
    const { pngPath, bboxData } = await ensureSlideAssets(annotations, deck.file, page);
    const pngBytes = fs.readFileSync(pngPath);
    const base64 = pngBytes.toString("base64");
    const imageDataUrl = `data:image/png;base64,${base64}`;
    const pageAnn = deck.pages[page - 1];

    const prevSaved = readJsonSafe(STATE_PATH, {});
    writeJsonSafe(STATE_PATH, {
      ...prevSaved,
      courseDir: annotations.courseDir,
      annotationsPath: annotations.annotationsPath,
      deck: deck.file,
      page,
    });

    return {
      deck: deck.file,
      deckTitle: deck.title,
      day: deck.day,
      page,
      pageCount: deck.pageCount,
      annotation: pageAnn,
      imageDataUrl,
      base64,
      pngPath,
      pageWidth: bboxData.pageWidth,
      pageHeight: bboxData.pageHeight,
      words: bboxData.words,
      textSnippet: joinWordsSnippet(bboxData.words),
    };
  }

  async function cropSelection({ deck: deckName, page: pageNum, nx1, ny1, nx2, ny2, selectedText = "" }) {
    const annotations = await loadMergedAnnotations();
    if (!annotations.configured) {
      throw new Error("Course directory is not configured.");
    }
    const { deck, page } = validateDeckAndPage(annotations, deckName, pageNum);
    const { pngPath } = await ensureSlideAssets(annotations, deck.file, page);

    const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
    const cropId = `crop_${Date.now()}_${crypto.randomBytes(2).toString("hex")}.png`;
    const cropPath = path.join(CROPS_DIR, cropId);

    const { stdout } = await execFileAsync("python3", [
      CROP_HELPER_PATH,
      "--src",
      pngPath,
      "--dst",
      cropPath,
      "--nx1",
      String(clamp01(nx1)),
      "--ny1",
      String(clamp01(ny1)),
      "--nx2",
      String(clamp01(nx2)),
      "--ny2",
      String(clamp01(ny2)),
    ]);
    pruneOldCrops(40);
    const cropInfo = JSON.parse(stdout);
    return {
      cropId,
      cropPath: cropInfo.cropPath,
      width: cropInfo.width,
      height: cropInfo.height,
      selectedText,
    };
  }

  async function setSlidePriority({ deck: deckName, page: pageNum, priority, tip }) {
    const annotations = await loadMergedAnnotations();
    if (!annotations.configured) {
      throw new Error("Course directory is not configured.");
    }
    const { deck, page } = validateDeckAndPage(annotations, deckName, pageNum);
    if (!["high", "medium", "low"].includes(priority)) {
      throw new Error(`Invalid priority: ${priority}`);
    }
    const overrides = readJsonSafe(OVERRIDES_PATH, {});
    const key = `${annotations.courseDir}::${deck.file}::${page}`;
    const prev = overrides[key] || {};
    overrides[key] = {
      priority,
      tip: typeof tip === "string" && tip.trim() ? tip.trim() : prev.tip,
    };
    writeJsonSafe(OVERRIDES_PATH, overrides);

    const updated = await loadMergedAnnotations();
    const updatedDeck = updated.decks.find((d) => d.file === deck.file);
    return {
      deck: deck.file,
      page,
      annotation: updatedDeck.pages[page - 1],
      summary: updatedDeck.summary,
    };
  }

  function readCropImage({ cropId }) {
    if (typeof cropId !== "string" || !CROP_ID_RE.test(cropId)) {
      throw new Error(`Invalid cropId: ${cropId}`);
    }
    const resolvedDir = path.resolve(CROPS_DIR);
    const targetPath = path.resolve(resolvedDir, cropId);
    if (!targetPath.startsWith(resolvedDir + path.sep)) {
      throw new Error("Invalid crop path");
    }
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Crop image not found (may have expired): ${cropId}`);
    }
    const base64 = fs.readFileSync(targetPath).toString("base64");
    return {
      cropId,
      cropPath: targetPath,
      base64,
      mimeType: "image/png",
    };
  }

  function savePendingQuestion(payload) {
    const entry = {
      text: String(payload.text || ""),
      deck: String(payload.deck || ""),
      page: Number(payload.page) || 1,
      cropId: payload.cropId ? String(payload.cropId) : "",
      cropPath: payload.cropPath ? String(payload.cropPath) : "",
      question: String(payload.question || ""),
      savedAt: new Date().toISOString(),
      consumed: false,
    };
    writeJsonSafe(PENDING_PATH, entry);
    return entry;
  }

  function getPendingQuestion({ markConsumed = true } = {}) {
    const entry = readJsonSafe(PENDING_PATH, null);
    if (!entry || !entry.text) {
      return { found: false };
    }
    let cropImage = null;
    if (entry.cropId && CROP_ID_RE.test(entry.cropId)) {
      try {
        cropImage = readCropImage({ cropId: entry.cropId });
      } catch {
        cropImage = null;
      }
    }
    if (markConsumed && !entry.consumed) {
      writeJsonSafe(PENDING_PATH, { ...entry, consumed: true });
    }
    return {
      found: true,
      ...entry,
      cropImage,
    };
  }

  return {
    dataDir,
    openReader,
    listDecks,
    getSlide,
    cropSelection,
    setSlidePriority,
    readCropImage,
    savePendingQuestion,
    getPendingQuestion,
  };
}
