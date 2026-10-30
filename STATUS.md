# DSH Orchestrator 当前状态

2026-10-30 **INTENT-008 运行状态动效**：已按机主确认实现运行卡片动态条、详情状态带、当前步骤转动环；暂停停止动效、继续恢复，等待人工与终态保持静态明确标志。全量 **55/55**；真实 Harness 内启动/暂停/继续实测，运行两帧目视确认动态变化，operation 不变。动效演示已留在当前侧栏供机主体验，使用独立合成工作区，不执行真实任务。见[意图](docs/sdlc/plan/intent-008-run-motion.md)、[证据](docs/evidence/2026-10-30-run-motion/README.md)。减少动态效果已覆盖元素/伪元素，但未切换系统设置实测。历史服务进程需重启后加载新源码；本轮已使用新进程展示，未改现用 Harness profile，业务验收边界不变。

2026-10-30 追加落地复核（INTENT-007，机主确认）：当前源码完整回归 **54/54**，装机 Harness tools **0.2.1-rc.5** 正向/反例探针通过（合成 Agent/答复、0 模型调用）；真实 Harness 侧栏验证启动/暂停/继续/取消及输出物刷新/关闭。修复四项：原生确认框无反馈、刷新按钮变量遮蔽、探针对结构化展示不兼容（含拒绝回执缺 JSON）、自动跟随重开已关闭预览。见[复核计划与闭环](docs/sdlc/test/implementation-audit-2026-10-30.md)、[证据](docs/evidence/2026-10-30-implementation-audit/README.md)。

2026-10-30 追加（INTENT-009 执行体验闭环）：源码完整回归 **64/64**；新增 `orch_claim`、只读 `orch doctor`、`orch instantiate` 模板与运行隔离、看板接手/卡点详情；装机夹具探针 11 工具/7 调用（合成 Agent/答复、0 模型调用）；新闻采集收尾行在 UTF-8 locale 下的未绑定变量缺陷已修复，以 24 例离线回归（0 网络/0 真实新闻运行）和真实新闻复测验证；news-briefing 一次真实端到端运行 `ee8e7255-…` 最终 **done**，`output/report.md|html|delivery.json` 与回执哈希一致、`--verify` 通过。**边界：**新工具与修复尚未安装到现用 Harness profile；源码提交 `088b718` 已推送公开仓库 `main`（未发布 npm 包——名称被占用；未创建 tag/Release）；可安装包由 `npm pack` 两次生成、字节可复现（sha256 `a7e8c4d60f43e668…`，129 文件），packaged CLI `doctor` 通过；自动派发与深链仍未验；新闻事实准确性未逐条核查。

**落地边界：新闻项目为 1 管线；2026-10-30 完成 1 次真实端到端运行并交付 3 个输出物（WP7 本轮业务验收通过，新闻事实未逐条核查）；WP10 的 200/50/200 规模验收仍未完成。** 本轮源码已修复并验证，但不代表已重装现用插件；未发布、未改现用 profile。下文“整体目标达成”仅指此前声明的 alpha 验收范围。

2026-10-30 晚（Codex 交接后收尾）。开发候选 0.1.0-alpha.1；INTENT-001 v1 accepted，SPEC-001 v1 为实施设计基线。

已完成：独立核心、10 个 Harness 工具、真实人类提问服务适配、可信无模型脚本驱动、CLI、起飞资料引用、双语说明、可安装 bundle、`npm pack` / 隔离 profile 安装·合成·移除回执，以及本地管线看板 `orch view`（只读视图 + SSE 实时状态 + next/pause/resume/cancel 调度入口；INTENT-002 / SPEC-001 v2）。核心支持线性 task/gate/check；无 DAG 和外部业务 oracle 声明。

已验证：

