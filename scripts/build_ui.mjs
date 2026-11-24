#!/usr/bin/env node
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const srcTs = path.join(rootDir, "ui/src/app.ts");
const srcCss = path.join(rootDir, "ui/src/styles.css");
const outHtml = path.join(rootDir, "ui/dist/app.html");

const result = await build({
  entryPoints: [srcTs],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
});

const jsCode = result.outputFiles[0].text;
const cssCode = fs.readFileSync(srcCss, "utf8");

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PPT 伴读</title>
  <style>${cssCode}</style>
</head>
<body>
  <div id="app"></div>
  <script>${jsCode}</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(outHtml), { recursive: true });
fs.writeFileSync(outHtml, html, "utf8");
const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
console.log(`Built ${outHtml} (${kb} KB)`);
