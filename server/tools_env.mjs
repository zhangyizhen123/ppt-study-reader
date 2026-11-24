// 外部工具（poppler / python）定位，主要解决 Windows 上的坑：
// - Git for Windows / MSYS2 自带的 pdftotext 是 xpdf 版，不支持 -bbox；
// - MiKTeX 自带的 poppler 不支持非 ANSI（如中文）路径；
// - Windows 上常常没有 python3，只有 python / py。
// 用法：在入口最先调用 applyToolEnv()，之后 execFile("pdftotext", ...) 即可命中正确版本；
// 需要 python 时用 pythonCommand() 取 [可执行文件, ...前置参数]。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function pathKey(env = process.env) {
  return Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
}

function isPopplerBin(dir) {
  const exe = path.join(dir, process.platform === "win32" ? "pdftotext.exe" : "pdftotext");
  if (!fs.existsSync(exe)) return false;
  const r = spawnSync(exe, ["-v"], { encoding: "utf8", windowsHide: true });
  return /poppler/i.test(`${r.stdout || ""}${r.stderr || ""}`);
}

function popplerCandidates() {
  const list = [];
  if (process.env.PPT_POPPLER_BIN) list.push(process.env.PPT_POPPLER_BIN);
  if (process.platform === "win32") {
    const home = os.homedir();
    list.push(path.join(process.env.SCOOP || path.join(home, "scoop"), "apps", "poppler", "current", "bin"));
    if (process.env.CONDA_PREFIX) list.push(path.join(process.env.CONDA_PREFIX, "Library", "bin"));
    list.push("C:\\ProgramData\\chocolatey\\lib\\poppler\\tools\\Library\\bin");
  }
  return list;
}

let applied = null;

/** 把可用的 poppler 目录前置到 PATH（幂等）。返回选中的目录，没找到时返回 ""。 */
export function applyToolEnv() {
  if (applied !== null) return applied;
  applied = "";
  for (const dir of popplerCandidates()) {
    if (dir && isPopplerBin(dir)) {
      const key = pathKey();
      const cur = process.env[key] || "";
      const parts = cur.split(path.delimiter);
      if (parts[0] !== dir) process.env[key] = [dir, ...parts.filter((p) => p !== dir)].join(path.delimiter);
      applied = dir;
      break;
    }
  }
  return applied;
}

let pythonCache = null;

/** 返回能 import PIL 的 python 调用方式，如 ["python3"] 或 ["py", "-3"]。 */
export function pythonCommand() {
  if (pythonCache) return pythonCache;
  const candidates = [];
  if (process.env.PPT_PYTHON) candidates.push([process.env.PPT_PYTHON]);
  candidates.push(["python3"], ["python"]);
  if (process.platform === "win32") candidates.push(["py", "-3"]);
  for (const [cmd, ...pre] of candidates) {
    const r = spawnSync(cmd, [...pre, "-c", "import PIL"], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) {
      pythonCache = [cmd, ...pre];
      return pythonCache;
    }
  }
  // 兜底：保持原行为，让调用处报出清晰错误
  pythonCache = [process.platform === "win32" ? "python" : "python3"];
  return pythonCache;
}
