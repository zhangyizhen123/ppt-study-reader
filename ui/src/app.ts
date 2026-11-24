import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";

type Priority = "high" | "medium" | "low";
type FilterMode = "all" | "high" | "nonlow";
type SelectMode = "box" | "text";

interface PageAnnotation {
  page: number;
  priority: Priority;
  tag: string;
  title: string;
  tip: string;
  overridden?: boolean;
}

interface DeckInfo {
  file: string;
  title: string;
  day: number;
  pageCount: number;
  summary: Record<Priority, number>;
  pages: PageAnnotation[];
}

interface WordBox {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface SlideData {
  deck: string;
  deckTitle: string;
  day: number;
  page: number;
  pageCount: number;
  annotation: PageAnnotation;
  imageDataUrl: string;
  pageWidth: number;
  pageHeight: number;
  words: WordBox[];
}

interface SelectionPayload {
  nx1: number;
  ny1: number;
  nx2: number;
  ny2: number;
  text: string;
  modeLabel: string;
  defaultCrop: boolean;
  anchorClientX: number;
  anchorClientY: number;
}

const PRIO_LABEL: Record<Priority, string> = {
  high: "★ 重点精读",
  medium: "● 速览了解",
  low: "○ 可跳过",
};

const QUICK_PROMPTS = [
  { label: "大白话讲讲", prompt: "请用零基础大白话把这一块讲清楚，它在这一章里起什么作用？" },
  { label: "举个例子", prompt: "请结合一个具体的例子或数值推导演示一下这里是怎么运作的。" },
  { label: "考点/易错点", prompt: "期末考试或做题时，这一块最常怎么考？初学者最容易踩什么坑？" },
  { label: "出题自测", prompt: "请针对我选中的这部分内容，出 2 道小自测题（附带解析）帮我检验是否真的理解了。" },
];

const isWebBridge = Boolean(
  (window as unknown as { __PPT_READER_WEB_MODE__?: boolean }).__PPT_READER_WEB_MODE__,
);
const app = isWebBridge ? null : new App({ name: "PPT 伴读", version: "1.0.0" }, {});

let decks: DeckInfo[] = [];
let currentDeckFile = "";
let currentPage = 1;
let filterMode: FilterMode = "all";
let selectMode: SelectMode = "box";
let zoomed = false;
let outlineOpen = false;
let currentDisplayMode: "inline" | "fullscreen" | "pip" = "inline";
let webTheme: "light" | "dark" = "light";
let currentSlide: SlideData | null = null;
const slideCache = new Map<string, SlideData>();

let pendingInitDeck: string | undefined;
let pendingInitPage: number | undefined;
let pendingInitFilter: FilterMode | undefined;
let activeSelection: SelectionPayload | null = null;
let isSending = false;

let dragState: {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startNx: number;
  startNy: number;
  curNx: number;
  curNy: number;
  isDragging: boolean;
  longPressFired: boolean;
  timer: number | null;
  matchedIndices: number[];
} | null = null;

const rootEl = document.getElementById("app")!;
let deckSelectEl!: HTMLSelectElement;
let filterGroupEl!: HTMLElement;
let modeGroupEl!: HTMLElement;
let zoomBtnEl!: HTMLButtonElement;
let outlineBtnEl!: HTMLButtonElement;
let fullscreenBtnEl!: HTMLButtonElement;
let themeToggleBtnEl!: HTMLButtonElement;
let ribbonEl!: HTMLElement;
let prioBtnEl!: HTMLButtonElement;
let tagBadgeEl!: HTMLElement;
let tipTextEl!: HTMLElement;
let stageScrollEl!: HTMLElement;
let slideFrameEl!: HTMLElement;
let slideImgEl!: HTMLImageElement;
let overlayLayerEl!: HTMLElement;
let textLayerEl!: HTMLElement;
let stageHintEl!: HTMLElement;
let outlineDrawerEl!: HTMLElement;
let prevBtnEl!: HTMLButtonElement;
let nextBtnEl!: HTMLButtonElement;
let pageInputEl!: HTMLInputElement;
let pageTotalEl!: HTMLElement;
let filterStatEl!: HTMLElement;
let askPopoverEl!: HTMLElement;
let askTitleEl!: HTMLElement;
let askPreviewEl!: HTMLElement;
let askCropCheckEl!: HTMLInputElement;
let askInputEl!: HTMLInputElement;
let askSendBtnEl!: HTMLButtonElement;
let askAttachBtnEl!: HTMLButtonElement;
let askFooterNoteEl!: HTMLElement;
let toastEl!: HTMLElement;
let toastTimer: number | null = null;

function showToast(msg: string) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove("show");
  }, 2800);
}

async function callServerTool(name: string, args: Record<string, unknown>) {
  if (isWebBridge) {
    const resp = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    const json = await resp.json();
    if (!resp.ok) {
      throw new Error(json.error || `HTTP ${resp.status}`);
    }
    return json as { structuredContent?: Record<string, unknown> };
  }
  return app!.callServerTool({ name, arguments: args });
}

