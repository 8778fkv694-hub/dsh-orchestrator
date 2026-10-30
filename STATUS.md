# DSH Orchestrator 当前状态

2026-10-30 晚（Codex 交接后收尾）。开发候选 0.1.0-alpha.1；INTENT-001 v1 accepted，SPEC-001 v1 为实施设计基线。

已完成：独立核心、10 个 Harness 工具、真实人类提问服务适配、可信无模型脚本驱动、CLI、起飞资料引用、双语说明、可安装 bundle，以及 `npm pack` / 隔离 profile 安装·合成·移除回执。核心支持线性 task/gate/check；无 DAG 和外部业务 oracle 声明。

已验证：

- 核心/适配：Node 测试 **29/29**（首版 28 项 + 取消修复新增 1 项；[修复后日志](docs/evidence/2026-10-30-cancellation-fix/node-tests.tap)）；含真实子进程 SIGKILL 恢复；提问回答为夹具，不是真人。
- 无模型示例：`npm run demo` 固定脚本计算 42、独立文件核验、模型调用 0。
- 真实安装运行时：Harness tools 0.2.1-rc.3 的工具注册/调用/卸载（Agent 与回答为夹具，模型调用 0）。
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
- npm 包名 `dsh-orchestrator` 已被他人占用，本仓不发布 npm；分发形态为公开源码 + 本地 `npm pack`；tag / GitHub Release 由机主决定。

结论：追加反例验收已完成，**整体目标按上述已声明范围达成**，不再有待授权的模型任务。原有用户 profile、数字员工源码和生产数据均未改动。

依据：[Intent](docs/sdlc/plan/intent.md)、[Spec](docs/sdlc/design/spec.md)、[Plan](docs/sdlc/build/plan.md)、[验证](docs/sdlc/test/verification.md)、[交付](docs/sdlc/deploy/delivery.md)、[反例验收结果](docs/sdlc/test/GUI_ADVERSE_CARD.md)。
