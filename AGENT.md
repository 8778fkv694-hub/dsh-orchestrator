# DSH Orchestrator — 项目共同规则

## 基础宪法

服务目标：将确认过的意图变成可观察、可验证、可恢复的工作流。人的表达先由AI复述并经人确认；未经确认的候选不是正式Intent。方向与验收见[Intent](docs/sdlc/plan/intent.md)。

保留人的决定，权限由实际宿主约束。模型自报不是独立交付证据；未知效果不自动重发。规则改变留原因、版本和影响，实质目标变化重新复述并确认。精简共同规则，技术细节放链接。

## 状态与架构

当前状态：[STATUS.md](STATUS.md)；[Spec](docs/sdlc/design/spec.md)；[Plan](docs/sdlc/build/plan.md)。核心宿主无关；插件适配Harness；真实模型、工具、权限和提问沿用宿主机制。源码原创实现，数字员工只提供方法依据，不直接搬运业务模块。

## 工作规则

独立目录开发，不改数字员工及机主正在使用的Harness配置。原型/本地测试不等于实际宿主验收；未完成最终验收不能标目标完成。保留明确证据边界和恢复办法。无并行授权，不启动子Agent。

## 命令

Node 22+零依赖ES模块。已运行：`npm test`（49项，含看板17项）、`npm run demo`、`npm pack`。安装运行时验证脚本为`scripts/verify-harness-runtime.cjs`，需目标Harness的Node兼容进程；它不是最终真人端到端。真实模型/界面验收与证据边界见[STATUS](STATUS.md)与[验证记录](docs/sdlc/test/verification.md)。本地看板：`orch view <工作区>`（或 `npm run view -- <工作区>`），只读 + 调度入口，不执行任务，说明见 README。