async function copyTextSafe(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function renderShell() {
  rootEl.innerHTML = `
    <div class="toolbar">
      <div class="toolbar-row">
        <select id="deckSelect" class="deck-select" title="选择课件"></select>
        <button id="zoomBtn" class="icon-btn" type="button">放大</button>
        <button id="outlineBtn" class="icon-btn" type="button">目录</button>
        <button id="fullscreenBtn" class="icon-btn hidden" type="button">全屏</button>
        <button id="themeToggleBtn" class="icon-btn hidden" type="button" title="切换深浅色主题">🌙</button>
      </div>
      <div class="toolbar-row">
        <div id="filterGroup" class="seg-group" title="按重点分级筛选翻页">
          <button class="seg-btn active" data-filter="all" type="button">全部</button>
          <button class="seg-btn" data-filter="high" type="button">只看🟢重点</button>
          <button class="seg-btn" data-filter="nonlow" type="button">隐藏🔴跳过</button>
        </div>
        <div id="modeGroup" class="seg-group" title="左键交互方式">
          <button class="seg-btn active" data-mode="box" type="button">框选/长按</button>
          <button class="seg-btn" data-mode="text" type="button">纯划词</button>
        </div>
      </div>
    </div>

    <div id="ribbon" class="ribbon prio-high">
      <button id="prioBtn" class="prio-pill high" type="button" title="点击切换本页重要程度"></button>
      <span id="tagBadge" class="tag-badge"></span>
      <span id="tipText" class="tip-text"></span>
    </div>

    <div class="main-area">
      <div id="stageScroll" class="stage-scroll">
        <div id="slideFrame" class="slide-frame mode-box">
          <img id="slideImg" class="slide-img" alt="PPT Slide" draggable="false" />
          <div id="overlayLayer" class="overlay-layer"></div>
          <div id="textLayer" class="text-layer"></div>
        </div>
        <div id="stageHint" class="stage-hint">
          左键拖拽框选（文字/图表通吃） · 原地长按左键 ≥0.35s 自动选中整行 · 键盘 ←/→ 翻页
        </div>
      </div>
      <div id="outlineDrawer" class="outline-drawer hidden"></div>
    </div>

    <div class="footer-nav">
      <button id="prevBtn" class="icon-btn" type="button">← 上一页</button>
      <div class="page-jump">
        <input id="pageInput" class="page-input" type="number" min="1" value="1" />
        <span id="pageTotal">/ 1</span>
        <span id="filterStat" style="opacity:0.7;margin-left:4px;"></span>
      </div>
      <button id="nextBtn" class="icon-btn" type="button">下一页 →</button>
    </div>

    <div id="askPopover" class="ask-popover hidden">
      <div class="ask-head">
        <span id="askTitle" class="ask-title">选中内容提问</span>
        <button id="askCloseBtn" class="ask-close" type="button" title="关闭">✕</button>
      </div>
      <div id="askPreview" class="ask-preview"></div>
      <label class="ask-check">
        <input id="askCropCheck" type="checkbox" checked />
        <span>附带选区高清截图（架构图/公式/代码块更准确）</span>
      </label>
      <div id="chipRow" class="chip-row"></div>
      <div class="ask-input-row">
        <input id="askInput" class="ask-input" type="text" placeholder="输入你想问的内容，回车发送..." />
        <button id="askSendBtn" class="btn-primary" type="button">提问</button>
      </div>
      <div class="ask-actions-sub">
        <button id="askAttachBtn" class="btn-secondary" type="button">挂到聊天输入框</button>
        <span id="askFooterNote" style="font-size:10.5px;opacity:0.65;">直接发送到对话</span>
      </div>
    </div>

    <div id="toast" class="toast"></div>
  `;

  deckSelectEl = document.getElementById("deckSelect") as HTMLSelectElement;
  filterGroupEl = document.getElementById("filterGroup")!;
  modeGroupEl = document.getElementById("modeGroup")!;
  zoomBtnEl = document.getElementById("zoomBtn") as HTMLButtonElement;
  outlineBtnEl = document.getElementById("outlineBtn") as HTMLButtonElement;
  fullscreenBtnEl = document.getElementById("fullscreenBtn") as HTMLButtonElement;
  themeToggleBtnEl = document.getElementById("themeToggleBtn") as HTMLButtonElement;
  ribbonEl = document.getElementById("ribbon")!;
  prioBtnEl = document.getElementById("prioBtn") as HTMLButtonElement;
  tagBadgeEl = document.getElementById("tagBadge")!;
  tipTextEl = document.getElementById("tipText")!;
  stageScrollEl = document.getElementById("stageScroll")!;
  slideFrameEl = document.getElementById("slideFrame")!;
  slideImgEl = document.getElementById("slideImg") as HTMLImageElement;
  overlayLayerEl = document.getElementById("overlayLayer")!;
  textLayerEl = document.getElementById("textLayer")!;
  stageHintEl = document.getElementById("stageHint")!;
  outlineDrawerEl = document.getElementById("outlineDrawer")!;
  prevBtnEl = document.getElementById("prevBtn") as HTMLButtonElement;
  nextBtnEl = document.getElementById("nextBtn") as HTMLButtonElement;
  pageInputEl = document.getElementById("pageInput") as HTMLInputElement;
  pageTotalEl = document.getElementById("pageTotal")!;
  filterStatEl = document.getElementById("filterStat")!;
  askPopoverEl = document.getElementById("askPopover")!;
  askTitleEl = document.getElementById("askTitle")!;
  askPreviewEl = document.getElementById("askPreview")!;
  askCropCheckEl = document.getElementById("askCropCheck") as HTMLInputElement;
  askInputEl = document.getElementById("askInput") as HTMLInputElement;
  askSendBtnEl = document.getElementById("askSendBtn") as HTMLButtonElement;
  askAttachBtnEl = document.getElementById("askAttachBtn") as HTMLButtonElement;
  askFooterNoteEl = document.getElementById("askFooterNote")!;
  toastEl = document.getElementById("toast")!;

  if (isWebBridge) {
    themeToggleBtnEl.classList.remove("hidden");
    askAttachBtnEl.textContent = "仅复制提问文本";
    askFooterNoteEl.textContent = "保存待答队列并自动复制";
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    webTheme = prefersDark ? "dark" : "light";
    applyDocumentTheme(webTheme);
    themeToggleBtnEl.textContent = webTheme === "dark" ? "☀️" : "🌙";
  }

  const chipRow = document.getElementById("chipRow")!;
  for (const item of QUICK_PROMPTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn";
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      submitQuestion(item.prompt);
    });
    chipRow.appendChild(btn);
  }

  wireEvents();
}

