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
const UI_HTML_PATH = path.join(PLUGIN_ROOT, "ui", "dist", "app.html");
const APP_URI = "ui://ppt-reader/app.html";
const MIME_TYPE = "text/html;profile=mcp-app";

const core = createPptCore({
  pluginRoot: PLUGIN_ROOT,
  dataDir: DATA_DIR,
  envCourseDir: process.env.PPT_COURSE_DIR || "",
  envAnnotationsPath: process.env.PPT_ANNOTATIONS_PATH || "",
});

let webBridge = null;

const server = new Server(
  { name: "ppt-study-reader", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const TOOLS = [
  {
    name: "open_ppt_reader",
    title: "打开 PPT 伴读",
    description:
      "在支持 MCP Apps 的客户端（Antigravity 侧边栏 / Claude Desktop 内嵌视图）打开带重点分级标注的 PPT 交互伴读器，支持左键框选（文字与图表通吃）、长按选整行和划词向 AI 提问。",
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
      "为 Codex CLI 等终端客户端启动本地环回 Web 伴读界面（127.0.0.1），在浏览器中支持同样的鼠标左键框选/长按/划词，并可将选区与截图传回对话。",
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
      "根据【PPT伴读提问】里的选区截图ID（cropId），以标准 MCP 图像格式返回局部高清截图，便于 Claude Desktop、Codex 等跨平台客户端看懂架构图、公式和代码截图。",
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
      "在任意 MCP 客户端（包括 Claude Desktop 与 Codex）中直接渲染指定课件页，返回重点标注信息、页面文本摘要与整页高清 PNG 图像。",
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
      "用于 Codex CLI 等终端客户端：读取用户在浏览器伴读视图中最近一次鼠标框选/长按/划词提交的提问与选区截图。",
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
            text: `已打开 PPT 伴读：${res.initialDeckTitle} 第 ${res.initialPage}/${res.initialDeckPageCount} 页（筛选：${res.initialFilter}）。若在支持 MCP Apps UI 的客户端（Antigravity / Claude Desktop）中，可直接在可视化窗口左键框选或长按整行向我提问；若在纯终端客户端（如 Codex CLI），可调用 start_web_reader 在浏览器中打开交互视图。`,
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
      if (!webBridge) {
        const reqPort = Number.isInteger(args.port) ? args.port : 4173;
        webBridge = await startWebBridge(core, { port: reqPort, uiHtmlPath: UI_HTML_PATH });
      }
      const statusHint = list.configured
        ? `当前已加载课程目录：${list.courseDir}（共 ${list.decks.length} 份 PDF，${list.totalPages} 页）。`
        : "提示：当前尚未配置课程目录，请先传 courseDir 参数或告知我你的 PDF 文件夹路径。";
      return {
        content: [
          {
            type: "text",
            text: `PPT 伴读浏览器交互视图已启动：${webBridge.url}\n${statusHint}\n\n在浏览器打开上方链接即可左键拖拽框选（文字/图表通吃）、原地长按整行或纯划词；点击“提问”后，问题与局部高清截图会自动保存并复制到剪贴板，切回 Codex 粘贴或直接说“讲一下我刚在浏览器里选的内容”（我会调用 get_pending_ppt_question 读取图文）即可！`,
          },
        ],
        structuredContent: {
          url: webBridge.url,
          port: webBridge.port,
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
