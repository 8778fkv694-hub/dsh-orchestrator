# 2026-10-30 · 本地管线看板证据（INTENT-002 / SPEC-001 v2）

本目录记录只读看板 + 实时状态 + 调度入口（`orch view`）的实现证据。

- 依据：[INTENT-002](../../sdlc/plan/intent-002-viewer.md)（机主确认范围 A）、[SPEC-001 v2](../../sdlc/design/spec.md) S11–S16。
- 本轮不调用模型、不改 Harness 配置、不执行任何任务动作；演示工作区为合成数据，验收工作区截图只用只读模式。

## 结果

- 看板专项测试 **14/14**（[TAP](node-tests-viewer.tap)）：令牌/转义/只读/SSE/调度状态机/安全头/CLI。
- 全量测试 **43/43**（29 项原有 + 14 项看板）。
- 真实浏览器点击「启动」：`看板演示：等待启动` 从 `ready` → `waiting-action`，页面显示 `action-issued` 与工作单 `76202929-2229-4eac-8d94-40e5301b9e8a`（[UI 截图](ui/03-after-start.jpg) · [状态快照](after-start-state.json)）。
- 真实验收工作区（6 个运行，含取消/人工门/交付已核验）只读展示，未点击任何动作（[截图](ui/04-acceptance-real-runs.jpg)）。

## 文件

- `ui/01-dashboard-demo.jpg`：看板总览（运行列表、状态、实时指示、调度入口已启用）。
- `ui/02-detail-ready.jpg`：准备就绪运行详情（启动/暂停/取消按钮）。
- `ui/03-after-start.jpg`：点击「启动」后：`等待执行结果`、事件 `action-issued`、右上 toast 显示工作单号。
- `ui/04-acceptance-real-runs.jpg`：只读模式查看 2026-10-30 真实验收工作区的 6 个运行（未操作）。
- `after-start-state.json`：点击启动后的 `/api/runs` 快照（路径已脱敏）。
- `demo-page-text.txt` / `demo-after-start-page-text.txt` / `acceptance-page-text.txt`：页面文本证据。
- `node-tests-viewer.tap`：看板测试 TAP（14 项：令牌/转义/只读/SSE/调度/损坏快照跳过/符号链接目录拒绝/遗留锁/直接入口回归）。
- `viewer-demo-process.log`：启动输出（URL 与模式）。
- `capture.mjs`：截图/点击操作脚本（Chrome DevTools Protocol；不含凭据）。
- `MANIFEST.sha256`：本目录除自身外全部文件哈希。

## 复现

```sh
# 1) 测试（不启动界面）
node --test test/viewer.test.js

# 2) 起看板（只读 + 调度）
node src/viewer.js /绝对路径/工作区 --port 8899

# 3) 浏览器打开输出的 URL；「启动」= 只发下一步工作单；确认/门/对账仍在 Harness 会话
```

## 边界（不得外推）

1. 看板是**本地可信操作面**（与本机文件权限同一信任级），不是安全边界；动作沿用运行自身 owner 写入，不生成人工确认记录。
2. 按钮只做 `next/pause/resume/cancel`，**不执行任务动作、不调模型、不启外部命令**；`next` 后的执行仍由 Harness 会话/CLI 承担，未接执行器时运行会停在 `waiting-action`（设计如此）。
3. 页面以 `--read-only` 关闭动作端点；只绑定本机回环地址（默认 `127.0.0.1`，`--host` 仅接受 127.0.0.1/::1/localhost）。访问令牌每进程生成（也可用 `--token` 显式指定，≥16 字符），进程存活期间有效并出现在启动输出 URL 中，请勿分享或截图外传。POST 需令牌头 + Origin/Host 校验；未做局域网/多用户/账号权限。
4. 实时性依赖文件监听 + 1 秒内轮询兜底；网络被阻断时退化为轮询。
5. 遗留锁不会自动删除，需按 README 的锁处理流程人工确认后处理；损坏/符号链接的 `.orchestrator` 内容会被跳过并提示。
6. 截图中的路径为临时目录（已脱敏为 `<demo-workspace>` / `<acceptance-workspace>` 或 `/tmp/...`）；不含机主用户名、凭据或生产数据。