function showUnconfiguredGuide(courseDir: string) {
  ribbonEl.style.display = "none";
  slideFrameEl.style.display = "none";
  stageHintEl.style.display = "none";
  prevBtnEl.disabled = true;
  nextBtnEl.disabled = true;
  deckSelectEl.innerHTML = `<option>尚未配置课程目录</option>`;

  const existing = stageScrollEl.querySelector(".empty-card");
  if (existing) existing.remove();

  const card = document.createElement("div");
  card.className = "empty-card";
  card.innerHTML = `
    <h3>📖 欢迎使用「PPT 伴读」</h3>
    <p>${
      courseDir
        ? `在目录 <code>${escapeHtml(courseDir)}</code> 下未找到 PDF 课件。`
        : "尚未设置课程 PPT 文件夹。"
    }</p>
    <ol>
      <li>在对话中发送：<br/><code>帮我制定 &lt;你的PPT文件夹路径&gt; 的复习计划，并打开 PPT 伴读</code></li>
      <li>或在启动配置中填入 <code>PPT_COURSE_DIR</code>（无需预先标注也能直接看任意 PDF）。</li>
    </ol>
  `;

  if (!isWebBridge && app?.getHostCapabilities()?.message) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-primary";
    btn.textContent = "在对话中引导我配置课程目录";
    btn.addEventListener("click", () => {
      app.sendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: "我想开始用 PPT 伴读学习一门课程，请询问我的课件文件夹路径和复习天数，然后帮我生成重点标注并打开伴读界面。",
          },
        ],
      });
    });
    card.appendChild(btn);
  }

  stageScrollEl.appendChild(card);
}

function hideUnconfiguredGuide() {
  const existing = stageScrollEl.querySelector(".empty-card");
  if (existing) existing.remove();
  ribbonEl.style.display = "";
  slideFrameEl.style.display = "";
  stageHintEl.style.display = "";
}

function getDeck(file: string): DeckInfo | undefined {
  return decks.find((d) => d.file === file);
}

function getVisiblePages(deck: DeckInfo): number[] {
  return deck.pages
    .filter((p) => {
      if (filterMode === "high") return p.priority === "high";
      if (filterMode === "nonlow") return p.priority !== "low";
      return true;
    })
    .map((p) => p.page);
}

function populateDeckSelector() {
  deckSelectEl.innerHTML = "";
  const days = Array.from(new Set(decks.map((d) => d.day || 0))).sort((a, b) => a - b);
  const useGroups = days.some((d) => d > 0);

  if (!useGroups) {
    for (const d of decks) {
      const opt = document.createElement("option");
      opt.value = d.file;
      opt.textContent = `${d.title} (★${d.summary.high}/${d.pageCount}页)`;
      deckSelectEl.appendChild(opt);
    }
  } else {
    for (const day of days) {
      const groupDecks = decks.filter((d) => (d.day || 0) === day);
      if (!groupDecks.length) continue;
      const og = document.createElement("optgroup");
      og.label = day > 0 ? `Day ${day}` : "未分组";
      for (const d of groupDecks) {
        const opt = document.createElement("option");
        opt.value = d.file;
        const prefix = day > 0 ? `[D${day}] ` : "";
        opt.textContent = `${prefix}${d.title} (★${d.summary.high}/${d.pageCount}页)`;
        og.appendChild(opt);
      }
      deckSelectEl.appendChild(og);
    }
  }

  if (currentDeckFile) {
    deckSelectEl.value = currentDeckFile;
  }
}

