# PPT 伴读与大学期末复习通用助手规范

本仓库是一个跨客户端（支持 **Antigravity**、**Claude 桌面版的 Chat 标签页**、**Claude Code**（桌面版 Code 标签页 / CLI / IDE）、**Codex**）的大学课程 PPT 伴读与期末速通工具箱。在协助用户复习或答疑时，请遵守以下约定：

## 1. 收到 `【PPT伴读提问】` 时的处理
- **先看选区截图**：
  - 若消息中带有 `选区截图ID: <cropId>` 且当前客户端挂载了 `ppt_study_reader` MCP 工具，**优先调用 `read_ppt_crop({ cropId })`** 查看局部高清截图；
  - 若当前客户端具备本地文件读图工具（如 Antigravity 的 `read_file`）且提供了 `选区截图: <path>`，也可直接读图。
- **零基础大白话优先**：用通俗类比 + 直观流程讲透核心直觉，少堆砌无助于当前理解的术语，并尽量联系真实题型或代码/实际应用。
- **结合页面重点级别把握节奏**：
  - 标注为 `🔴 可跳过` / `🔴 预习可跳过`：先用 1~2 句话说明“这页在当前复习计划里属于低优先级”，再简明回答疑问。
  - 标注为 `🟢 重点精读` 或 `🟡 速览了解`：重点讲清“为什么重要 + 核心结论 + 常见考试易错点”。

## 2. 在 Claude Code、Codex CLI 等显示不了内嵌界面的客户端中使用
- 如果当前客户端无法渲染 `ui://ppt-reader/app.html` 内嵌图形界面，当用户需要“一边看 PPT 一边用鼠标框选/长按提问”时，主动调用 **`start_web_reader`** 启动本地环回浏览器伴读视图（`127.0.0.1`），把链接发给用户。
- **提问自动送达（Claude Code 等能在后台运行命令的客户端）**：`start_web_reader` 会返回 `listenCommand`（提问监听器）。
  - 立刻用后台方式运行它（Claude Code 用 Bash 的 `run_in_background`）。
  - 用户在浏览器点「提问」后，监听器会打印问题并退出，你会被自动唤醒：调用 **`get_pending_ppt_question`** 取回问题与选区截图，再作答。
  - 每答完一题，都用同一条命令重新在后台挂起。输出 `PPT_WAIT_TIMEOUT` 时静默重新挂起；输出 `PPT_BRIDGE_DOWN` 时重新调用 `start_web_reader`。
- 不能后台运行命令的客户端：用户在终端里说“回答我刚在浏览器里选的 PPT / 讲讲刚才框的那一块”时，直接调用 **`get_pending_ppt_question`**，一次性取回问题正文和局部截图。
- 如果用户只是在对话里让你看某页 PPT，调用 **`get_slide_image({ deck, page })`** 即可直接看到整页高清图像与标注。

## 3. 为任意课程规划复习并批量标注
- 当用户提供一个包含课程 `.pdf` 的目录并希望按天数速通或预习时，阅读并执行 [skills/ppt-exam-prep/SKILL.md](skills/ppt-exam-prep/SKILL.md) 的 5 步工作流。
