# PPT 伴读（ppt-study-reader）

> 面向大学生的 AI 期末速通 & 新课预习 PPT 伴读工具箱（支持 Antigravity · Claude Desktop · Claude Code · OpenAI Codex）
>
> 把几百页密密麻麻的课程 PDF 变成**“绿/黄/红重点分级 + 离线《标注版 PPT》 + 交互式画框即问”**的学习流——零改动原课件，任何专业都能直接用。

---

## 客户端兼容性一览

| 客户端 | 伴读交互方式 | 选区截图识图 | 复习规划 Skill & 规则 |
| :--- | :--- | :--- | :--- |
| **Antigravity** | 原生侧边栏（`aux_pane`）内嵌伴读，框选直发左侧对话 | 支持：`read_ppt_crop` / `read_file` | 支持：自动发现插件 `skills/` & `rules/` |
| **Claude Desktop** | 原生 MCP Apps（SEP-1865）内嵌 / 全屏伴读，框选直发对话 | 支持：自动调用 `read_ppt_crop` 返回原生图像 | 支持：内置 MCP Prompts + `AGENTS.md` |
| **Claude Code** | 对话内调用 `start_web_reader` 在浏览器交互；Claude 在后台挂起提问监听器，**点「提问」即自动送达，无需粘贴** | 支持：`get_pending_ppt_question` / `read_ppt_crop` | 支持：插件自带 Skill，或 setup 写入 `CLAUDE.md` + `~/.claude/skills/` |
| **Codex (CLI / App)** | 对话内调用 `start_web_reader`（或 `npm run web`）在浏览器交互，支持自动回传问题与截图 | 支持：自动调用 `get_pending_ppt_question` / `read_ppt_crop` | 支持：仓库根目录 `AGENTS.md` + `~/.codex/skills/` |
| **任意 PDF 阅读器** | `标注版PPT/` 离线高清矢量标注 PDF（iPad / GoodNotes / WPS / Edge） | — | — |

---

## 核心功能

1. **多天复习规划 + 逐页红黄绿重点标注（`ppt-exam-prep` Skill）**
   - 自动扫描课程目录下所有 PDF 提纲，按你的可用天数（如 3 天冲刺 / 4 天预习）制定节奏；
   - 给每一页打上分级与一句话提醒：
     - **`★ 重点精读`（绿）**：必考概念、核心公式、例题、原理架构图
     - **`● 速览了解`（黄）**：过渡示例、辅助理解内容
     - **`○ 可跳过`（红）**：封面致谢、发展史、考前可忽略的冷门细节
2. **无损生成离线《标注版 PPT》（原文件 0 修改）**
   - 保留原 PDF 100% 矢量清晰度与可选文字，另存到 `标注版PPT/` 目录；
   - 顶部叠印彩色进度细条，底部留白区叠印高清中文标签与一句话提示；
   - **智能防遮挡**：自动检测每一页正文坐标，满屏排版时自动改用顶部空白角标，**导出到平板/打印都能看**。
3. **交互式「PPT 伴读」阅读器（支持 MCP Apps & 浏览器伴读桥）**
   - **左键拖拽框选（默认，文字 + 图表通吃）**：框出代码块、数学公式、电路/架构图，松手自动提取文字**并附带选区局部高清截图**；
   - **左键原地长按 ≥ 0.35s**：自动智能吸附选中整行/紧邻段落；
   - **一键切换「纯划词」**：像普通网页一样拖选文字，松手弹出提问浮窗；
   - 浮窗内置一键提问胶囊：**`大白话讲讲`** / **`举个例子`** / **`考点/易错点`** / **`出题自测`**；
   - 支持 **`全部 / 只看重点 / 隐藏跳过`** 筛选（翻页和目录会自动跳过低优先级页面），还能点击页面徽章手动调整重点并持久化保存。
4. **零配置即开即用**
   - 就算还没有 `study_annotations.json`，只要把任意包含 `.pdf` 课件的文件夹路径告诉 AI（或填进 `PPT_COURSE_DIR`），就能立刻扫描页数并打开伴读。

---

## 快速安装（公共前提）

- **Node.js** >= 18
- **Python 3** + `Pillow`（渲染高清中文标签与选区截图裁剪）
- **Poppler 工具链**：`pdftoppm`、`pdftotext`、`pdfinfo`
  - Ubuntu / WSL：`sudo apt-get install -y poppler-utils python3-pil fonts-noto-cjk`
  - macOS：`brew install poppler && pip3 install pillow`
  - Windows：`scoop install poppler` + `pip install pillow`
    - 注意：Git for Windows 自带的 `pdftotext` 是 xpdf 版（不支持 `-bbox`），MiKTeX 自带的 poppler 打不开中文路径。本工具会自动优先使用 scoop 安装的 poppler，也可用环境变量 `PPT_POPPLER_BIN` 指定 poppler 的 `bin` 目录。
    - 中文标签字体自动使用系统自带的微软雅黑。

---

## 分客户端接入指南

