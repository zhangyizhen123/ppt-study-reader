#!/usr/bin/env node
// Claude Code SessionStart hook：会话恢复（resume / compact）后，自动提醒模型恢复浏览器伴读的提问监听，
// 并带上监听断开期间用户提交、尚未被读取的提问。
//
// 配置（课程目录的 .claude/settings.json）：
//   "hooks": { "SessionStart": [ { "matcher": "resume|compact",
//     "hooks": [ { "type": "command", "command": "node \"<repo>/scripts/session_start_hook.mjs\"" } ] } ] }
//
// 只在 resume / compact 时起作用：全新会话（包括 side chat）不自动挂监听，
// 避免多个会话同时监听、对同一个提问重复作答。
// 课程目录：--course-dir=... > PPT_COURSE_DIR > CLAUDE_PROJECT_DIR > 当前目录。
// 只依赖 Node 内置模块。
import fs from "node:fs";
import path from "node:path";
import { defaultDataDir } from "../server/data_dir.mjs";

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function emit(context) {
  if (!context) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context },
    }),
  );
}

async function main() {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    input = {};
  }
  const source = input.source || "";
  if (source && !["resume", "compact"].includes(source)) return;

  const argDir = process.argv.slice(2).find((a) => a.startsWith("--course-dir="));
  const courseDir =
    (argDir && argDir.slice("--course-dir=".length)) ||
    process.env.PPT_COURSE_DIR ||
    process.env.CLAUDE_PROJECT_DIR ||
    input.cwd ||
    process.cwd();

  let pending = null;
  try {
    const p = JSON.parse(
      fs.readFileSync(path.join(defaultDataDir(courseDir), "pending_question.json"), "utf8"),
    );
    if (p && p.text && !p.consumed) pending = p;
  } catch {
    pending = null;
  }

  const lines = [
    "【PPT 伴读 · 会话已恢复】此前挂在后台的提问监听随会话进程重启已失效。",
    "如果本会话此前在用浏览器 PPT 伴读答疑：请调用 start_web_reader（会复用或重启 127.0.0.1 伴读服务），",
    "再按其返回说明用 run_in_background 重新挂起 listenCommand 监听（若本会话收到过 channel 推送则不必）。不需要向用户解释这一步。",
  ];
  if (pending) {
    lines.push(
      `另有一条监听断开期间提交、尚未读取的提问（${pending.deck || "?"} 第 ${pending.page || "?"} 页，提交于 ${pending.savedAt}）：`,
      "请先调用 get_pending_ppt_question 取回并作答，告诉用户这是断线期间补收的。",
    );
  }
  emit(lines.join("\n"));
}

main().catch(() => {});
