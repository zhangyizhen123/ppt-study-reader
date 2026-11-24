#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

async function createDummyPdf(outPath, pagesText) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pagesText) {
    const page = doc.addPage([720, 540]);
    let y = 470;
    for (const line of lines) {
      page.drawText(line, {
        x: 60,
        y,
        size: 20,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
      y -= 36;
    }
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, await doc.save());
}

function startRpcClient(dataDir) {
  const proc = spawn(
    "node",
    [path.join(ROOT_DIR, "server/index.mjs"), `--data-dir=${dataDir}`],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PPT_COURSE_DIR: "", PPT_ANNOTATIONS_PATH: "" },
    },
  );

  let buf = "";
  const pending = new Map();
  let nextId = 1;

  proc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  });

  const rpc = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  };

  const notify = (method, params) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };

  const close = async () => {
    proc.kill("SIGTERM");
    await new Promise((r) => proc.on("exit", r));
  };

  return { rpc, notify, close };
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-reader-smoke-"));
  const courseA = path.join(tmpRoot, "courseA");
  const courseB = path.join(tmpRoot, "courseB");
  const dataDir = path.join(tmpRoot, "data");

  try {
    // 1. Check built UI HTML
    const htmlPath = path.join(ROOT_DIR, "ui/dist/app.html");
    assert.ok(fs.existsSync(htmlPath), "ui/dist/app.html must exist");
    const htmlText = fs.readFileSync(htmlPath, "utf8");
    const htmlBytes = Buffer.byteLength(htmlText, "utf8");
    assert.ok(htmlBytes < 1024 * 1024, `app.html too large: ${htmlBytes}`);
    assert.ok(
      !/<(?:script|link|img)[^>]*(?:src|href)=["']https?:\/\//i.test(htmlText),
      "app.html must not reference external URLs",
    );
    console.log(`UI bundle check OK (${(htmlBytes / 1024).toFixed(1)} KB, 0 external URLs)`);

    // 2. Create synthetic PDFs
    await createDummyPdf(path.join(courseA, "01-Intro.pdf"), [
      ["Chapter 1 Course Introduction", "Key concept summary and exam overview"],
      ["Core Formula and Example", "Theorem A implies Bound B in practice"],
    ]);
    await createDummyPdf(path.join(courseB, "01-RawDeck.pdf"), [
      ["Zero Config Raw Lecture Slide", "Automatically discovered without annotations JSON"],
    ]);

    // 3. Test extract_index.py
    const dumpPath = path.join(tmpRoot, "dump.json");
    execFileSync(
      "python3",
      [path.join(ROOT_DIR, "scripts/extract_index.py"), "--course-dir", courseA, "--out", dumpPath],
      { stdio: "inherit" },
    );
    const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
    assert.equal(dump.totalPages, 2);
    assert.equal(dump.decks[0].file, "01-Intro.pdf");

    // 4. Write sample annotations & test annotate_all.mjs
    const annOutDir = path.join(courseA, "标注版PPT");
    const annPath = path.join(annOutDir, "study_annotations.json");
    fs.mkdirSync(annOutDir, { recursive: true });
    fs.writeFileSync(
      annPath,
      JSON.stringify(
        {
          courseDir: courseA,
          annotatedDir: annOutDir,
          totalPages: 2,
          summary: { high: 1, medium: 1, low: 0 },
          decks: [
            {
              file: "01-Intro.pdf",
              title: "01 课程导论",
              day: 1,
              pageCount: 2,
              summary: { high: 1, medium: 1, low: 0 },
              pages: [
                { page: 1, priority: "medium", tag: "导论", title: "Chapter 1", tip: "速览建立整体概念" },
                { page: 2, priority: "high", tag: "核心公式", title: "Core Formula", tip: "必考核心定理与边界条件" },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    execFileSync(
      "node",
      [
        path.join(ROOT_DIR, "scripts/annotate_all.mjs"),
        "--course-dir",
        courseA,
        "--annotations",
        annPath,
        "--out-dir",
        annOutDir,
      ],
      { stdio: "inherit" },
    );
    const stampedPdf = path.join(annOutDir, "01-Intro.pdf");
    assert.ok(fs.existsSync(stampedPdf), "Stamped PDF missing");
    const pdfInfoOut = execFileSync("pdfinfo", [stampedPdf], { encoding: "utf8" });
    assert.match(pdfInfoOut, /Pages:\s+2\b/);
    console.log("Offline PDF annotation pipeline OK");

    // 5. MCP stdio JSON-RPC end-to-end checks
    const client = startRpcClient(dataDir);
    try {
      const initRes = await client.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
      });
      assert.equal(initRes.serverInfo.name, "ppt-study-reader");
      client.notify("notifications/initialized");

      const toolsRes = await client.rpc("tools/list");
      const tools = Object.fromEntries(toolsRes.tools.map((t) => [t.name, t]));
      assert.equal(tools.open_ppt_reader._meta.ui.resourceUri, "ui://ppt-reader/app.html");
      assert.equal(tools.open_ppt_reader._meta["com.google.antigravity/ui"].entrypoints[0].type, "aux_pane");
      for (const name of ["app_list_decks", "app_get_slide", "app_crop_selection", "app_set_slide_priority"]) {
        assert.deepEqual(tools[name]._meta.ui.visibility, ["app"]);
      }

      const resRead = await client.rpc("resources/read", { uri: "ui://ppt-reader/app.html" });
      assert.equal(resRead.contents[0].mimeType, "text/html;profile=mcp-app");

      // Unconfigured call returns graceful guide instead of crashing
      const unconf = await client.rpc("tools/call", { name: "open_ppt_reader", arguments: {} });
      assert.equal(unconf.structuredContent.configured, false);

      // Configured with annotated courseA
      const openA = await client.rpc("tools/call", {
        name: "open_ppt_reader",
        arguments: { courseDir: courseA },
      });
      assert.equal(openA.structuredContent.configured, true);
      assert.equal(openA.structuredContent.totalPages, 2);

      const listA = await client.rpc("tools/call", { name: "app_list_decks", arguments: {} });
      assert.equal(listA.structuredContent.decks.length, 1);

      const slideA = await client.rpc("tools/call", {
        name: "app_get_slide",
        arguments: { deck: "01-Intro.pdf", page: 2 },
      });
      assert.ok(slideA.structuredContent.imageDataUrl.startsWith("data:image/png;base64,"));
      assert.ok(slideA.structuredContent.words.length >= 5, "Expected extracted word boxes");

      const cropA = await client.rpc("tools/call", {
        name: "app_crop_selection",
        arguments: {
          deck: "01-Intro.pdf",
          page: 2,
          nx1: 0.05,
          ny1: 0.05,
          nx2: 0.9,
          ny2: 0.4,
          selectedText: "Core Formula",
        },
      });
      assert.ok(fs.existsSync(cropA.structuredContent.cropPath));
      assert.ok(cropA.structuredContent.width > 100);

      const prioA = await client.rpc("tools/call", {
        name: "app_set_slide_priority",
        arguments: { deck: "01-Intro.pdf", page: 1, priority: "high", tip: "已手动标为重点" },
      });
      assert.equal(prioA.structuredContent.annotation.priority, "high");

      // Zero-config auto-discovery with raw courseB (no study_annotations.json)
      const openB = await client.rpc("tools/call", {
        name: "open_ppt_reader",
        arguments: { courseDir: courseB },
      });
      assert.equal(openB.structuredContent.configured, true);
      assert.equal(openB.structuredContent.synthesized, true);
      assert.equal(openB.structuredContent.initialDeck, "01-RawDeck.pdf");

      const slideB = await client.rpc("tools/call", {
        name: "app_get_slide",
        arguments: { deck: "01-RawDeck.pdf", page: 1 },
      });
      assert.ok(slideB.structuredContent.words.length >= 4);
      console.log("MCP stdio server end-to-end tests OK (annotated + zero-config auto-discovery)");
    } finally {
      await client.close();
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