### 1. Antigravity

```bash
git clone https://github.com/zhangyizhen123/ppt-study-reader.git ~/.gemini/config/plugins/ppt-study-reader
cd ~/.gemini/config/plugins/ppt-study-reader
npm install --omit=dev
```

在对话里直接说：
> “我有 4 天时间学习 `/你的课程PPT文件夹路径`，帮我制定学习计划、逐页标出重点生成标注版 PPT，并打开 PPT 伴读侧边栏。”

---

### 2. Claude Desktop

Claude Desktop 原生支持 MCP Apps（`ui://`）以及本服务暴露的原生图像工具（`read_ppt_crop` / `get_slide_image`）。

```bash
git clone https://github.com/zhangyizhen123/ppt-study-reader.git ~/ppt-study-reader
cd ~/ppt-study-reader
npm install --omit=dev
npm run setup -- --client claude --course-dir "/你的课程PPT文件夹路径"
```

把打印出的 JSON（或参考 [`configs/claude_desktop_config.example.json`](configs/claude_desktop_config.example.json)）合并到你的 `claude_desktop_config.json`，重启 Claude Desktop 后：
- 直接说：**“调用 `open_ppt_reader` 打开我的课件”**，界面会以内嵌/全屏交互卡片渲染；
- 用鼠标左键框选或长按后点 **提问**，消息会自动带上 `选区截图ID`，Claude 会调用 `read_ppt_crop` 看到你框选的局部高清图来解答。

---

### 3. Claude Code（CLI / 桌面版 Code 标签页）

**方式 A：插件安装（推荐，免 clone、免 npm install）**

在 Claude Code 里执行：

```text
/plugin marketplace add zhangyizhen123/ppt-study-reader
/plugin install ppt-study-reader@ppt-study-reader
```

之后在**课程 PDF 所在目录**打开会话即可，服务会自动把启动目录当作课程目录。`ppt-exam-prep` Skill 随插件一起装好。

**方式 B：按课程目录本地配置**

```bash
git clone https://github.com/zhangyizhen123/ppt-study-reader.git ~/ppt-study-reader
cd ~/ppt-study-reader
npm install --omit=dev
npm run setup -- --client claude-code --course-dir "/你的课程PPT文件夹路径" --apply
```

它会在课程目录写入以下内容，然后在该目录新开一个会话即可：
- `.mcp.json`：注册 `ppt_study_reader`；
- `.claude/settings.local.json`：预先批准该服务，免去首次确认；
- `CLAUDE.md`：写入伴读规则块，重复执行只会更新这一块；
- 另外把 Skill 复制到 `~/.claude/skills/ppt-exam-prep`。

**提问自动送达**

1. 说「启动浏览器 PPT 伴读」：Claude 调用 `start_web_reader` 给出 `http://127.0.0.1:4173`，并在后台挂起提问监听器 `scripts/wait_question.mjs`。
2. 你在浏览器里框选 / 长按 / 划词后点 **提问**，页面提示「已送达 AI」。
3. 监听器随即退出，Claude 被自动唤醒，调用 `get_pending_ppt_question` 拿到问题和选区截图后作答，答完再重新挂起监听。

原理：MCP 服务没法主动往对话里发消息，但 Claude Code 的后台命令结束时会唤醒模型，监听器就是利用这一点。如果后台没有监听器，提问会照旧保存并复制到剪贴板。

---

### 4. OpenAI Codex (CLI / App)

Codex CLI 在终端运行，本仓库同时提供 **`AGENTS.md` + Skill + 本地环回浏览器伴读桥（`127.0.0.1`）**：

```bash
git clone https://github.com/zhangyizhen123/ppt-study-reader.git ~/ppt-study-reader
cd ~/ppt-study-reader
npm install --omit=dev
# 一键安装 Codex Skill（~/.codex/skills/ppt-exam-prep）并注册 MCP Server：
npm run setup -- --client codex --course-dir "/你的课程PPT文件夹路径" --apply
```

（如果想手动配置，可参考 [`configs/codex_config.example.toml`](configs/codex_config.example.toml) 写入 `~/.codex/config.toml`。）

**在 Codex 中的两种用法**：
1. 在 Codex 对话里说：**“帮我用 3 天规划课程复习并启动浏览器 PPT 伴读”**，Codex 会调用 `start_web_reader` 给出 `http://127.0.0.1:4173`；
   - 你在浏览器里左键拖拽框选 / 长按整行 / 划词后点击 **提问**：
   - 提问内容会**自动保存进待答队列并复制到剪贴板**；切回 Codex 直接粘贴回车，**或者直接说“讲一下我刚框选的 PPT”**（Codex 会调用 `get_pending_ppt_question` 同时拿到问题文本和选区截图）。
2. 也可以在终端单独启动浏览器伴读视图：
   ```bash
   npm run web -- --course-dir "/你的课程PPT文件夹路径"
   ```

---

## 单独使用离线 PDF 标注 CLI

如果你只想要**带重点标签的离线 PDF**（放平板或打印复习），可以直接运行：