- 核心/适配与看板：`npm test` **49/49**（核心/插件/驱动 32 项 + 看板 17 项；核心[修复后日志](docs/evidence/2026-10-30-cancellation-fix/node-tests.tap)）；含真实子进程 SIGKILL 恢复；提问回答为夹具，不是真人。
- 无模型示例：`npm run demo` 固定脚本计算 42、独立文件核验、模型调用 0。
- 真实安装运行时：Harness tools 0.2.1-rc.3 的工具注册/调用/卸载（Agent 与回答为夹具，模型调用 0）。
- 本地看板（INTENT-002）：看板专项测试 17/17、全量 49/49；真实浏览器点击「启动」由 `ready` → `waiting-action` 并显示工作单号；6 个真实验收运行在只读模式正常展示；令牌/Origin/Host/CSP/只读/转义/SSE/损坏快照跳过/符号链接目录拒绝/遗留锁错误均有测试；看板 v5 提供三视图（看板/运行记录/输出物）、自动跟随与输出物内嵌预览、分类/排序/置顶/加载更多、只读记录管理与 `output/` 输出物打开；`npm run quickstart` 零配置演示；随仓库带 DSH skill；插件 gate 支持多选项提问卡（经 DSH 提问卡由人选择）。证据：[看板证据](docs/evidence/2026-10-30-viewer/README.md)。
- 打包与隔离 profile：验收所用包由 `npm pack` 从提交 `67e0f7c` 生成、对该提交字节可复现（sha256 `735236398884813a…`；此后提交只改文档/证据，`src/` 与 `package.json` 未改，故当前 HEAD 的包哈希因文档更新而不同）；临时 `DSH_HOME` 内 add / 配置合成 / remove 回执见[追加验收证据](docs/evidence/2026-10-30-harness-adverse/pack-install-receipt.json)。
- 真实模型 + 真实界面（隔离 profile，真实提问卡）：
  - 三条主要场景（混合管线、重启后恢复、脚本节点）于 `66d252f` 验证；
  - 追加**反例套件**于修复提交 `67e0f7c` 验证通过：确认卡 reject / skip（无答案）不建运行、缺交付 `complete` 失败、在途取消保持 `cancel-requested`、对账 `stopped` 后 `cancelled` 且不重发、对账 `verified` 后仍保持 `cancelled`（修复回归）、人工门 reject 取消；1 个会话 **18/20 步**，耗时 6 分 3 秒。证据：[反例执行记录](docs/evidence/2026-10-30-harness-adverse/README.md)。
- 修复提交 `67e0f7c` 的唯一改动分支（`cancel-requested + verified`）已由上述 C 场景在真实界面覆盖；三条主要场景未在该提交后重跑（见边界）。

边界（不得外推）：

- 反例套件 8/8 张卡由**获机主明确授权的验收操作者（DeepSeek Harness agent）代点**，不是机主本人；Harness 的 `harness.userQuestions` 只能证明答复经过提问通道，不能证明点击者身份。
- 活跃 GUI 内插件热卸载未测；卸载边界证据为已安装运行时的卸载夹具 + 宿主停止后的隔离 profile 移除。
- 隔离会话使用 Full access 权限档位（与上一轮机主切换后的真实验收一致），不是默认 workspace-write 档位。
- 第 1 步首次模型请求出现 300 秒流空闲超时，宿主 `llm-retry` 自动重试 1 次后同一步完成；仍属同一会话、同一授权任务。
- 看板是本地可信操作面（与本机文件权限同一信任级），不是安全边界，不替代 Harness 人工确认；未做局域网访问、多用户与账号权限。
- npm 包名 `dsh-orchestrator` 已被他人占用，本仓不发布 npm；分发形态为公开源码 + 本地 `npm pack`；tag / GitHub Release 由机主决定。

结论：追加反例验收已完成，**整体目标按上述已声明范围达成**，不再有待授权的模型任务。原有用户 profile、数字员工源码和生产数据均未改动。

依据：[Intent](docs/sdlc/plan/intent.md)、[Intent-002 看板](docs/sdlc/plan/intent-002-viewer.md)、[Spec](docs/sdlc/design/spec.md)、[Plan](docs/sdlc/build/plan.md)、[验证](docs/sdlc/test/verification.md)、[交付](docs/sdlc/deploy/delivery.md)、[反例验收结果](docs/sdlc/test/GUI_ADVERSE_CARD.md)。
