#!/usr/bin/env node
// 浏览器伴读提问监听器（给 Claude Code 等「后台命令退出即唤醒模型」的客户端用）。
//
// 用法：node scripts/wait_question.mjs --url http://127.0.0.1:4173 [--timeout 7200]
//
// 长轮询浏览器伴读桥的 /api/wait：
// - 用户在浏览器里点「提问」→ 打印问题并以 0 退出（后台任务结束会唤醒模型去回答）；
// - 总时长超时 → 打印 PPT_WAIT_TIMEOUT 并退出（模型应静默重新挂起）；
// - 伴读服务连不上 → 打印 PPT_BRIDGE_DOWN 并以 2 退出。
// 只依赖 Node 内置模块（Node >= 18 的全局 fetch）。

function parseArgs(argv) {
  const opts = { url: process.env.PPT_WEB_URL || "http://127.0.0.1:4173", timeout: 7200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url" && argv[i + 1]) opts.url = argv[++i];
    else if (a.startsWith("--url=")) opts.url = a.slice("--url=".length);
    else if (a === "--timeout" && argv[i + 1]) opts.timeout = Number(argv[++i]);
    else if (a.startsWith("--timeout=")) opts.timeout = Number(a.slice("--timeout=".length));
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) opts.timeout = 7200;
  opts.url = opts.url.replace(/\/+$/, "");
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 连不上伴读服务时最多重试多久（毫秒）；服务刚重启时可能短暂不可用
const FAIL_GRACE_MS = Number(process.env.PPT_WAIT_FAIL_GRACE_MS) || 30_000;

function formatQuestion(q) {
  const lines = [
    "PPT_QUESTION_RECEIVED",
    q.text || q.question || "(空问题)",
  ];
  if (q.cropId && !String(q.text || "").includes(q.cropId)) {
    lines.push(`选区截图ID: ${q.cropId}`);
  }
  lines.push(
    "",
    "→ 给助手：请调用 MCP 工具 get_pending_ppt_question 取回问题与选区截图后作答；" +
      "答完后用同一条命令在后台重新挂起本监听器，以便接收下一个提问。",
  );
  return lines.join("\n");
}

async function main() {
  const { url, timeout } = parseArgs(process.argv.slice(2));
  const since = new Date().toISOString();
  const deadline = Date.now() + timeout * 1000;
  let failSince = 0;

  while (Date.now() < deadline) {
    const remainSec = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const hold = Math.min(25, remainSec);
    try {
      const resp = await fetch(
        `${url}/api/wait?since=${encodeURIComponent(since)}&hold=${hold}`,
        { signal: AbortSignal.timeout((hold + 15) * 1000) },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      failSince = 0;
      if (data.found) {
        process.stdout.write(formatQuestion(data) + "\n");
        return 0;
      }
      if (data.closing) {
        process.stdout.write("PPT_BRIDGE_DOWN 伴读服务已关闭，请重新调用 start_web_reader。\n");
        return 2;
      }
    } catch (err) {
      if (!failSince) failSince = Date.now();
      if (Date.now() - failSince > FAIL_GRACE_MS) {
        process.stdout.write(
          `PPT_BRIDGE_DOWN 连不上 ${url}（${err.message}）。请重新调用 start_web_reader，再用它返回的 listenCommand 挂起监听。\n`,
        );
        return 2;
      }
      await sleep(2000);
    }
  }
  process.stdout.write("PPT_WAIT_TIMEOUT 暂无新提问。请静默地用同一条命令在后台重新挂起监听。\n");
  return 0;
}

process.exitCode = await main();
