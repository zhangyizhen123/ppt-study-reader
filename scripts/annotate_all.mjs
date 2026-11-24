#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyToolEnv, pythonCommand } from "../server/tools_env.mjs";

applyToolEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const opts = {
    courseDir: "",
    annotations: "",
    outDir: "",
    fontRegular: "",
    fontBold: "",
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--course-dir" && argv[i + 1]) opts.courseDir = argv[++i];
    else if (a.startsWith("--course-dir=")) opts.courseDir = a.slice("--course-dir=".length);
    else if (a === "--annotations" && argv[i + 1]) opts.annotations = argv[++i];
    else if (a.startsWith("--annotations=")) opts.annotations = a.slice("--annotations=".length);
    else if (a === "--out-dir" && argv[i + 1]) opts.outDir = argv[++i];
    else if (a.startsWith("--out-dir=")) opts.outDir = a.slice("--out-dir=".length);
    else if (a === "--font-regular" && argv[i + 1]) opts.fontRegular = argv[++i];
    else if (a.startsWith("--font-regular=")) opts.fontRegular = a.slice("--font-regular=".length);
    else if (a === "--font-bold" && argv[i + 1]) opts.fontBold = argv[++i];
    else if (a.startsWith("--font-bold=")) opts.fontBold = a.slice("--font-bold=".length);
  }
  if (!opts.courseDir) {
    console.error(
      "Usage: node scripts/annotate_all.mjs --course-dir <dir> [--annotations <json>] [--out-dir <dir>]",
    );
    process.exit(1);
  }
  opts.courseDir = path.resolve(opts.courseDir);
  if (!opts.outDir) {
    opts.outDir = path.join(opts.courseDir, "标注版PPT");
  } else {
    opts.outDir = path.resolve(opts.outDir);
  }
  if (!opts.annotations) {
    const c1 = path.join(opts.outDir, "study_annotations.json");
    const c2 = path.join(opts.courseDir, "study_annotations.json");
    opts.annotations = fs.existsSync(c1) ? c1 : c2;
  } else {
    opts.annotations = path.resolve(opts.annotations);
  }
  return opts;
}

const opts = parseArgs();
if (!fs.existsSync(opts.annotations)) {
  console.error(`Annotations JSON not found: ${opts.annotations}`);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-annot-"));
const cacheDir = path.join(tmpDir, "banners");
const manifestPath = path.join(tmpDir, "manifest.json");

try {
  const pyArgs = [
    path.join(__dirname, "render_banners.py"),
    "--course-dir",
    opts.courseDir,
    "--annotations",
    opts.annotations,
    "--out-dir",
    opts.outDir,
    "--cache-dir",
    cacheDir,
    "--manifest",
    manifestPath,
  ];
  if (opts.fontRegular) pyArgs.push("--font-regular", opts.fontRegular);
  if (opts.fontBold) pyArgs.push("--font-bold", opts.fontBold);

  const [pyCmd, ...pyPre] = pythonCommand();
  execFileSync(pyCmd, [...pyPre, ...pyArgs], { stdio: "inherit" });
  // 插件安装没有 node_modules 时优先使用打包好的 dist/annotate_pdfs.mjs
  const bundled = path.join(__dirname, "..", "dist", "annotate_pdfs.mjs");
  const stamper = fs.existsSync(bundled) ? bundled : path.join(__dirname, "annotate_pdfs.mjs");
  execFileSync(process.execPath, [stamper, "--manifest", manifestPath], { stdio: "inherit" });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
