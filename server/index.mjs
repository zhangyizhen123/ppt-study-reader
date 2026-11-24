#!/usr/bin/env node
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function parseArgs() {
  let dataDir = "/tmp/ppt-study-reader-data";
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    }
  }
  return { dataDir };
}

const { dataDir: DATA_DIR } = parseArgs();
const ENV_COURSE_DIR = (process.env.PPT_COURSE_DIR || "").trim();
const ENV_ANNOTATIONS_PATH = (process.env.PPT_ANNOTATIONS_PATH || "").trim();

const UI_HTML_PATH = path.join(PLUGIN_ROOT, "ui", "dist", "app.html");
const CROP_HELPER_PATH = path.join(PLUGIN_ROOT, "scripts", "crop_helper.py");

const CACHE_DIR = path.join(DATA_DIR, "cache");
const CROPS_DIR = path.join(DATA_DIR, "crops");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const OVERRIDES_PATH = path.join(DATA_DIR, "overrides.json");

const APP_URI = "ui://ppt-reader/app.html";
const MIME_TYPE = "text/html;profile=mcp-app";

fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(CROPS_DIR, { recursive: true });

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

function resolveCourseConfig(overrideCourseDir, overrideAnnPath) {
  const saved = readJsonSafe(STATE_PATH, {});
  const courseDir =
    (overrideCourseDir || "").trim() ||
    (saved.courseDir || "").trim() ||
    ENV_COURSE_DIR;

  let annotationsPath = (overrideAnnPath || "").trim();
  if (!annotationsPath && !overrideCourseDir && (saved.annotationsPath || "").trim()) {
    annotationsPath = saved.annotationsPath.trim();
  }
  if (!annotationsPath && !overrideCourseDir && ENV_ANNOTATIONS_PATH) {
    annotationsPath = ENV_ANNOTATIONS_PATH;
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
  if (!courseDir || !fs.existsSync(courseDir)) {
    return null;
  }
  const pdfFiles = fs
    .readdirSync(courseDir)
    .filter((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));

  if (!pdfFiles.length) {
    return null;
  }

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

const server = new Server(
  { name: "ppt-study-reader", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

const TOOLS = [
  {
    name: "open_ppt_reader",
    title: "打开 PPT 伴读",
    description:
      "在 Antigravity 侧边栏打开带重点分级标注的 PPT 交互伴读器，支持左键框选（文字与图表通吃）、长按选整行和划词向 AI 提问。",
    inputSchema: {
      type: "object",
      properties: {
        courseDir: {
          type: "string",
          description: "可选，包含课程 PDF 文件的本地文件夹绝对路径",
        },
        annotationsPath: {
          type: "string",
          description: "可选，study_annotations.json 路径（默认自动在课程目录或 标注版PPT/ 下查找）",
        },
        deck: {
          type: "string",
          description: "可选，要打开的课件文件名（如 01-导论.pdf）",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "可选，跳转页码（从 1 开始）",
        },
        filter: {
          type: "string",
          enum: ["all", "high", "nonlow"],
          description: "可选，筛选模式：all（全部）、high（只看重点）、nonlow（隐藏可跳过）",
        },
      },
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: APP_URI },
      "com.google.antigravity/ui": {
        entrypoints: [{ type: "aux_pane", title: "PPT 伴读" }],
      },
    },
  },
  {
    name: "app_list_decks",
    title: "List annotated PPT decks",
    description: "App-only: list all decks, per-page priority annotations, and last state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  {
    name: "app_get_slide",
    title: "Render a slide and extract word boxes",
    description: "App-only: render slide PNG and return word bounding boxes.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string" },
        page: { type: "integer", minimum: 1 },
      },
      required: ["deck", "page"],
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  {
    name: "app_crop_selection",
    title: "Crop selected region from cached slide PNG",
    description: "App-only: save a high-res PNG crop of the selected slide region.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string" },
        page: { type: "integer", minimum: 1 },
        nx1: { type: "number", minimum: 0, maximum: 1 },
        ny1: { type: "number", minimum: 0, maximum: 1 },
        nx2: { type: "number", minimum: 0, maximum: 1 },
        ny2: { type: "number", minimum: 0, maximum: 1 },
        selectedText: { type: "string" },
      },
      required: ["deck", "page", "nx1", "ny1", "nx2", "ny2"],
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
  {
    name: "app_set_slide_priority",
    title: "Update slide priority or tip override",
    description: "App-only: persist user priority override for a slide.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string" },
        page: { type: "integer", minimum: 1 },
        priority: { type: "string", enum: ["high", "medium", "low"] },
        tip: { type: "string" },
      },
      required: ["deck", "page", "priority"],
      additionalProperties: false,
    },
    _meta: {
      ui: { visibility: ["app"] },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: APP_URI,
        name: "PPT 伴读交互界面",
        description: "带重点分级标注与鼠标框选/长按提问的 PPT 阅读器",
        mimeType: MIME_TYPE,
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) {
    throw new Error(`Unknown resource URI: ${req.params.uri}`);
  }
  const html = fs.readFileSync(UI_HTML_PATH, "utf8");
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: MIME_TYPE,
        text: html,
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};

  try {
    if (name === "open_ppt_reader") {
      const annotations = await loadMergedAnnotations(
        args.courseDir,
        args.annotationsPath,
      );

      if (!annotations.configured) {
        return {
          content: [
            {
              type: "text",
              text: "尚未指定课程 PPT 目录。请在对话中告诉我你的课程 PDF 文件夹路径（或通过 open_ppt_reader 的 courseDir 参数传入，或在 mcp_config.json 中配置 PPT_COURSE_DIR）。",
            },
          ],
          structuredContent: {
            configured: false,
            courseDir: annotations.courseDir,
            decks: [],
          },
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
        content: [
          {
            type: "text",
            text: `已在侧边栏打开 PPT 伴读：${matchedDeck.title} 第 ${page}/${matchedDeck.pageCount} 页（筛选：${filter}）。可在右侧用左键拖拽框选（文字/图表通吃）或长按选中整行直接向我提问。`,
          },
        ],
        structuredContent: {
          configured: true,
          courseDir: annotations.courseDir,
          synthesized: Boolean(annotations.synthesized),
          initialDeck: deckName,
          initialPage: page,
          initialFilter: filter,
          totalPages: annotations.totalPages,
          decks: compactDecks,
        },
      };
    }

    if (name === "app_list_decks") {
      const annotations = await loadMergedAnnotations();
      const saved = readJsonSafe(STATE_PATH, {});
      return {
        content: [
          {
            type: "text",
            text: annotations.configured
              ? `Loaded ${annotations.decks.length} decks (${annotations.totalPages} pages).`
              : "Course directory not configured yet.",
          },
        ],
        structuredContent: {
          configured: annotations.configured,
          courseDir: annotations.courseDir,
          synthesized: Boolean(annotations.synthesized),
          totalPages: annotations.totalPages,
          summary: annotations.summary,
          savedState: saved,
          decks: annotations.decks,
        },
      };
    }

    if (name === "app_get_slide") {
      const annotations = await loadMergedAnnotations();
      if (!annotations.configured) {
        throw new Error("Course directory is not configured.");
      }
      const { deck, page } = validateDeckAndPage(annotations, args.deck, args.page);
      const { pngPath, bboxData } = await ensureSlideAssets(annotations, deck.file, page);
      const pngBytes = fs.readFileSync(pngPath);
      const imageDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
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
        content: [{ type: "text", text: `${deck.file} page ${page}/${deck.pageCount}` }],
        structuredContent: {
          deck: deck.file,
          deckTitle: deck.title,
          day: deck.day,
          page,
          pageCount: deck.pageCount,
          annotation: pageAnn,
          imageDataUrl,
          pageWidth: bboxData.pageWidth,
          pageHeight: bboxData.pageHeight,
          words: bboxData.words,
        },
      };
    }

    if (name === "app_crop_selection") {
      const annotations = await loadMergedAnnotations();
      if (!annotations.configured) {
        throw new Error("Course directory is not configured.");
      }
      const { deck, page } = validateDeckAndPage(annotations, args.deck, args.page);
      const { pngPath } = await ensureSlideAssets(annotations, deck.file, page);

      const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
      const nx1 = clamp01(args.nx1);
      const ny1 = clamp01(args.ny1);
      const nx2 = clamp01(args.nx2);
      const ny2 = clamp01(args.ny2);

      const cropName = `crop_${Date.now()}_${crypto.randomBytes(2).toString("hex")}.png`;
      const cropPath = path.join(CROPS_DIR, cropName);

      const { stdout } = await execFileAsync("python3", [
        CROP_HELPER_PATH,
        "--src",
        pngPath,
        "--dst",
        cropPath,
        "--nx1",
        String(nx1),
        "--ny1",
        String(ny1),
        "--nx2",
        String(nx2),
        "--ny2",
        String(ny2),
      ]);
      pruneOldCrops(40);
      const cropInfo = JSON.parse(stdout);
      return {
        content: [{ type: "text", text: `Saved crop: ${cropInfo.cropPath}` }],
        structuredContent: {
          cropPath: cropInfo.cropPath,
          width: cropInfo.width,
          height: cropInfo.height,
          selectedText: args.selectedText || "",
        },
      };
    }

    if (name === "app_set_slide_priority") {
      const annotations = await loadMergedAnnotations();
      if (!annotations.configured) {
        throw new Error("Course directory is not configured.");
      }
      const { deck, page } = validateDeckAndPage(annotations, args.deck, args.page);
      const prio = args.priority;
      if (!["high", "medium", "low"].includes(prio)) {
        throw new Error(`Invalid priority: ${prio}`);
      }
      const overrides = readJsonSafe(OVERRIDES_PATH, {});
      const key = `${annotations.courseDir}::${deck.file}::${page}`;
      const prev = overrides[key] || {};
      overrides[key] = {
        priority: prio,
        tip: typeof args.tip === "string" && args.tip.trim() ? args.tip.trim() : prev.tip,
      };
      writeJsonSafe(OVERRIDES_PATH, overrides);

      const updated = await loadMergedAnnotations();
      const updatedDeck = updated.decks.find((d) => d.file === deck.file);
      const pageAnn = updatedDeck.pages[page - 1];
      return {
        content: [{ type: "text", text: `Updated ${deck.file} p${page} -> ${prio}` }],
        structuredContent: {
          deck: deck.file,
          page,
          annotation: pageAnn,
          summary: updatedDeck.summary,
        },
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    console.error(`Tool error (${name}):`, err);
    return {
      isError: true,
      content: [{ type: "text", text: `Error in ${name}: ${err.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`ppt-study-reader MCP server started (dataDir=${DATA_DIR})`);
