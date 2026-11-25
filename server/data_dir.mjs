// 课程数据目录的计算规则（MCP 服务与 SessionStart hook 共用，保证两边找到同一份 pending_question.json）。
// 只依赖 Node 内置模块。
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export function courseDataKey(dir) {
  const resolved = path.resolve(dir);
  const norm = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = crypto.createHash("sha1").update(norm).digest("hex").slice(0, 8);
  const base = path.basename(resolved).replace(/[^\p{L}\p{N}_.-]+/gu, "_").slice(0, 40) || "course";
  return `${base}-${hash}`;
}

export function defaultDataDir(courseDir) {
  const base = path.join(os.homedir(), ".ppt-study-reader-data");
  return courseDir ? path.join(base, courseDataKey(courseDir)) : path.join(base, "default");
}