```bash
# 1. 提取所有 PDF 的逐页大纲
python3 scripts/extract_index.py --course-dir /path/to/course-pdfs --out /tmp/slides_dump.json

# 2. 让 AI 根据 /tmp/slides_dump.json 生成 study_annotations.json（格式见 examples/study_annotations.example.json）

# 3. 一键生成无损《标注版 PPT》（支持 4:3 / 16:9 / A4，原件 0 修改）
node scripts/annotate_all.mjs \
  --course-dir /path/to/course-pdfs \
  --annotations /path/to/course-pdfs/标注版PPT/study_annotations.json \
  --out-dir /path/to/course-pdfs/标注版PPT
```

---

## 暴露的 MCP 工具与 Prompts 一览

- **UI 入口工具**：`open_ppt_reader`（支持 MCP Apps 的宿主渲染内嵌/全屏/侧边栏 UI）
- **终端伴读工具**：`start_web_reader`（启动 `127.0.0.1` 浏览器伴读视图，并返回提问监听命令 `listenCommand`）、`get_pending_ppt_question`（取回最新框选问题与图片）
- **跨平台识图工具**：`read_ppt_crop`（按 `cropId` 返回选区 `ImageContent`）、`get_slide_image`（返回整页 `ImageContent` 与文本摘录）
- **MCP Prompts**：`exam_prep_plan`、`explain_ppt_selection`

---

## 目录结构

```text
ppt-study-reader/
├── AGENTS.md                          # 通用助手规则（Codex / 通用 Agent 自动读取）
├── plugin.json                        # Antigravity 插件元数据
├── mcp_config.json                    # MCP 服务配置模板
├── .claude-plugin/                    # Claude Code 插件清单（plugin.json + marketplace.json）
├── .mcp.json                          # Claude Code 插件的 MCP 服务声明（指向 dist/server.mjs）
├── dist/                              # 免 npm install 的单文件打包产物（server.mjs / annotate_pdfs.mjs）
├── configs/
│   ├── claude_desktop_config.example.json
│   └── codex_config.example.toml
├── rules/AGENTS.md                    # 插件内置伴读答疑规则
├── skills/ppt-exam-prep/SKILL.md      # 通用“盘点→规划→标注→伴读”工作流 Skill
├── server/
│   ├── core.mjs                       # PDF 渲染、坐标提取、裁图与标注核心逻辑
│   ├── web_bridge.mjs                 # 127.0.0.1 环回浏览器伴读桥
│   ├── web.mjs                        # npm run web 独立启动入口
│   ├── tools_env.mjs                  # poppler / python 定位（Windows 兼容）
│   └── index.mjs                      # 跨客户端 MCP Server (stdio)
├── ui/
│   ├── src/app.ts & styles.css        # MCP Apps + 浏览器双模交互前端
│   └── dist/app.html                  # 单文件打包产物
├── scripts/
│   ├── extract_index.py               # 扫描课程目录 PDF 文本大纲
│   ├── render_banners.py              # 碰撞检测 + Pillow 高清标签生成
│   ├── annotate_pdfs.mjs              # pdf-lib 矢量条与标签叠印
│   ├── annotate_all.mjs              # 一键生成离线标注版 PDF 入口
│   ├── crop_helper.py                 # 选区局部高清截图裁剪
│   ├── _tools.py                      # Python 脚本共用的 poppler 定位与 UTF-8 输出
│   ├── wait_question.mjs              # 浏览器提问监听器（Claude Code 后台挂起，提问自动送达）
│   ├── setup_clients.mjs              # Claude Desktop / Claude Code / Codex / Antigravity 配置生成器
│   ├── setup_claude_code.mjs          # Claude Code 课程目录配置（.mcp.json / CLAUDE.md / Skill）
│   ├── build_ui.mjs                   # esbuild 单文件打包脚本（UI）
│   ├── build_bundles.mjs              # esbuild 打包 dist/（插件免依赖运行）
│   └── smoke_test.mjs                 # 全链路端到端自测（npm test）
└── examples/study_annotations.example.json
```

---

## 运行自测

```bash
npm test
```

自测会自动生成临时的示例 PDF（无任何外部文件依赖），覆盖离线标注流水线、MCP Prompts、`read_ppt_crop` / `get_slide_image` 原生图像返回、`start_web_reader` 本地 HTTP 服务、提问长轮询与 `wait_question.mjs` 监听器、`get_pending_ppt_question` 全链路、Claude Code setup，以及 `dist/server.mjs` 免依赖启动。

修改 `server/` 或 `ui/src/` 后请运行 `npm run build`（需要完整 `npm install`），重新生成 `ui/dist/` 与 `dist/`。

---

## 版权与开源协议

- 基于 [MIT License](LICENSE) 开源。
- **版权声明**：本仓库仅包含开源工具代码、Skill 提示词模板与极简格式示例，**不包含任何高校教材、老师课件原件或版权 PDF**，请配合你自己合法获取的课程资料使用。
