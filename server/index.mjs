#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createPptCore } from "./core.mjs";
import { startWebBridge } from "./web_bridge.mjs";
import { applyToolEnv } from "./tools_env.mjs";
import { defaultDataDir } from "./data_dir.mjs";

applyToolEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const WAIT_SCRIPT_PATH = path.join(PLUGIN_ROOT, "scripts", "wait_question.mjs");

function dirHasPdf(dir) {
  try {
    return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith(".pdf") && !f.startsWith("."));
  } catch {
    return false;
  }
}

// 课程目录：优先 PPT_COURSE_DIR；否则若启动目录（Claude Code 的项目目录）里有 PDF，就用它（插件零配置）。
const ENV_COURSE_DIR =
  (process.env.PPT_COURSE_DIR || "").trim() || (dirHasPdf(process.cwd()) ? process.cwd() : "");

function parseArgs() {
  let dataDir = "";
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--data-dir=")) {
      dataDir = arg.slice("--data-dir=".length);
    }
  }
  if (!dataDir) {
    // 未显式指定时按课程分目录，避免多门课共用一份 state.json 互相覆盖
    dataDir = defaultDataDir(ENV_COURSE_DIR);
  }
  return { dataDir };
}

const { dataDir: DATA_DIR } = parseArgs();
const UI_HTML_PATH = path.join(PLUGIN_ROOT, "ui", "dist", "app.html");
const APP_URI = "ui://ppt-reader/app.html";
const MIME_TYPE = "text/html;profile=mcp-app";

const core = createPptCore({
  pluginRoot: PLUGIN_ROOT,
  dataDir: DATA_DIR,
  envCourseDir: ENV_COURSE_DIR,
  envAnnotationsPath: process.env.PPT_ANNOTATIONS_PATH || "",
});

let webBridge = null;

// Claude Code channels（研究预览）：声明 experimental["claude/channel"] 后，
// 用户以 `claude --dangerously-load-development-channels server:<本服务在 .mcp.json 里的名字>` 启动时，
// 浏览器里点「提问」会直接推送进会话（<channel source="..."> 标签），无需后台监听脚本。
// 其他客户端会忽略这个实验能力，推送失败也不影响「后台监听 / 剪贴板」兜底路径。
const CHANNEL_INSTRUCTIONS = [
  "ppt-study-reader：若本会话以 channel 方式加载了本服务，用户在浏览器 PPT 伴读里点「提问」时，会以 <channel source=\"...\"> 事件推送进会话，内容即【PPT伴读提问】。没有收到过这种推送时，按 start_web_reader 返回的说明挂后台监听。",
  "收到后：带选区截图ID时先调用 read_ppt_crop 看图，再按项目答疑规则作答；随后调用 get_pending_ppt_question({ markConsumed: true }) 或直接忽略均可（推送内容已完整）。",
  "一旦本会话收到过这种推送，说明推送通道可用：不必再在后台运行 listenCommand 监听；若之前已挂着监听，可停掉它，它对同一问题的重复通知直接忽略。",
].join("\n");

const server = new Server(
  { name: "ppt-study-reader", version: "1.0.0" },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      experimental: { "claude/channel": {} },
    },
    instructions: CHANNEL_INSTRUCTIONS,
  },
);

// 把浏览器提问推送进会话（仅在客户端注册了 channel 时生效；否则客户端静默丢弃）。
async function pushQuestionToChannel(entry) {
  const meta = { deck: entry.deck || "", page: String(entry.page || "") };
  if (entry.cropId) meta.crop_id = entry.cropId;
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: { content: entry.text || entry.question || "(空问题)", meta },
    });
    return true;
  } catch (err) {
    console.error("channel push failed:", err?.message || err);
    return false;
  }
}

async function ensureWebBridge(port = 4173) {
  if (!webBridge) {
    webBridge = await startWebBridge(core, { port, uiHtmlPath: UI_HTML_PATH });
  }
  return webBridge;
}

// 推送不依赖「谁占着 4173 端口」：每个会话（含 side chat）都会各起一个本服务进程，
// 而浏览器只连其中一个。提问统一落盘到 pending_question.json（同一课程共用一个 dataDir），
// 所以每个进程都盯着这个文件，发现新提问就推送给自己所在的会话；
// 没注册 channel 的会话（桌面版等）会静默丢弃，不会打扰。
const PENDING_FILE = path.join(DATA_DIR, "pending_question.json");
let lastPushedSavedAt = (() => {
  // 启动前就存在的旧提问不推送（此时 channel 可能还没注册）；遗漏的旧提问由 SessionStart hook / 监听器补查
  try {
    return JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")).savedAt || "";
  } catch {
    return "";
  }
})();

