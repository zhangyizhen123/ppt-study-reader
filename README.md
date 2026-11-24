# PPT 伴读（ppt-study-reader）

> 🎓 **面向大学生的 AI 期末速通 & 新课预习 PPT 伴读工具箱**
>
> 把几百页密密麻麻的课程 PDF 变成**“绿/黄/红重点分级 + 离线《标注版 PPT》 + 侧边栏画框即问”**的学习流——零改动原课件，任何专业都能直接用。

---

## ✨ 痛点与核心功能

面对期末考前七八百页全英文/专业课 PPT，最耗时间的往往不是看不懂，而是**不知道哪页该跳过、哪页是必考，以及看一页卡住还得来回截图问 AI**。

`ppt-study-reader` 提供一套完整闭环（既可以作为 **Antigravity 插件 / MCP App** 在侧边栏伴读，也可以单独当**离线 PDF 标注 CLI** 使用）：

1. **🧠 多天复习规划 + 逐页红黄绿重点标注（内置 `ppt-exam-prep` Skill）**
   - 自动扫描课程目录下所有 PDF 提纲，按你的可用天数（如 3 天冲刺 / 4 天预习）制定节奏；
   - 给每一页打上分级与一句话提醒：
     - 🟢 **`★ 重点精读`**：必考概念、核心公式、例题、原理架构图
     - 🟡 **`● 速览了解`**：过渡示例、辅助理解内容
     - 🔴 **`○ 可跳过`**：封面致谢、发展史、考前可忽略的冷门细节
2. **📄 无损生成离线《标注版 PPT》（原文件 0 修改）**
   - 保留原 PDF 100% 矢量清晰度与可选文字，另存到 `标注版PPT/` 目录；
   - 顶部叠印彩色进度细条，底部留白区叠印高清中文标签与一句话提示；
   - **智能防遮挡**：自动检测每一页正文坐标，满屏排版时自动改用顶部空白角标，**导出到 iPad / GoodNotes / WPS 都能看**。
3. **🖱️ Antigravity 侧边栏「PPT 伴读」交互阅读器（MCP App）**
   - 右侧边栏直接看课件，左侧就是你的 AI 聊天框，支持三种顺手交互：
     - **左键拖拽框选（默认，文字 + 图表通吃）**：框出代码块、数学公式、电路/架构图，松手自动提取文字**并附带选区局部高清截图**发给 AI；
     - **左键原地长按 ≥ 0.35s**：不移动松手前自动智能吸附选中整行/紧邻段落；
     - **一键切换「纯划词」**：像普通网页一样拖选文字，松手弹出提问浮窗。
   - 浮窗内置一键提问胶囊：**`大白话讲讲`** / **`举个例子`** / **`考点/易错点`** / **`出题自测`**，支持自定义问题直发或挂到输入框上下文；
   - 支持 **`全部 / 只看🟢重点 / 隐藏🔴跳过`** 筛选（翻页和目录会自动跳过低优先级页面），还能点击页面徽章手动调整重点并持久化保存。
4. **⚡ 零配置即开即用**
   - 就算还没有 `study_annotations.json`，只要把任意包含 `.pdf` 课件的文件夹路径告诉 AI（或填进 `PPT_COURSE_DIR`），就能立刻在侧边栏打开并框选提问。

---

## 🚀 3 分钟快速上手

### 1. 环境依赖

- **Node.js** >= 18
- **Python 3** + `Pillow`（用于渲染高清中文标签与框选截图裁剪）
- **Poppler 工具链**：`pdftoppm`、`pdftotext`、`pdfinfo`
  - Ubuntu / WSL：`sudo apt-get install -y poppler-utils python3-pil fonts-noto-cjk`
  - macOS：`brew install poppler && pip3 install pillow`

### 2. 安装到 Antigravity 插件目录

```bash
git clone https://github.com/zhangyizhen123/ppt-study-reader.git ~/.gemini/config/plugins/ppt-study-reader
cd ~/.gemini/config/plugins/ppt-study-reader
npm install --omit=dev
```

> 仓库已附带编译好的单文件前端 `ui/dist/app.html`，安装完依赖即可直接运行；如果你修改了 `ui/src/`，执行 `npm run build` / `npm run build:ui` 即可重新打包。