function renderOutline() {
  const deck = getDeck(currentDeckFile);
  if (!deck) return;
  const visible = new Set(getVisiblePages(deck));
  outlineDrawerEl.innerHTML = "";
  for (const p of deck.pages) {
    if (!visible.has(p.page)) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `outline-item${p.page === currentPage ? " active" : ""}`;
    btn.innerHTML = `<span class="dot ${p.priority}"></span><span><b>P${p.page}</b> ${escapeHtml(p.title || p.tag)}</span>`;
    btn.addEventListener("click", () => {
      goToSlide(deck.file, p.page);
    });
    outlineDrawerEl.appendChild(btn);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function updateRibbon(ann: PageAnnotation) {
  ribbonEl.className = `ribbon prio-${ann.priority}`;
  prioBtnEl.className = `prio-pill ${ann.priority}`;
  prioBtnEl.textContent = PRIO_LABEL[ann.priority];
  tagBadgeEl.textContent = `[${ann.tag}]`;
  tipTextEl.textContent = ann.tip;
  tipTextEl.title = ann.tip;
  slideFrameEl.classList.remove("prio-high", "prio-medium", "prio-low");
  slideFrameEl.classList.add(`prio-${ann.priority}`);
}

function updateNavControls() {
  const deck = getDeck(currentDeckFile);
  if (!deck) return;
  const visible = getVisiblePages(deck);
  pageInputEl.value = String(currentPage);
  pageInputEl.max = String(deck.pageCount);
  pageTotalEl.textContent = `/ ${deck.pageCount}`;
  filterStatEl.textContent =
    filterMode === "all" ? "" : `(${visible.length}页符合筛选)`;

  const prevTarget = [...visible].reverse().find((p) => p < currentPage);
  const nextTarget = visible.find((p) => p > currentPage);
  prevBtnEl.disabled = prevTarget === undefined;
  nextBtnEl.disabled = nextTarget === undefined;
}

function clearSelectionVisuals() {
  overlayLayerEl.innerHTML = "";
}

function closeAskPopover() {
  activeSelection = null;
  askPopoverEl.classList.add("hidden");
  clearSelectionVisuals();
  if (selectMode === "text") {
    window.getSelection()?.removeAllRanges();
  }
}

function renderBoxAndHighlights(
  nx1: number,
  ny1: number,
  nx2: number,
  ny2: number,
  wordIndices: number[],
  longPressPulse = false,
) {
  overlayLayerEl.innerHTML = "";
  if (currentSlide) {
    const pw = currentSlide.pageWidth;
    const ph = currentSlide.pageHeight;
    for (const idx of wordIndices) {
      const w = currentSlide.words[idx];
      if (!w) continue;
      const hl = document.createElement("div");
      hl.className = `word-hl${longPressPulse ? " longpress-pulse" : ""}`;
      hl.style.left = `${(w.xMin / pw) * 100}%`;
      hl.style.top = `${(w.yMin / ph) * 100}%`;
      hl.style.width = `${((w.xMax - w.xMin) / pw) * 100}%`;
      hl.style.height = `${((w.yMax - w.yMin) / ph) * 100}%`;
      overlayLayerEl.appendChild(hl);
    }
  }
  const rect = document.createElement("div");
  rect.className = "sel-rect";
  rect.style.left = `${Math.min(nx1, nx2) * 100}%`;
  rect.style.top = `${Math.min(ny1, ny2) * 100}%`;
  rect.style.width = `${Math.abs(nx2 - nx1) * 100}%`;
  rect.style.height = `${Math.abs(ny2 - ny1) * 100}%`;
  overlayLayerEl.appendChild(rect);
}

function renderTextLayer() {
  textLayerEl.innerHTML = "";
  if (!currentSlide || selectMode !== "text") return;
  const frameRect = slideFrameEl.getBoundingClientRect();
  const pw = currentSlide.pageWidth;
  const ph = currentSlide.pageHeight;
  const scaleY = frameRect.height > 0 ? frameRect.height / ph : 1;

  for (let i = 0; i < currentSlide.words.length; i++) {
    const w = currentSlide.words[i];
    const span = document.createElement("span");
    span.className = "text-word";
    span.style.left = `${(w.xMin / pw) * 100}%`;
    span.style.top = `${(w.yMin / ph) * 100}%`;
    span.style.width = `${((w.xMax - w.xMin) / pw) * 100}%`;
    span.style.height = `${((w.yMax - w.yMin) / ph) * 100}%`;
    const fontPx = Math.max(8, (w.yMax - w.yMin) * scaleY * 0.85);
    span.style.fontSize = `${fontPx.toFixed(1)}px`;
    const isAsciiEnd = /[A-Za-z0-9_.,;:)]$/.test(w.text);
    span.textContent = isAsciiEnd ? `${w.text} ` : w.text;
    textLayerEl.appendChild(span);
  }
}

function joinWordsInReadingOrder(words: WordBox[]): string {
  if (!words.length) return "";
  const sorted = [...words].sort((a, b) => a.yMin - b.yMin || a.xMin - b.xMin);
  const heights = sorted.map((w) => w.yMax - w.yMin).sort((a, b) => a - b);
  const medH = heights[Math.floor(heights.length / 2)] || 14;
  const lineTol = Math.max(6, medH * 0.65);

  const lines: WordBox[][] = [];
  for (const w of sorted) {
    const cy = (w.yMin + w.yMax) / 2;
    const lastLine = lines[lines.length - 1];
    if (!lastLine) {
      lines.push([w]);
    } else {
      const refCy =
        lastLine.reduce((acc, item) => acc + (item.yMin + item.yMax) / 2, 0) /
        lastLine.length;
      if (Math.abs(cy - refCy) <= lineTol) {
        lastLine.push(w);
      } else {
        lines.push([w]);
      }
    }
  }

  return lines
    .map((line) => {
      line.sort((a, b) => a.xMin - b.xMin);
      let out = "";
      for (let i = 0; i < line.length; i++) {
        const cur = line[i].text;
        if (i === 0) {
          out = cur;
          continue;
        }
        const prev = line[i - 1].text;
        const gap = line[i].xMin - line[i - 1].xMax;
        const bothCjk =
          /[\u4e00-\u9fff]$/.test(prev) && /^[\u4e00-\u9fff]/.test(cur);
        if (bothCjk && gap < 8) {
          out += cur;
        } else {
          out += ` ${cur}`;
        }
      }
      return out;
    })
    .join("\n");
}

function findWordsInNormalizedBox(
  nx1: number,
  ny1: number,
  nx2: number,
  ny2: number,
): number[] {
  if (!currentSlide) return [];
  const x1 = Math.min(nx1, nx2) * currentSlide.pageWidth;
  const y1 = Math.min(ny1, ny2) * currentSlide.pageHeight;
  const x2 = Math.max(nx1, nx2) * currentSlide.pageWidth;
  const y2 = Math.max(ny1, ny2) * currentSlide.pageHeight;
  const matched: number[] = [];
  for (let i = 0; i < currentSlide.words.length; i++) {
    const w = currentSlide.words[i];
    if (w.xMax >= x1 && w.xMin <= x2 && w.yMax >= y1 && w.yMin <= y2) {
      matched.push(i);
    }
  }
  return matched;
}

function findLongPressLineParagraph(nx: number, ny: number): {
  indices: number[];
  nx1: number;
  ny1: number;
  nx2: number;
  ny2: number;
} | null {
  if (!currentSlide || !currentSlide.words.length) return null;
  const pw = currentSlide.pageWidth;
  const ph = currentSlide.pageHeight;
  const px = nx * pw;
  const py = ny * ph;

  let hitIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < currentSlide.words.length; i++) {
    const w = currentSlide.words[i];
    const dx = Math.max(0, w.xMin - px, px - w.xMax);
    const dy = Math.max(0, w.yMin - py, py - w.yMax);
    const dist = Math.hypot(dx, dy);
    if (dist <= 8) {
      hitIdx = i;
      break;
    }
    if (dist < 30 && dist < bestDist) {
      bestDist = dist;
      hitIdx = i;
    }
  }
  if (hitIdx === -1) return null;

  const hit = currentSlide.words[hitIdx];
  const hitCy = (hit.yMin + hit.yMax) / 2;
  const baseH = Math.max(10, Math.min(32, hit.yMax - hit.yMin));

  const sameLine = currentSlide.words
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => Math.abs((w.yMin + w.yMax) / 2 - hitCy) <= baseH * 0.65)
    .sort((a, b) => a.w.xMin - b.w.xMin);

  const seedPos = sameLine.findIndex((item) => item.i === hitIdx);
  let leftBound = seedPos;
  while (
    leftBound > 0 &&
    sameLine[leftBound].w.xMin - sameLine[leftBound - 1].w.xMax < 85
  ) {
    leftBound--;
  }
  let rightBound = seedPos;
  while (
    rightBound < sameLine.length - 1 &&
    sameLine[rightBound + 1].w.xMin - sameLine[rightBound].w.xMax < 85
  ) {
    rightBound++;
  }
  const lineItems = sameLine.slice(leftBound, rightBound + 1);
  let minX = Math.min(...lineItems.map((x) => x.w.xMin));
  let maxX = Math.max(...lineItems.map((x) => x.w.xMax));
  let minY = Math.min(...lineItems.map((x) => x.w.yMin));
  let maxY = Math.max(...lineItems.map((x) => x.w.yMax));
  const selectedSet = new Set(lineItems.map((x) => x.i));

  let changed = true;
  let steps = 0;
  while (changed && steps < 4) {
    changed = false;
    steps++;
    for (let i = 0; i < currentSlide.words.length; i++) {
      if (selectedSet.has(i)) continue;
      const w = currentSlide.words[i];
      const h = Math.max(10, w.yMax - w.yMin);
      const horizOverlap = w.xMax >= minX - 45 && w.xMin <= maxX + 45;
      const closeAbove = w.yMax <= minY + 4 && minY - w.yMax <= baseH * 0.85;
      const closeBelow = w.yMin >= maxY - 4 && w.yMin - maxY <= baseH * 0.85;
      if (horizOverlap && Math.abs(h - baseH) < baseH * 0.7 && (closeAbove || closeBelow)) {
        selectedSet.add(i);
        minX = Math.min(minX, w.xMin);
        maxX = Math.max(maxX, w.xMax);
        minY = Math.min(minY, w.yMin);
        maxY = Math.max(maxY, w.yMax);
        changed = true;
      }
    }
  }

  const indices = Array.from(selectedSet);
  return {
    indices,
    nx1: Math.max(0, (minX - 4) / pw),
    ny1: Math.max(0, (minY - 3) / ph),
    nx2: Math.min(1, (maxX + 4) / pw),
    ny2: Math.min(1, (maxY + 3) / ph),
  };
}

