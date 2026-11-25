#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupClaudeCode } from "./setup_claude_code.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

function parseArgs() {
  const opts = {
    client: "all",
    courseDir: "",
    apply: false,
    skillsDir: "",
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--client" && argv[i + 1]) opts.client = argv[++i];
    else if (a.startsWith("--client=")) opts.client = a.slice("--client=".length);
    else if (a === "--course-dir" && argv[i + 1]) opts.courseDir = argv[++i];
    else if (a.startsWith("--course-dir=")) opts.courseDir = a.slice("--course-dir=".length);
    else if (a === "--apply") opts.apply = true;
    else if (a.startsWith("--skills-dir=")) opts.skillsDir = a.slice("--skills-dir=".length);
  }
  return opts;
}

function getClaudeConfigHintPath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || "%APPDATA%", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function main() {
  const opts = parseArgs();
  const validClients = new Set(["all", "antigravity", "claude", "claude-code", "codex"]);
  if (!validClients.has(opts.client)) {
    console.error(`Invalid --client "${opts.client}". Expected: all|antigravity|claude (桌面版 Chat)|claude-code (Claude Code / 桌面版 Code)|codex`);
    process.exit(1);
  }

  const serverEntry = path.join(REPO_ROOT, "server", "index.mjs");
  const dataDir = path.join(os.homedir(), ".ppt-study-reader-data");
  const courseDir = opts.courseDir ? path.resolve(opts.courseDir) : "";

  if (opts.client === "all" || opts.client === "claude") {
    const claudeSnippet = {
      mcpServers: {
        ppt_study_reader: {
          command: "node",
          args: [serverEntry, `--data-dir=${dataDir}`],
          env: {
            PPT_COURSE_DIR: courseDir,
            PPT_ANNOTATIONS_PATH: "",
          },
        },
      },
    };
    console.log("=== Claude 桌面版 · Chat 标签页（Code 标签页请用 --client claude-code）===");
    console.log(`配置文件路径参考：${getClaudeConfigHintPath()}`);
    console.log("将以下内容合并到 claude_desktop_config.json：");
    console.log(JSON.stringify(claudeSnippet, null, 2));
    console.log("");
  }

  if (opts.client === "all" || opts.client === "codex") {
    const codexToml = `[mcp_servers.ppt_study_reader]\ncommand = "node"\nargs = ${JSON.stringify([
      serverEntry,
      `--data-dir=${dataDir}`,
    ])}\n\n[mcp_servers.ppt_study_reader.env]\nPPT_COURSE_DIR = ${JSON.stringify(
      courseDir,
    )}\nPPT_ANNOTATIONS_PATH = ""\n`;

    console.log("=== OpenAI Codex (CLI / App) ===");
    console.log("方式 1：一条命令注册 MCP Server：");
    const envFlags = courseDir ? `--env PPT_COURSE_DIR=${JSON.stringify(courseDir)} ` : "";
    console.log(
      `  codex mcp add ppt_study_reader ${envFlags}-- node ${JSON.stringify(serverEntry)} ${JSON.stringify(
        `--data-dir=${dataDir}`,
      )}`,
    );
    console.log("\n方式 2：或直接写入 ~/.codex/config.toml：");
    console.log(codexToml);
    console.log("建议将 Skill 链接到 ~/.codex/skills/ppt-exam-prep 并在课程目录放置本仓库 AGENTS.md。\n");

    if (opts.apply) {
      const codexSkillDir = path.join(os.homedir(), ".codex", "skills");
      const dstSkill = path.join(codexSkillDir, "ppt-exam-prep");
      const srcSkill = path.join(REPO_ROOT, "skills", "ppt-exam-prep");
      fs.mkdirSync(codexSkillDir, { recursive: true });
      if (!fs.existsSync(dstSkill)) {
        try {
          fs.symlinkSync(srcSkill, dstSkill, "dir");
          console.log(`已安装 Codex Skill 软链：${dstSkill} -> ${srcSkill}`);
        } catch {
          fs.cpSync(srcSkill, dstSkill, { recursive: true });
          console.log(`已复制 Codex Skill：${dstSkill}`);
        }
      } else {
        console.log(`Codex Skill 已存在，跳过：${dstSkill}`);
      }

      try {
        const mcpArgs = ["mcp", "add", "ppt_study_reader"];
        if (courseDir) mcpArgs.push("--env", `PPT_COURSE_DIR=${courseDir}`);
        mcpArgs.push("--", "node", serverEntry, `--data-dir=${dataDir}`);
        execFileSync("codex", mcpArgs, { stdio: "inherit" });
        console.log("已通过 codex mcp add 完成注册。");
      } catch (err) {
        console.error(
          "未能自动执行 codex mcp add（可能未在 PATH 中或已存在同名配置），请按上面打印的 TOML 手动写入 ~/.codex/config.toml。",
        );
      }
    }
  }

  if (opts.client === "all" || opts.client === "claude-code") {
    setupClaudeCode({
      repoRoot: REPO_ROOT,
      serverEntry,
      courseDir,
      apply: opts.apply,
      skillsDir: opts.skillsDir,
    });
  }

  if (opts.client === "all" || opts.client === "antigravity") {
    console.log("=== Antigravity ===");
    console.log("将仓库克隆或复制到 ~/.gemini/config/plugins/ppt-study-reader 后运行 npm install --omit=dev 即可自动发现。");
    console.log("");
  }
}

main();
