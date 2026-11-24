---
name: ppt-exam-prep
description: >-
  Turn any folder of university course PDFs/slides into a structured multi-day
  final-exam cramming or preview study pack: extracts all slide outlines,
  generates per-page high/medium/low priority annotations (`study_annotations.json`),
  produces non-destructive offline annotated PDFs (`标注版PPT/`), and launches the
  interactive PPT study reader across Antigravity, Claude Desktop, Claude Code, and Codex.
---

# 大学生 PPT 期末速通 / 预习伴读工作流

当你帮一位学生用有限天数（例如 3 天考前冲刺、4 天新课预习、周末突击）吃透某门大学课程的一堆 PDF 课件时，按以下 5 步执行（支持 Antigravity、Claude Desktop、Claude Code、Codex）：

## Step 1: 盘点课程文件夹（只读扫描，绝不改动原件）

1. 确认学生的**课程 PDF 所在目录**（`<COURSE_DIR>`）、**可用天数（N 天）**和**学习目标**（`期末闭卷冲刺` vs `零基础预习打底`）。
2. 运行提取脚本，把所有 PDF 的总页数、每页前几行标题和正文摘要导出来：

```bash
python3 "<REPO>/scripts/extract_index.py" \
  --course-dir "<COURSE_DIR>" \
  --out "<TMP>/slides_dump.json"
```

- `<TMP>`：系统临时目录，或当前会话的 scratchpad 目录（Windows 没有 `/tmp`）。Windows 上没有 `python3` 时用 `python`。
- `<REPO>`：本工具的安装目录，按客户端定位：
  - Claude Code 插件：本 Skill 所在目录往上两级（`skills/ppt-exam-prep/../..`）；
  - 本地克隆（如 `~/ppt-study-reader`）：Claude Code 的 setup 安装、Claude Desktop、Codex 都用它；
  - Antigravity：`~/.gemini/config/plugins/ppt-study-reader`。
- 脚本会自动寻找支持中文路径的 poppler（Windows 上优先用 scoop 安装的版本，也可以用 `PPT_POPPLER_BIN` 环境变量指定）。
- 若无法运行 shell，也可以直接调用 `open_ppt_reader({ courseDir })` + `get_slide_image` 浏览。

## Step 2: 通览目录、划分每天任务与重点标准

1. 读取 `<TMP>/slides_dump.json` 中各 PDF 的页数与每页标题，把整门课合理切分到 `Day 1` ~ `Day N`。
2. 结合学生的学习目标制定分级标准：
   - **期末冲刺模式**：
     - `high`（🟢 重点精读）：高频考点、计算公式、例题与课堂小练习、核心原理机制图、必背对比表
     - `medium`（🟡 速览了解）：辅助理解的背景示例、过渡推导
     - `low`（🔴 可跳过）：封面/目录/致谢、纯发展史、已声明不考的拓展阅读
   - **零基础预习模式**：
     - `high`（🟢 重点精读）：建立全局直觉的核心模型图、经典反直觉案例、主干概念
     - `medium`（🟡 速览了解）：代码/例题对照页（看懂骨架即可）
     - `low`（🔴 可跳过）：过细的底层位域/历史细节/冷门工具用法，先跳过防劝退

## Step 3: 生成逐页标注配置文件 `study_annotations.json`

把全套课件的每一页按如下结构写入 `<COURSE_DIR>/标注版PPT/study_annotations.json`（完整格式参考 `examples/study_annotations.example.json`）：

```json
{
  "courseDir": "<COURSE_DIR>",
  "annotatedDir": "<COURSE_DIR>/标注版PPT",
  "totalPages": 120,
  "summary": { "high": 50, "medium": 35, "low": 35 },
  "decks": [
    {
      "file": "01-课程导论.pdf",
      "title": "01 课程导论",
      "day": 1,
      "pageCount": 40,
      "summary": { "high": 15, "medium": 12, "low": 13 },
      "pages": [
        {
          "page": 1,
          "priority": "low",
          "tag": "封面",
          "title": "第1章 课程导论",
          "tip": "课程封面，直接跳过"
        }
      ]
    }
  ]
}
```

校验要求：
- 每个 PDF 的 `1..pageCount` 页必须连续完整，不能漏页；
- `priority` 只能是 `"high"`、`"medium"`、`"low"`；
- `tag` 控制在 2~8 个字，`tip` 控制在 10~38 个字以内的一句大白话提示。

## Step 4: 生成离线《标注版 PPT》（原件 0 修改）

运行一键叠印脚本，在 `<COURSE_DIR>/标注版PPT/` 下生成保留原矢量清晰度、自动避让正文文字的标注版 PDF：

```bash
node "<REPO>/scripts/annotate_all.mjs" \
  --course-dir "<COURSE_DIR>" \
  --annotations "<COURSE_DIR>/标注版PPT/study_annotations.json" \
  --out-dir "<COURSE_DIR>/标注版PPT"
```

抽样用 `pdftoppm` 渲染 1~2 页查看中文与角标避让效果。

## Step 5: 按当前客户端打开交互伴读

- **Antigravity / Claude Desktop（支持 MCP Apps UI）**：
  调用 `open_ppt_reader`：
  ```json
  {
    "courseDir": "<COURSE_DIR>",
    "annotationsPath": "<COURSE_DIR>/标注版PPT/study_annotations.json",
    "page": 1,
    "filter": "all"
  }
  ```
- **Claude Code**：
  调用 `start_web_reader`（传入相同的 `courseDir` 与 `annotationsPath`），把返回的 `http://127.0.0.1:<port>` 链接发给学生。
  然后立刻用 Bash 的 `run_in_background` 在后台运行返回的 `listenCommand`（提问监听器）：
  - 学生在浏览器点「提问」后它会退出，你会被自动唤醒：调用 `get_pending_ppt_question` 取回问题与选区截图后作答；
  - 每答完一题，用同一条命令重新在后台挂起；输出 `PPT_WAIT_TIMEOUT` 时静默重新挂起。
- **Codex CLI 等终端环境**：
  调用 `start_web_reader` 启动本地浏览器伴读视图并输出链接；用户在浏览器提问后，可粘贴文本或直接调用 `get_pending_ppt_question` 读取问题与选区截图。

向学生输出：
1. 按天划分的极简学习路线图 + 各讲 🟢/🟡/🔴 页数统计；
2. 离线《标注版 PPT》目录路径；
3. 提醒学生如何在当前客户端用**左键拖拽框选 / 原地长按整行 / 纯划词**向你提问。