function openAskPopover(payload: SelectionPayload) {
  activeSelection = payload;
  askTitleEl.textContent = `${payload.modeLabel} · 第 ${currentPage} 页`;
  askPreviewEl.textContent = payload.text
    ? payload.text
    : "🖼 已框选图像/公式区域（无内嵌文字），将附带选区高清截图向 AI 提问";
  askCropCheckEl.checked = payload.defaultCrop;
  askInputEl.value = "";
  askPopoverEl.classList.remove("hidden");

  const popRect = askPopoverEl.getBoundingClientRect();
  const margin = 8;
  let left = payload.anchorClientX - popRect.width / 2;
  let top = payload.anchorClientY + 12;
  if (top + popRect.height > window.innerHeight - margin) {
    top = Math.max(margin, payload.anchorClientY - popRect.height - 14);
  }
  left = Math.max(margin, Math.min(window.innerWidth - popRect.width - margin, left));
  top = Math.max(margin, Math.min(window.innerHeight - popRect.height - margin, top));

  askPopoverEl.style.left = `${left}px`;
  askPopoverEl.style.top = `${top}px`;
  askInputEl.focus();
}

async function buildFormattedPrompt(questionText: string): Promise<{
  fullText: string;
  cropId?: string;
  cropPath?: string;
}> {
  if (!activeSelection || !currentSlide) {
    throw new Error("No active selection");
  }
  let cropId: string | undefined;
  let cropPath: string | undefined;
  if (askCropCheckEl.checked) {
    const cropRes = await callServerTool("app_crop_selection", {
      deck: currentSlide.deck,
      page: currentSlide.page,
      nx1: activeSelection.nx1,
      ny1: activeSelection.ny1,
      nx2: activeSelection.nx2,
      ny2: activeSelection.ny2,
      selectedText: activeSelection.text,
    });
    const sc = cropRes.structuredContent as
      | { cropId?: string; cropPath?: string }
      | undefined;
    if (sc?.cropId) cropId = sc.cropId;
    if (sc?.cropPath) cropPath = sc.cropPath;
  }

  const dayStr = currentSlide.day > 0 ? ` — Day ${currentSlide.day}` : "";
  const lines = [
    "【PPT伴读提问】",
    `- 课件：${currentSlide.deckTitle} (${currentSlide.deck})${dayStr}`,
    `- 页码：第 ${currentSlide.page}/${currentSlide.pageCount} 页（${PRIO_LABEL[currentSlide.annotation.priority]} · ${currentSlide.annotation.tag}）`,
    `- 本页提示：${currentSlide.annotation.tip}`,
  ];
  if (activeSelection.text) {
    const quoted = activeSelection.text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    lines.push("- 选中内容：\n" + quoted);
  } else {
    lines.push("- 选中内容：（纯图像/公式框选区域）");
  }
  if (cropId) {
    lines.push(`- 选区截图ID：${cropId}（可调用 read_ppt_crop 查看局部高清图）`);
  }
  if (cropPath) {
    lines.push(`- 选区截图：${cropPath}`);
  }
  if (questionText.trim()) {
    lines.push(`- 我的问题：${questionText.trim()}`);
  }
  return { fullText: lines.join("\n"), cropId, cropPath };
}

async function submitQuestion(questionText: string) {
  if (isSending || !activeSelection || !currentSlide) return;
  const q = questionText.trim() || "请帮我用大白话讲解一下我选中的这一块。";
  isSending = true;
  askSendBtnEl.disabled = true;
  askSendBtnEl.textContent = "发送中…";

  try {
    const { fullText, cropId, cropPath } = await buildFormattedPrompt(q);

    if (isWebBridge) {
      await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: fullText,
          deck: currentSlide.deck,
          page: currentSlide.page,
          cropId: cropId || "",
          cropPath: cropPath || "",
          question: q,
        }),
      });
      await copyTextSafe(fullText);
      closeAskPopover();
      showToast("已保存并复制！去 Codex 粘贴，或直接说「回答刚选的PPT」");
      return;
    }

    const caps = app!.getHostCapabilities();
    if (caps?.message) {
      const res = await app!.sendMessage({
        role: "user",
        content: [{ type: "text", text: fullText }],
      });
      if (res?.isError) {
        showToast("宿主拒绝了消息发送，请改用“挂到输入框”");
        return;
      }
      closeAskPopover();
      showToast("已发送到对话！");
    } else {
      await copyTextSafe(fullText);
      closeAskPopover();
      showToast("当前视图不支持直接发消息，内容已复制到剪贴板");
    }
  } catch (err) {
    console.error("Send error:", err);
    showToast("发送失败，请重试");
  } finally {
    isSending = false;
    askSendBtnEl.disabled = false;
    askSendBtnEl.textContent = "提问";
  }
}

