#!/usr/bin/env node
// 把依赖 npm 包的 Node 入口打成单文件，供 Claude Code 插件安装（不会执行 npm install）直接运行。
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const entries = [
  { in: "server/index.mjs", out: "dist/server.mjs" },
  { in: "scripts/annotate_pdfs.mjs", out: "dist/annotate_pdfs.mjs" },
];

for (const e of entries) {
  await build({
    entryPoints: [path.join(rootDir, e.in)],
    outfile: path.join(rootDir, e.out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node18"],
    legalComments: "none",
    // 少数 CommonJS 依赖会调用 require()，ESM 输出里需要补上
    banner: {
      js: "import { createRequire as __pptCreateRequire } from 'node:module'; const require = __pptCreateRequire(import.meta.url);",
    },
  });
  console.log(`Bundled ${e.in} -> ${e.out}`);
}