### 3. 开始使用（两种方式）

- **方式 A：让 AI 自动帮你规划 + 标注 + 打开侧边栏（推荐）**
  直接在 Antigravity 对话中发送：
  > “我有 3 天时间复习 `/你的课程PPT文件夹路径`，帮我制定学习计划、逐页标出重点生成标注版 PPT，并打开 PPT 伴读侧边栏。”

- **方式 B：先直接打开任意课程文件夹边看边问**
  1. 可选：参考 `mcp_config.example.json` 在 `mcp_config.json` 中预设默认课程路径 `PPT_COURSE_DIR`；
  2. 或直接在 Antigravity 侧边栏右上角点 **`+` → `PPT 伴读`**，也可以在对话里让 AI 调用 `open_ppt_reader` 传入你的 `courseDir`。

---

## 🛠️ 单独使用离线 PDF 标注 CLI

如果你只想要**带重点标签的离线 PDF**（放平板或打印复习），不打开侧边栏也能独立跑命令行：

1. **提取所有 PDF 的逐页大纲**：
   ```bash
   python3 scripts/extract_index.py \
     --course-dir /path/to/your/course-pdfs \
     --out /tmp/slides_dump.json
   ```
2. **准备逐页标注 JSON**（可让 AI 根据 `/tmp/slides_dump.json` 生成，格式参考 [`examples/study_annotations.example.json`](examples/study_annotations.example.json)）。
3. **一键生成无损《标注版 PPT》**（支持 4:3、16:9、A4 任意尺寸，自动识别 Linux/WSL/macOS/Windows 中文字体）：
   ```bash
   node scripts/annotate_all.mjs \
     --course-dir /path/to/your/course-pdfs \
     --annotations /path/to/your/course-pdfs/标注版PPT/study_annotations.json \
     --out-dir /path/to/your/course-pdfs/标注版PPT
   ```

---

## 📁 目录结构

```text
ppt-study-reader/
├── plugin.json                        # Antigravity 插件元数据
├── mcp_config.json                    # MCP 服务配置模板（支持零配置启动）
├── mcp_config.example.json            # 配置示例
├── package.json
├── rules/
│   └── AGENTS.md                      # 收到【PPT伴读提问】时的 AI 讲解规范
├── skills/
│   └── ppt-exam-prep/
│       └── SKILL.md                   # 通用课程“盘点→规划→标注→伴读”工作流 Skill
├── server/
│   └── index.mjs                      # MCP Server + MCP App 工具与资源接口
├── ui/
│   ├── src/
│   │   ├── app.ts                     # 侧边栏交互（框选/长按/划词/筛选/主题同步）
│   │   └── styles.css                 # 适配宿主深浅色主题的样式
│   └── dist/
│       └── app.html                   # 打包后的单文件 MCP App 前端
├── scripts/
│   ├── extract_index.py               # 扫描课程目录 PDF 文本大纲
│   ├── render_banners.py              # 碰撞检测 + Pillow 高清标签生成
│   ├── annotate_pdfs.mjs              # pdf-lib 矢量条与标签叠印
│   ├── annotate_all.mjs               # 一键生成离线标注版 PDF 入口
│   ├── crop_helper.py                 # 选区局部高清截图裁剪
│   ├── build_ui.mjs                   # esbuild 单文件打包脚本
│   └── smoke_test.mjs                 # 无外部依赖的端到端自测脚本（npm test）
└── examples/
    └── study_annotations.example.json # 标注 JSON 格式示例
```

---

## 🧪 运行自测

```bash
npm test
```

自测会自动生成临时的示例 PDF（无任何外部文件依赖），依次校验 `extract_index.py`、离线 PDF 标注生成、`open_ppt_reader` 有标注/零配置自动扫描两种模式、页面渲染与单词坐标提取、选区截图裁剪及优先度覆盖持久化。

---

## 📜 版权与开源协议

- 本项目基于 [MIT License](LICENSE) 开源。
- **版权声明**：本仓库仅包含开源工具代码、Skill 提示词模板与极简格式示例，**不包含任何高校教材、老师课件原件或版权 PDF**，请配合你自己合法获取的课程资料使用。