async function attachToContext() {
  if (isSending || !activeSelection) return;
  isSending = true;
  askAttachBtnEl.disabled = true;

  try {
    const { fullText } = await buildFormattedPrompt(askInputEl.value);
    if (isWebBridge) {
      await copyTextSafe(fullText);
      closeAskPopover();
      showToast("已复制提问文本到剪贴板，去 Codex/Claude 粘贴即可");
      return;
    }
    const caps = app!.getHostCapabilities();
    if (caps?.updateModelContext) {
      await app!.updateModelContext({
        content: [{ type: "text", text: fullText }],
      });
      closeAskPopover();
      showToast("已挂到输入框上下文，直接输入问题回车即可！");
    } else {
      await copyTextSafe(fullText);
      closeAskPopover();
      showToast("已复制到剪贴板");
    }
  } catch (err) {
    console.error("Attach error:", err);
    showToast("操作失败");
  } finally {
    isSending = false;
    askAttachBtnEl.disabled = false;
  }
}

async function goToSlide(deckFile: string, pageNum: number) {
  const deck = getDeck(deckFile);
  if (!deck) return;
  hideUnconfiguredGuide();
  const clamped = Math.max(1, Math.min(deck.pageCount, pageNum));
  currentDeckFile = deck.file;
  currentPage = clamped;
  deckSelectEl.value = deck.file;
  closeAskPopover();

  const pageAnn = deck.pages[clamped - 1];
  updateRibbon(pageAnn);
  updateNavControls();
  renderOutline();

  const cacheKey = `${deck.file}::${clamped}`;
  let data = slideCache.get(cacheKey);
  if (!data) {
    slideImgEl.style.opacity = "0.55";
    const res = await callServerTool("app_get_slide", {
      deck: deck.file,
      page: clamped,
    });
    const sc = res.structuredContent as SlideData | undefined;
    if (!sc || !sc.imageDataUrl) {
      slideImgEl.style.opacity = "1";
      showToast("页面渲染失败");
      return;
    }
    data = sc;
    if (slideCache.size > 30) {
      const oldestKey = slideCache.keys().next().value;
      if (oldestKey) slideCache.delete(oldestKey);
    }
    slideCache.set(cacheKey, data);
  }

  if (currentDeckFile !== deck.file || currentPage !== clamped) return;

  currentSlide = data;
  slideImgEl.src = data.imageDataUrl;
  slideImgEl.style.opacity = "1";
  updateRibbon(data.annotation);
  stageScrollEl.scrollTop = 0;

  if (selectMode === "text") {
    requestAnimationFrame(() => renderTextLayer());
  } else {
    textLayerEl.innerHTML = "";
  }
}

