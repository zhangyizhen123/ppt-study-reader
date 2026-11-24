#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPptCore } from "./core.mjs";
import { startWebBridge } from "./web_bridge.mjs";
import { applyToolEnv } from "./tools_env.mjs";

applyToolEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function parseArgs() {
  const opts = {
    courseDir: process.env.PPT_COURSE_DIR || "",
    annotations: process.env.PPT_ANNOTATIONS_PATH || "",
    dataDir: process.env.PPT_DATA_DIR || path.join(os.tmpdir(), "ppt-study-reader-web-data"),
    port: Number(process.env.PPT_WEB_PORT || 4173),
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--course-dir" && argv[i + 1]) opts.courseDir = argv[++i];
    else if (a.startsWith("--course-dir=")) opts.courseDir = a.slice("--course-dir=".length);
    else if (a === "--annotations" && argv[i + 1]) opts.annotations = argv[++i];
    else if (a.startsWith("--annotations=")) opts.annotations = a.slice("--annotations=".length);
    else if (a === "--data-dir" && argv[i + 1]) opts.dataDir = argv[++i];
    else if (a.startsWith("--data-dir=")) opts.dataDir = a.slice("--data-dir=".length);
    else if (a === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) opts.port = Number(a.slice("--port=".length));
  }
  return opts;
}

const opts = parseArgs();
const core = createPptCore({
  pluginRoot: PLUGIN_ROOT,
  dataDir: path.resolve(opts.dataDir),
  envCourseDir: opts.courseDir,
  envAnnotationsPath: opts.annotations,
});

if (opts.courseDir) {
  await core.openReader({
    courseDir: path.resolve(opts.courseDir),
    annotationsPath: opts.annotations ? path.resolve(opts.annotations) : "",
  });
}

const uiHtmlPath = path.join(PLUGIN_ROOT, "ui", "dist", "app.html");
const bridge = await startWebBridge(core, { port: opts.port, uiHtmlPath });
console.log(`PPT 伴读浏览器服务已启动：${bridge.url}`);
console.log("在浏览器打开上方链接，框选/长按/划词后点「提问」即可保存并复制，再到 Claude Code / Codex 里粘贴提问。");
console.log(
  `想让提问自动送达 Claude Code：让助手在后台运行 node "${path.join(PLUGIN_ROOT, "scripts", "wait_question.mjs").replace(/\\/g, "/")}" --url ${bridge.url}`,
);
console.log("按 Ctrl+C 退出。");

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