fs.watchFile(PENDING_FILE, { interval: 700, persistent: false }, () => {
  let entry;
  try {
    entry = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
  } catch {
    return;
  }
  if (!entry || !entry.text || entry.consumed || !entry.savedAt) return;
  if (entry.savedAt === lastPushedSavedAt) return;
  lastPushedSavedAt = entry.savedAt;
  pushQuestionToChannel(entry);
});

const TOOLS = [
  {
    name: "open_ppt_reader",
    title: "打开 PPT 伴读",
    description:
      "在支持 MCP Apps 的客户端（Antigravity 侧边栏 / Claude 桌面版 Chat 内嵌视图）打开带重点分级标注的 PPT 交互伴读器，支持左键框选（文字与图表通吃）、长按选整行和划词向 AI 提问。Claude Code、Codex CLI 等不能渲染内嵌界面的客户端请改用 start_web_reader。",
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
      "ui/resourceUri": APP_URI,
      "com.google.antigravity/ui": {
        entrypoints: [{ type: "aux_pane", title: "PPT 伴读" }],
      },
    },
  },
  {
    name: "start_web_reader",
    title: "启动浏览器伴读视图",
    description:
      "为 Claude Code、Codex CLI 等不能渲染内嵌界面的客户端启动本地环回 Web 伴读界面（127.0.0.1），在浏览器中支持同样的鼠标左键框选/长按/划词提问。返回的 listenCommand 是提问监听器：在后台运行它，用户点「提问」时它会退出并带出问题，实现提问自动送达。",
    inputSchema: {
      type: "object",
      properties: {
        courseDir: {
          type: "string",
          description: "可选，包含课程 PDF 文件的本地文件夹绝对路径",
        },
        annotationsPath: {
          type: "string",
          description: "可选，study_annotations.json 路径",
        },
        deck: {
          type: "string",
          description: "可选，初始打开的课件文件名",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "可选，初始页码",
        },
        port: {
          type: "integer",
          minimum: 1024,
          maximum: 65535,
          description: "可选，本地端口（默认 4173，被占用时自动分配空闲端口）",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_ppt_crop",
    title: "查看 PPT 选区截图",
    description:
      "根据【PPT伴读提问】里的选区截图ID（cropId），以标准 MCP 图像格式返回局部高清截图，便于各客户端看懂架构图、公式和代码截图。",
    inputSchema: {
      type: "object",
      properties: {
        cropId: {
          type: "string",
          description: "【PPT伴读提问】中附带的选区截图ID（如 crop_1700000000_ab12.png）",
        },
      },
      required: ["cropId"],
      additionalProperties: false,
    },
  },
  {
    name: "get_slide_image",
    title: "获取指定 PPT 页面图像",
    description:
      "在任意 MCP 客户端中直接渲染指定课件页，返回重点标注信息、页面文本摘要与整页高清 PNG 图像。",
    inputSchema: {
      type: "object",
      properties: {
        deck: {
          type: "string",
          description: "课件文件名（如 01-导论.pdf）",
        },
        page: {
          type: "integer",
          minimum: 1,
          description: "页码（从 1 开始）",
        },
      },
      required: ["deck", "page"],
      additionalProperties: false,
    },
  },
  {
    name: "get_pending_ppt_question",
    title: "读取浏览器伴读刚提交的提问",
    description:
      "读取用户在浏览器伴读视图（start_web_reader）中最近一次框选/长按/划词提交的提问与选区截图。提问监听器（listenCommand）退出并带出问题后，调用它取回图文再作答。",
    inputSchema: {
      type: "object",
      properties: {
        markConsumed: {
          type: "boolean",
          description: "是否标记为已读取（默认 true）",
        },
      },
      additionalProperties: false,
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

const PROMPTS = [
  {
    name: "exam_prep_plan",
    description: "按可用天数和课程 PDF 文件夹制定大学生期末冲刺/预习计划并生成标注版 PPT",
    arguments: [
      { name: "courseDir", description: "课程 PDF 文件夹路径", required: true },
      { name: "days", description: "可用复习或预习天数（如 3 或 4）", required: false },
      { name: "goal", description: "学习目标（期末冲刺 / 零基础预习）", required: false },
    ],
  },
  {
    name: "explain_ppt_selection",
    description: "开启零基础大白话 PPT 伴读答疑模式（指导模型优先读取选区截图并结合重点分级作答）",
    arguments: [],
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: "PPT 伴读交互界面",
      description: "带重点分级标注与鼠标框选/长按提问的 PPT 阅读器",
      mimeType: MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

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

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (req) => {
  const { name, arguments: pArgs = {} } = req.params;
  if (name === "exam_prep_plan") {
    const courseDir = pArgs.courseDir || "<请提供你的课程 PDF 文件夹路径>";
    const days = pArgs.days || "3~4";
    const goal = pArgs.goal || "期末复习冲刺";
    return {
      description: "课程复习/预习规划与逐页标注工作流",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `请帮我用 ${days} 天时间完成目录 "${courseDir}" 下课程 PDF 的「${goal}」。请按以下步骤执行：\n1. 使用 scripts/extract_index.py 扫描全部 PDF 页数与提纲；\n2. 结合我的目标制定分天计划与 🟢重点精读 / 🟡速览了解 / 🔴可跳过 逐页标注并保存为 study_annotations.json；\n3. 运行 scripts/annotate_all.mjs 无损生成离线《标注版PPT》；\n4. 调用 open_ppt_reader（或在终端下调用 start_web_reader）为我打开交互伴读界面。`,
          },
        },
      ],
    };
  }
  if (name === "explain_ppt_selection") {
    return {
      description: "PPT 伴读大白话答疑规范",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "请进入「PPT 伴读」答疑模式：后续每次收到以【PPT伴读提问】开头的消息时，若带有 选区截图ID，请先调用 MCP 工具 read_ppt_crop 查看局部截图再回答；优先用零基础大白话+直观类比讲清核心直觉与常见考坑，并根据页面红/黄/绿重要程度把握讲解深浅。",
          },
        },
      ],
    };
  }
  throw new Error(`Unknown prompt: ${name}`);
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};

  try {
    if (name === "open_ppt_reader") {
      const res = await core.openReader(args);
      if (!res.configured) {
        return {
          content: [
            {
              type: "text",
              text: "尚未指定课程 PPT 目录。请在对话中告诉我你的课程 PDF 文件夹路径（或通过 open_ppt_reader 的 courseDir 参数传入，或在配置文件中设置 PPT_COURSE_DIR）。",
            },
          ],
          structuredContent: res,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `已打开 PPT 伴读：${res.initialDeckTitle} 第 ${res.initialPage}/${res.initialDeckPageCount} 页（筛选：${res.initialFilter}）。若在支持 MCP Apps UI 的客户端（Antigravity / Claude 桌面版的 Chat 标签页）中，可直接在可视化窗口左键框选或长按整行向我提问；若当前客户端显示不了内嵌界面（如 Claude Code / 桌面版 Code 标签页、Codex CLI），请改用 start_web_reader 在浏览器中打开交互视图。`,
          },
        ],
        structuredContent: res,
      };
    }

    if (name === "start_web_reader") {
      if (args.courseDir || args.annotationsPath || args.deck || args.page) {
        await core.openReader(args);
      }
      const list = await core.listDecks();
      await ensureWebBridge(Number.isInteger(args.port) ? args.port : 4173);
      const statusHint = list.configured
        ? `当前已加载课程目录：${list.courseDir}（共 ${list.decks.length} 份 PDF，${list.totalPages} 页）。`
        : "提示：当前尚未配置课程目录，请先传 courseDir 参数或告知我你的 PDF 文件夹路径。";
      const listenCommand = `node "${WAIT_SCRIPT_PATH.replace(/\\/g, "/")}" --url ${webBridge.url}`;
      return {
        content: [
          {
            type: "text",
            text: [
              `PPT 伴读浏览器交互视图已启动：${webBridge.url}`,
              statusHint,
              "",
              "用户在浏览器里左键拖拽框选（文字/图表通吃）、原地长按整行或纯划词，点「提问」即可。",
              "",
              "【提问自动送达】",
              "- 若本会话已收到过 <channel source=\"...\"> 形式的伴读提问推送（Claude Code 以 channel 方式加载本服务时），提问会直接推送进来，无需下面的监听。",
              `- 否则（Claude Code 等能在后台运行命令的客户端）请立刻用后台方式（如 Bash 的 run_in_background）运行提问监听器：${listenCommand}`,
              "- 监听器启动时若已有未读提问（例如监听断开期间提交的），会立即带出，不会漏接；",
              "- 用户点「提问」后监听器会打印问题并退出，你会被自动唤醒：调用 get_pending_ppt_question 取回问题与选区截图后作答；",
              "- 每答完一题，都用同一条命令重新在后台挂起监听；",
              "- 输出 PPT_WAIT_TIMEOUT 时静默重新挂起，不必告诉用户；输出 PPT_BRIDGE_DOWN 时重新调用 start_web_reader。",
              "",
              "不能后台运行命令的客户端：提问会保存并复制到剪贴板，用户粘贴到对话，或说「讲一下我刚框选的 PPT」（调用 get_pending_ppt_question）。",
            ].join("\n"),
          },
        ],
        structuredContent: {
          url: webBridge.url,
          port: webBridge.port,
          listenCommand,
          configured: list.configured,
          courseDir: list.courseDir,
          deckCount: list.decks.length,
          totalPages: list.totalPages,
        },
      };
    }

    if (name === "read_ppt_crop") {
      const img = core.readCropImage({ cropId: args.cropId });
      return {
        content: [
          { type: "text", text: `选区高清截图（${img.cropId}）：` },
          { type: "image", data: img.base64, mimeType: img.mimeType },
        ],
      };
    }

    if (name === "get_slide_image") {
      const slide = await core.getSlide({ deck: args.deck, page: args.page });
      return {
        content: [
          {
            type: "text",
            text: `课件：${slide.deckTitle} (${slide.deck}) 第 ${slide.page}/${slide.pageCount} 页\n分级：[${slide.annotation.priority}] ${slide.annotation.tag}\n提示：${slide.annotation.tip}\n文本摘录：${slide.textSnippet}`,
          },
          { type: "image", data: slide.base64, mimeType: "image/png" },
        ],
      };
    }

    if (name === "get_pending_ppt_question") {
      const markConsumed = args.markConsumed !== false;
      const pending = core.getPendingQuestion({ markConsumed });
      if (!pending.found) {
        return {
          content: [
            {
              type: "text",
              text: "暂未检测到浏览器伴读提交的待回答问题。请先在浏览器伴读视图中左键框选/长按选中内容并点击“提问”。",
            },
          ],
        };
      }
      const content = [
        {
          type: "text",
          text: `${pending.text}\n（提交时间：${pending.savedAt}${pending.consumed ? "，此前已读取过" : ""}）`,
        },
      ];
      if (pending.cropImage) {
        content.push({
          type: "image",
          data: pending.cropImage.base64,
          mimeType: pending.cropImage.mimeType,
        });
      }
      return { content };
    }

    if (name === "app_list_decks") {
      const sc = await core.listDecks();
      return {
        content: [
          {
            type: "text",
            text: sc.configured
              ? `Loaded ${sc.decks.length} decks (${sc.totalPages} pages).`
              : "Course directory not configured yet.",
          },
        ],
        structuredContent: sc,
      };
    }

    if (name === "app_get_slide") {
      const slide = await core.getSlide(args);
      const { base64, pngPath, textSnippet, ...publicSlide } = slide;
      return {
        content: [{ type: "text", text: `${slide.deck} page ${slide.page}/${slide.pageCount}` }],
        structuredContent: publicSlide,
      };
    }

    if (name === "app_crop_selection") {
      const sc = await core.cropSelection(args);
      return {
        content: [{ type: "text", text: `Saved crop: ${sc.cropId}` }],
        structuredContent: sc,
      };
    }

    if (name === "app_set_slide_priority") {
      const sc = await core.setSlidePriority(args);
      return {
        content: [{ type: "text", text: `Updated ${sc.deck} p${sc.page} -> ${args.priority}` }],
        structuredContent: sc,
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

async function shutdown() {
  if (webBridge) {
    try {
      await webBridge.close();
    } catch {
      // ignore
    }
    webBridge = null;
  }
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
process.stdin.on("end", () => {
  shutdown().catch(() => {});
});
server.onclose = () => {
  shutdown().catch(() => {});
};

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`ppt-study-reader MCP server started (dataDir=${DATA_DIR})`);

// PPT_WEB_AUTOSTART=1：服务一启动就开浏览器伴读桥（channel 推送场景下，不必等模型调用 start_web_reader）。
if (/^(1|true|yes)$/i.test(process.env.PPT_WEB_AUTOSTART || "")) {
  ensureWebBridge(Number(process.env.PPT_WEB_PORT) || 4173)
    .then((b) => console.error(`web reader auto-started at ${b.url}`))
    .catch((err) => console.error("web reader auto-start failed:", err?.message || err));
}