function wireEvents() {
  deckSelectEl.addEventListener("change", () => {
    const deck = getDeck(deckSelectEl.value);
    if (!deck) return;
    const vis = getVisiblePages(deck);
    goToSlide(deck.file, vis[0] ?? 1);
  });

  filterGroupEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
    if (!btn) return;
    const nextFilter = btn.dataset.filter as FilterMode;
    filterMode = nextFilter;
    filterGroupEl.querySelectorAll(".seg-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    const deck = getDeck(currentDeckFile);
    if (!deck) return;
    const vis = getVisiblePages(deck);
    if (vis.length && !vis.includes(currentPage)) {
      const nearest = vis.find((p) => p >= currentPage) ?? vis[vis.length - 1];
      goToSlide(deck.file, nearest);
    } else {
      updateNavControls();
      renderOutline();
    }
  });

  modeGroupEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-mode]");
    if (!btn) return;
    selectMode = btn.dataset.mode as SelectMode;
    modeGroupEl.querySelectorAll(".seg-btn").forEach((el) => {
      el.classList.toggle("active", el === btn);
    });
    slideFrameEl.classList.toggle("mode-box", selectMode === "box");
    slideFrameEl.classList.toggle("mode-text", selectMode === "text");
    closeAskPopover();
    if (selectMode === "text") {
      renderTextLayer();
      showToast("已切换到纯划词模式：直接拖拽选中文字");
    } else {
      textLayerEl.innerHTML = "";
      showToast("已切换到框选/长按模式：拖拽框选或原地长按整行");
    }
  });

  zoomBtnEl.addEventListener("click", () => {
    zoomed = !zoomed;
    slideFrameEl.classList.toggle("zoomed", zoomed);
    zoomBtnEl.textContent = zoomed ? "自适应" : "放大";
    if (selectMode === "text") {
      requestAnimationFrame(() => renderTextLayer());
    }
  });

  outlineBtnEl.addEventListener("click", () => {
    outlineOpen = !outlineOpen;
    outlineDrawerEl.classList.toggle("hidden", !outlineOpen);
    outlineBtnEl.textContent = outlineOpen ? "收起目录" : "目录";
    if (outlineOpen) renderOutline();
  });

  fullscreenBtnEl.addEventListener("click", async () => {
    if (!app) return;
    const targetMode = currentDisplayMode === "fullscreen" ? "inline" : "fullscreen";
    try {
      const res = await app.requestDisplayMode({ mode: targetMode });
      currentDisplayMode = res.mode;
      fullscreenBtnEl.textContent =
        currentDisplayMode === "fullscreen" ? "退出全屏" : "全屏";
      applyContext(app.getHostContext());
    } catch {
      showToast("当前宿主不支持切换显示模式");
    }
  });

  themeToggleBtnEl.addEventListener("click", () => {
    webTheme = webTheme === "dark" ? "light" : "dark";
    applyDocumentTheme(webTheme);
    themeToggleBtnEl.textContent = webTheme === "dark" ? "☀️" : "🌙";
  });

  prioBtnEl.addEventListener("click", async () => {
    const deck = getDeck(currentDeckFile);
    if (!deck) return;
    const cur = deck.pages[currentPage - 1];
    const nextOrder: Record<Priority, Priority> = {
      high: "medium",
      medium: "low",
      low: "high",
    };
    const nextPrio = nextOrder[cur.priority];
    try {
      const res = await callServerTool("app_set_slide_priority", {
        deck: deck.file,
        page: currentPage,
        priority: nextPrio,
      });
      const sc = res.structuredContent as
        | { annotation: PageAnnotation; summary: Record<Priority, number> }
        | undefined;
      if (sc) {
        deck.pages[currentPage - 1] = sc.annotation;
        deck.summary = sc.summary;
        if (currentSlide) currentSlide.annotation = sc.annotation;
        slideCache.delete(`${deck.file}::${currentPage}`);
        updateRibbon(sc.annotation);
        populateDeckSelector();
        renderOutline();
        showToast(`已切换本页为 ${PRIO_LABEL[nextPrio]}`);
      }
    } catch (err) {
      console.error("Failed to update priority:", err);
      showToast("修改标记失败");
    }
  });

  prevBtnEl.addEventListener("click", () => {
    const deck = getDeck(currentDeckFile);
    if (!deck) return;
    const vis = getVisiblePages(deck);
    const target = [...vis].reverse().find((p) => p < currentPage);
    if (target !== undefined) goToSlide(deck.file, target);
  });

  nextBtnEl.addEventListener("click", () => {
    const deck = getDeck(currentDeckFile);
    if (!deck) return;
    const vis = getVisiblePages(deck);
    const target = vis.find((p) => p > currentPage);
    if (target !== undefined) goToSlide(deck.file, target);
  });

  pageInputEl.addEventListener("change", () => {
    const val = parseInt(pageInputEl.value, 10);
    if (!Number.isNaN(val) && currentDeckFile) {
      goToSlide(currentDeckFile, val);
    }
  });

  window.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      if (e.key === "Escape") closeAskPopover();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      prevBtnEl.click();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nextBtnEl.click();
    } else if (e.key === "Escape") {
      closeAskPopover();
    }
  });

  window.addEventListener("resize", () => {
    if (selectMode === "text") renderTextLayer();
  });

  slideFrameEl.addEventListener("pointerdown", (e) => {
    if (selectMode !== "box" || e.button !== 0 || !currentSlide) return;
    closeAskPopover();

    const rect = slideFrameEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    slideFrameEl.setPointerCapture(e.pointerId);

    const state = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startNx: nx,
      startNy: ny,
      curNx: nx,
      curNy: ny,
      isDragging: false,
      longPressFired: false,
      timer: null as number | null,
      matchedIndices: [] as number[],
    };

    state.timer = window.setTimeout(() => {
      if (!dragState || dragState.pointerId !== e.pointerId || dragState.isDragging) {
        return;
      }
      dragState.longPressFired = true;
      const lp = findLongPressLineParagraph(state.startNx, state.startNy);
      if (lp && lp.indices.length) {
        state.startNx = lp.nx1;
        state.startNy = lp.ny1;
        state.curNx = lp.nx2;
        state.curNy = lp.ny2;
        state.matchedIndices = lp.indices;
        renderBoxAndHighlights(lp.nx1, lp.ny1, lp.nx2, lp.ny2, lp.indices, true);
      } else {
        state.startNx = Math.max(0, state.startNx - 0.12);
        state.startNy = Math.max(0, state.startNy - 0.12);
        state.curNx = Math.min(1, nx + 0.12);
        state.curNy = Math.min(1, ny + 0.12);
        state.matchedIndices = [];
        renderBoxAndHighlights(
          state.startNx,
          state.startNy,
          state.curNx,
          state.curNy,
          [],
          true,
        );
      }
    }, 350);

    dragState = state;
  });

  slideFrameEl.addEventListener("pointermove", (e) => {
    if (!dragState || e.pointerId !== dragState.pointerId || selectMode !== "box") return;
    if (dragState.longPressFired) return;

    const dist = Math.hypot(
      e.clientX - dragState.startClientX,
      e.clientY - dragState.startClientY,
    );
    if (!dragState.isDragging && dist > 6) {
      if (dragState.timer !== null) {
        window.clearTimeout(dragState.timer);
        dragState.timer = null;
      }
      dragState.isDragging = true;
    }

    if (dragState.isDragging) {
      const rect = slideFrameEl.getBoundingClientRect();
      dragState.curNx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      dragState.curNy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      dragState.matchedIndices = findWordsInNormalizedBox(
        dragState.startNx,
        dragState.startNy,
        dragState.curNx,
        dragState.curNy,
      );
      renderBoxAndHighlights(
        dragState.startNx,
        dragState.startNy,
        dragState.curNx,
        dragState.curNy,
        dragState.matchedIndices,
        false,
      );
    }
  });

  const finishBoxPointer = (e: PointerEvent) => {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const st = dragState;
    dragState = null;
    if (st.timer !== null) window.clearTimeout(st.timer);
    try {
      slideFrameEl.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    if (!st.isDragging && !st.longPressFired) {
      clearSelectionVisuals();
      return;
    }

    const rect = slideFrameEl.getBoundingClientRect();
    const boxW = Math.abs(st.curNx - st.startNx) * rect.width;
    const boxH = Math.abs(st.curNy - st.startNy) * rect.height;
    if (boxW < 10 && boxH < 10) {
      clearSelectionVisuals();
      return;
    }

    const matchedWords = st.matchedIndices
      .map((i) => currentSlide?.words[i])
      .filter((w): w is WordBox => Boolean(w));
    const extracted = joinWordsInReadingOrder(matchedWords);

    const nx1 = Math.min(st.startNx, st.curNx);
    const ny1 = Math.min(st.startNy, st.curNy);
    const nx2 = Math.max(st.startNx, st.curNx);
    const ny2 = Math.max(st.startNy, st.curNy);

    const anchorX = rect.left + ((nx1 + nx2) / 2) * rect.width;
    const anchorY = rect.top + ny2 * rect.height;

    openAskPopover({
      nx1,
      ny1,
      nx2,
      ny2,
      text: extracted,
      modeLabel: st.longPressFired ? "长按选中整行" : "框选区域",
      defaultCrop: true,
      anchorClientX: anchorX,
      anchorClientY: anchorY,
    });
  };

  slideFrameEl.addEventListener("pointerup", finishBoxPointer);
  slideFrameEl.addEventListener("pointercancel", finishBoxPointer);

  textLayerEl.addEventListener("mouseup", (e) => {
    if (selectMode !== "text" || e.button !== 0 || !currentSlide) return;
    window.setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || !sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      const selRect = range.getBoundingClientRect();
      const frameRect = slideFrameEl.getBoundingClientRect();
      if (frameRect.width <= 0 || frameRect.height <= 0) return;

      const nx1 = Math.max(0, Math.min(1, (selRect.left - frameRect.left) / frameRect.width));
      const ny1 = Math.max(0, Math.min(1, (selRect.top - frameRect.top) / frameRect.height));
      const nx2 = Math.max(0, Math.min(1, (selRect.right - frameRect.left) / frameRect.width));
      const ny2 = Math.max(0, Math.min(1, (selRect.bottom - frameRect.top) / frameRect.height));

      openAskPopover({
        nx1,
        ny1,
        nx2,
        ny2,
        text,
        modeLabel: "划词选中",
        defaultCrop: false,
        anchorClientX: selRect.left + selRect.width / 2,
        anchorClientY: selRect.bottom,
      });
    }, 10);
  });

  document.getElementById("askCloseBtn")!.addEventListener("click", closeAskPopover);
  askSendBtnEl.addEventListener("click", () => submitQuestion(askInputEl.value));
  askAttachBtnEl.addEventListener("click", attachToContext);
  askInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitQuestion(askInputEl.value);
    }
  });

  document.addEventListener("pointerdown", (e) => {
    if (askPopoverEl.classList.contains("hidden")) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (!askPopoverEl.contains(target) && !slideFrameEl.contains(target)) {
      closeAskPopover();
    }
  });
}

