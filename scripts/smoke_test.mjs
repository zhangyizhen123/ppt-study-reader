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

    // 2. Check setup_clients dry-run
    const setupOut = execFileSync(
      "node",
      [path.join(ROOT_DIR, "scripts/setup_clients.mjs"), "--client", "all", "--course-dir", courseA],
      { encoding: "utf8" },
    );
    assert.match(setupOut, /claude_desktop_config\.json/);
    assert.match(setupOut, /codex mcp add ppt_study_reader/);
    console.log("setup_clients.mjs dry-run OK");

    // 3. Create synthetic PDFs
    await createDummyPdf(path.join(courseA, "01-Intro.pdf"), [
      ["Chapter 1 Course Introduction", "Key concept summary and exam overview"],
      ["Core Formula and Example", "Theorem A implies Bound B in practice"],
    ]);
    await createDummyPdf(path.join(courseB, "01-RawDeck.pdf"), [
      ["Zero Config Raw Lecture Slide", "Automatically discovered without annotations JSON"],
    ]);

    // 4. Test extract_index.py + annotate_all.mjs
    const dumpPath = path.join(tmpRoot, "dump.json");
    execFileSync(
      "python3",
      [path.join(ROOT_DIR, "scripts/extract_index.py"), "--course-dir", courseA, "--out", dumpPath],
      { stdio: "inherit" },
    );
    const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
    assert.equal(dump.totalPages, 2);

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

    // 5. MCP stdio JSON-RPC end-to-end checks (Antigravity + Claude Desktop + Codex)
    const client = startRpcClient(dataDir);
    try {
      const initRes = await client.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
      });
      assert.equal(initRes.serverInfo.name, "ppt-study-reader");
      assert.ok(initRes.capabilities.prompts, "Expected prompts capability");
      client.notify("notifications/initialized");

      const toolsRes = await client.rpc("tools/list");
      const tools = Object.fromEntries(toolsRes.tools.map((t) => [t.name, t]));
      assert.equal(tools.open_ppt_reader._meta.ui.resourceUri, "ui://ppt-reader/app.html");
      assert.equal(tools.open_ppt_reader._meta["ui/resourceUri"], "ui://ppt-reader/app.html");
      assert.equal(tools.open_ppt_reader._meta["com.google.antigravity/ui"].entrypoints[0].type, "aux_pane");
      for (const name of ["app_list_decks", "app_get_slide", "app_crop_selection", "app_set_slide_priority"]) {
        assert.deepEqual(tools[name]._meta.ui.visibility, ["app"]);
      }
      for (const name of ["start_web_reader", "read_ppt_crop", "get_slide_image", "get_pending_ppt_question"]) {
        assert.ok(tools[name], `Missing cross-client tool: ${name}`);
      }

      // Prompts check
      const promptsList = await client.rpc("prompts/list");
      assert.ok(promptsList.prompts.some((p) => p.name === "exam_prep_plan"));
      assert.ok(promptsList.prompts.some((p) => p.name === "explain_ppt_selection"));
      const promptGet = await client.rpc("prompts/get", {
        name: "exam_prep_plan",
        arguments: { courseDir: courseA, days: "3", goal: "期末冲刺" },
      });
      assert.ok(promptGet.messages.length >= 1);

      // Resource check
      const resRead = await client.rpc("resources/read", { uri: "ui://ppt-reader/app.html" });
      assert.equal(resRead.contents[0].mimeType, "text/html;profile=mcp-app");

      // Unconfigured graceful guide
      const unconf = await client.rpc("tools/call", { name: "open_ppt_reader", arguments: {} });
      assert.equal(unconf.structuredContent.configured, false);

      // Open courseA
      const openA = await client.rpc("tools/call", {
        name: "open_ppt_reader",
        arguments: { courseDir: courseA },
      });
      assert.equal(openA.structuredContent.configured, true);
      assert.equal(openA.structuredContent.totalPages, 2);

      // get_slide_image returns native MCP ImageContent
      const slideImgRes = await client.rpc("tools/call", {
        name: "get_slide_image",
        arguments: { deck: "01-Intro.pdf", page: 2 },
      });
      assert.equal(slideImgRes.content[1].type, "image");
      assert.equal(slideImgRes.content[1].mimeType, "image/png");

      // app_crop_selection + read_ppt_crop + path traversal check
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
      const cropId = cropA.structuredContent.cropId;
      assert.ok(cropId && cropId.startsWith("crop_"));

      const readCropRes = await client.rpc("tools/call", {
        name: "read_ppt_crop",
        arguments: { cropId },
      });
      assert.equal(readCropRes.content[1].type, "image");
      assert.equal(readCropRes.content[1].mimeType, "image/png");

      const badCropRes = await client.rpc("tools/call", {
        name: "read_ppt_crop",
        arguments: { cropId: "../evil.png" },
      });
      assert.equal(badCropRes.isError, true);

      // Web bridge (start_web_reader + HTTP routes + get_pending_ppt_question)
      const webRes = await client.rpc("tools/call", {
        name: "start_web_reader",
        arguments: { courseDir: courseA, port: 49213 },
      });
      const baseUrl = webRes.structuredContent.url;
      assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

      const pageHtml = await (await fetch(baseUrl + "/")).text();
      assert.match(pageHtml, /__PPT_READER_WEB_MODE__/);

      const apiListResp = await fetch(baseUrl + "/api/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "app_list_decks", arguments: {} }),
      });
      assert.equal(apiListResp.status, 200);
      const apiListJson = await apiListResp.json();
      assert.equal(apiListJson.structuredContent.decks.length, 1);

      const disallowedResp = await fetch(baseUrl + "/api/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "open_ppt_reader", arguments: {} }),
      });
      assert.equal(disallowedResp.status, 403);

      const askResp = await fetch(baseUrl + "/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `【PPT伴读提问】\n- 课件：01 课程导论\n- 选区截图ID：${cropId}\n- 我的问题：讲一下核心公式`,
          deck: "01-Intro.pdf",
          page: 2,
          cropId,
          cropPath: cropA.structuredContent.cropPath,
          question: "讲一下核心公式",
        }),
      });
      assert.equal(askResp.status, 200);

      const pendingRes = await client.rpc("tools/call", {
        name: "get_pending_ppt_question",
        arguments: { markConsumed: true },
      });
      assert.match(pendingRes.content[0].text, /讲一下核心公式/);
      assert.equal(pendingRes.content[1].type, "image");
      assert.equal(pendingRes.content[1].mimeType, "image/png");

      // Zero-config auto-discovery with raw courseB
      const openB = await client.rpc("tools/call", {
        name: "open_ppt_reader",
        arguments: { courseDir: courseB },
      });
      assert.equal(openB.structuredContent.configured, true);
      assert.equal(openB.structuredContent.synthesized, true);
      console.log("All MCP + Claude Desktop + Codex Web Bridge tests PASSED");
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
