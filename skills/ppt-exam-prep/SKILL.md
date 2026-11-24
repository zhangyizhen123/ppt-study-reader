---
name: ppt-exam-prep
description: >-
  Turn any folder of university course PDFs/slides into a structured multi-day
  final-exam cramming or preview study pack: extracts all slide outlines,
  generates per-page high/medium/low priority annotations (`study_annotations.json`),
  produces non-destructive offline annotated PDFs (`标注版PPT/`), and opens the
  interactive Antigravity side-pane reader (`open_ppt_reader`). Use when a student
  asks to study, preview, or cram for exams from course PDFs/PPTs.
---

# 大学生 PPT 期末速通 / 预习伴读工作流

当你帮一位学生用有限天数（例如 3 天考前冲刺、4 天新课预习、周末突击）吃透某门大学课程的一堆 PDF 课件时，按以下 5 步执行：

## Step 1: 盘点课程文件夹（只读扫描，绝不改动原件）

1. 确认学生的**课程 PDF 所在目录**（`<COURSE_DIR>`）、**可用天数（N 天）**和**学习目标**（`期末闭卷冲刺` vs `零基础预习打底`）。
2. 运行本插件提供的提取脚本，把所有 PDF 的总页数、每页前几行标题和正文摘要导出来：

```bash
python3 "${PLUGIN_ROOT}/scripts/extract_index.py" \
  --course-dir "<COURSE_DIR>" \
  --out "/tmp/slides_dump.json"
```

（若未设置 `${PLUGIN_ROOT}`，请到 `~/.gemini/config/plugins/ppt-study-reader/scripts/extract_index.py` 调用。）

## Step 2: 通览目录、划分每天任务与重点标准

1. 读取 `/tmp/slides_dump.json` 中各 PDF 的页数与每页标题，把整门课合理切分到 `Day 1` ~ `Day N`。
2. 结合学生的学习目标制定分级标准：
   - **期末冲刺模式**：
     - `high`（🟢 重点精读）：高频考点、计算公式、例题与课堂小练习、核心原理机制图、必背对比表
     - `medium`（🟡 速览了解）：辅助理解的背景示例、过渡推导
     - `low`（🔴 可跳过）：封面/目录/致谢、纯发展史、已声明不考的拓展阅读
   - **零基础预习模式**：
     - `high`（🟢 重点精读）：建立全局直觉的核心模型图、经典反直觉案例、主干概念
     - `medium`（🟡 速览了解）：代码/例题对照页（看懂骨架即可）
     - `low`（🔴 预习可跳过）：过细的底层位域/历史细节/冷门工具用法，先跳过防劝退

## Step 3: 生成逐页标注配置文件 `study_annotations.json`

把全套课件的每一页按如下结构写入 `<COURSE_DIR>/标注版PPT/study_annotations.json`（完整格式参考本插件 `examples/study_annotations.example.json`）：

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
node "${PLUGIN_ROOT}/scripts/annotate_all.mjs" \
  --course-dir "<COURSE_DIR>" \
  --annotations "<COURSE_DIR>/标注版PPT/study_annotations.json" \
  --out-dir "<COURSE_DIR>/标注版PPT"
```

抽样用 `pdftoppm` 渲染 1~2 页并用 `read_file` 检查中文与角标避让效果。

## Step 5: 打开侧边栏「PPT 伴读」开始互动学习

调用 MCP 工具 `open_ppt_reader`：

```json
{
  "courseDir": "<COURSE_DIR>",
  "annotationsPath": "<COURSE_DIR>/标注版PPT/study_annotations.json",
  "page": 1,
  "filter": "all"
}
```

向学生输出：
1. 按天划分的极简学习路线图 + 各讲 🟢/🟡/🔴 页数统计；
2. 离线《标注版 PPT》目录链接；
3. 提示学生直接在右侧「PPT 伴读」侧边栏用**左键拖拽框选（文字+图表通吃）/ 原地长按选整行 / 纯划词**向你提问，也可以切换“只看🟢重点”快速过考点。