function applyContext(ctx: ReturnType<App["getHostContext"]>) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);

  if (ctx.displayMode) {
    currentDisplayMode = ctx.displayMode;
  }

  const supportsFullscreen = Boolean(
    ctx.availableDisplayModes?.includes("fullscreen"),
  );
  fullscreenBtnEl.classList.toggle("hidden", !supportsFullscreen);
  fullscreenBtnEl.textContent =
    currentDisplayMode === "fullscreen" ? "退出全屏" : "全屏";

  const maxH = ctx.containerDimensions?.maxHeight;
  if (currentDisplayMode === "inline" && typeof maxH === "number" && maxH > 0) {
    document.documentElement.classList.add("is-inline");
    const targetH = Math.min(680, Math.max(460, maxH));
    document.documentElement.style.setProperty("--inline-app-height", `${targetH}px`);
  } else {
    document.documentElement.classList.remove("is-inline");
  }
}

async function refreshDecksAndGo(
  targetDeck?: string,
  targetPage?: number,
  targetFilter?: FilterMode,
) {
  const listRes = await callServerTool("app_list_decks", {});
  const sc = listRes.structuredContent as
    | {
        configured?: boolean;
        courseDir?: string;
        decks?: DeckInfo[];
        savedState?: { deck?: string; page?: number; filter?: FilterMode };
      }
    | undefined;

  if (!sc || !sc.configured || !sc.decks?.length) {
    decks = [];
    showUnconfiguredGuide(sc?.courseDir || "");
    return;
  }

  decks = sc.decks;
  slideCache.clear();

  if (targetFilter) {
    filterMode = targetFilter;
  } else if (sc.savedState?.filter) {
    filterMode = sc.savedState.filter;
  }

  filterGroupEl.querySelectorAll(".seg-btn").forEach((el) => {
    el.classList.toggle(
      "active",
      (el as HTMLElement).dataset.filter === filterMode,
    );
  });

  populateDeckSelector();

  const resolvedDeck = targetDeck || sc.savedState?.deck || decks[0].file;
  const resolvedPage = targetPage ?? sc.savedState?.page ?? 1;
  await goToSlide(resolvedDeck, resolvedPage);
}

async function init() {
  renderShell();

  if (!isWebBridge && app) {
    app.ontoolinput = (params) => {
      const a = params.arguments as
        | { deck?: string; page?: number; filter?: FilterMode }
        | undefined;
      if (a?.deck) pendingInitDeck = a.deck;
      if (typeof a?.page === "number") pendingInitPage = a.page;
      if (a?.filter) pendingInitFilter = a.filter;
    };

    app.ontoolresult = (result) => {
      const sc = result.structuredContent as
        | {
            configured?: boolean;
            initialDeck?: string;
            initialPage?: number;
            initialFilter?: FilterMode;
          }
        | undefined;
      if (!sc) return;
      if (sc.configured === false) {
        showUnconfiguredGuide("");
        return;
      }
      if (sc.initialFilter) filterMode = sc.initialFilter;
      if (decks.length && sc.initialDeck && getDeck(sc.initialDeck)) {
        filterGroupEl.querySelectorAll(".seg-btn").forEach((el) => {
          el.classList.toggle(
            "active",
            (el as HTMLElement).dataset.filter === filterMode,
          );
        });
        const targetPage = sc.initialPage ?? 1;
        if (
          currentDeckFile === sc.initialDeck &&
          currentPage === targetPage &&
          currentSlide
        ) {
          return;
        }
        goToSlide(sc.initialDeck, targetPage);
      } else if (sc.initialDeck) {
        if (decks.length) {
          refreshDecksAndGo(sc.initialDeck, sc.initialPage, sc.initialFilter);
        } else {
          pendingInitDeck = sc.initialDeck ?? pendingInitDeck;
          pendingInitPage = sc.initialPage ?? pendingInitPage;
          pendingInitFilter = sc.initialFilter ?? pendingInitFilter;
        }
      }
    };

    app.onhostcontextchanged = (ctx) => {
      applyContext(ctx);
    };

    await app.connect();
    applyContext(app.getHostContext());
  }

  await refreshDecksAndGo(pendingInitDeck, pendingInitPage, pendingInitFilter);
}

init().catch((err) => {
  console.error("Failed to initialize PPT 伴读:", err);
  rootEl.innerHTML = `<div class="loading-banner">初始化失败：${String(err)}</div>`;
});
