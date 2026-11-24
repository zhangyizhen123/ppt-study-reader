#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPptCore } from "./core.mjs";
import { startWebBridge } from "./web_bridge.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(__dirname, "..");

function parseArgs() {
  const opts = {
    courseDir: process.env.PPT_COURSE_DIR || "",
    annotations: process.env.PPT_ANNOTATIONS_PATH || "",
    dataDir: process.env.PPT_DATA_DIR || "/tmp/ppt-study-reader-web-data",
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
console.log("在浏览器打开上方链接，框选/长按/划词后即可保存并复制到 Codex / Claude 提问。按 Ctrl+C 退出。");

const shutdown = async () => {
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
