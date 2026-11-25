// Claude Code 接入：按课程目录写入 .mcp.json、预批准设置、CLAUDE.md 规则块，并安装 Skill。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_MD_START = "<!-- ppt-study-reader:start -->";
export const CLAUDE_MD_END = "<!-- ppt-study-reader:end -->";

export function claudeMdBlock() {
  return `${CLAUDE_MD_START}
## PPT 伴读（ppt-study-reader）

本目录的课程 PDF 已接入 ppt-study-reader MCP 服务 \`ppt_study_reader\`。原课件 PDF 一律不改动；逐页标注在 \`标注版PPT/study_annotations.json\`。

- **复习规划 / 逐页标注**：按 \`ppt-exam-prep\` Skill 的 5 步流程执行。
- **边看边问**：Claude Code 显示不了内嵌界面，调用 \`start_web_reader\` 打开浏览器伴读，并把链接给用户。
- **提问自动送达**：\`start_web_reader\` 返回的 \`listenCommand\` 要立刻用 Bash 的 \`run_in_background\` 在后台运行。
  - 用户在浏览器点「提问」后它会退出并带出问题：调用 \`get_pending_ppt_question\` 取回问题与选区截图，再作答；
  - 每答完一题，用同一条命令重新在后台挂起；输出 \`PPT_WAIT_TIMEOUT\` 时静默重新挂起；输出 \`PPT_BRIDGE_DOWN\` 时重新调用 \`start_web_reader\`。
  - 监听器启动时若已有未读提问（监听断开期间提交的），会立即带出，不会漏接。
  - 若本会话收到过 \`<channel source="ppt_study_reader">\` 推送（终端用 \`--dangerously-load-development-channels\` 启动时），提问会直接送达，不必再挂监听。
  - 会话恢复（resume / compact）后，SessionStart hook 会提示重新挂监听并补收未读提问。
- **收到 \`【PPT伴读提问】\`**：带 \`选区截图ID\` 时先调用 \`read_ppt_crop({ cropId })\` 看图再回答。
- **讲解风格**：零基础大白话优先，用通俗类比和直观流程讲透核心直觉，联系真实题型或代码。
  - \`🔴 可跳过\` 的页：先用 1~2 句说明它是低优先级，再简明回答；
  - \`🟢 重点精读\` / \`🟡 速览了解\`：讲清为什么重要、核心结论和常见易错点。
- **只想看某页**：调用 \`get_slide_image({ deck, page })\`。
${CLAUDE_MD_END}
`;
}

function readJsonOr(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

/** 写入或替换 CLAUDE.md 中的标记块，块外内容保持不变（幂等）。 */
export function upsertClaudeMd(filePath, block = claudeMdBlock()) {
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = prev.indexOf(CLAUDE_MD_START);
  const end = prev.indexOf(CLAUDE_MD_END);
  let next;
  if (start !== -1 && end > start) {
    next = prev.slice(0, start) + block.trimEnd() + prev.slice(end + CLAUDE_MD_END.length);
  } else {
    next = prev.trim() ? `${prev.trimEnd()}\n\n${block}` : block;
  }
  if (!next.endsWith("\n")) next += "\n";
  fs.writeFileSync(filePath, next, "utf8");
}

export function setupClaudeCode({ repoRoot, serverEntry, courseDir, apply, skillsDir }) {
  console.log("=== Claude Code（桌面版 Code 标签页 / CLI / IDE）===");
  console.log("方式 1（推荐）：作为插件安装，在 Claude Code 里执行：");
  console.log("  /plugin marketplace add zhangyizhen123/ppt-study-reader");
  console.log("  /plugin install ppt-study-reader@ppt-study-reader");
  console.log("  然后在课程 PDF 所在目录打开会话即可（自动以该目录为课程目录）。\n");
  console.log("方式 2：按课程目录本地配置（需要 --course-dir；加 --apply 才会写入）：");
  if (!courseDir) {
    console.log("  未提供 --course-dir，跳过。\n");
    return null;
  }
  const mcpPath = path.join(courseDir, ".mcp.json");
  const settingsPath = path.join(courseDir, ".claude", "settings.local.json");
  const claudeMdPath = path.join(courseDir, "CLAUDE.md");
  const skillDst = path.join(skillsDir || path.join(os.homedir(), ".claude", "skills"), "ppt-exam-prep");
  const entry = {
    command: "node",
    args: [serverEntry],
    env: { PPT_COURSE_DIR: courseDir, PPT_ANNOTATIONS_PATH: "" },
  };
  console.log(`  ${mcpPath}  ← 合并 mcpServers.ppt_study_reader`);
  console.log(`  ${settingsPath}  ← enabledMcpjsonServers 加入 ppt_study_reader（免去首次批准）`);
  console.log(`  ${claudeMdPath}  ← 写入/更新 PPT 伴读规则块`);
  console.log(`  ${skillDst}  ← 复制 ppt-exam-prep Skill`);
  if (!apply) {
    console.log("  （预览模式，未写入任何文件；加 --apply 执行）\n");
    return null;
  }

  const mcp = readJsonOr(mcpPath, {});
  mcp.mcpServers = { ...(mcp.mcpServers || {}), ppt_study_reader: entry };
  writeJson(mcpPath, mcp);

  const settings = readJsonOr(settingsPath, {});
  const enabled = new Set(
    Array.isArray(settings.enabledMcpjsonServers) ? settings.enabledMcpjsonServers : [],
  );
  enabled.add("ppt_study_reader");
  settings.enabledMcpjsonServers = [...enabled];
  writeJson(settingsPath, settings);

  upsertClaudeMd(claudeMdPath);

  // Windows 上创建目录软链需要管理员/开发者模式，统一复制
  fs.rmSync(skillDst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(skillDst), { recursive: true });
  fs.cpSync(path.join(repoRoot, "skills", "ppt-exam-prep"), skillDst, { recursive: true });

  console.log("  已写入。在该目录新开一个 Claude Code 会话即可使用。\n");
  return { mcpPath, settingsPath, claudeMdPath, skillDst };
}
