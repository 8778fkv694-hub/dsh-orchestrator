# 验证记录

2026-10-30。开发预览；追加的真实界面反例验收已完成，证据边界见下。

| 层级 | 已实际运行的内容 | 结果/边界 |
|---|---|---|
| 核心/适配隔离 | Node内置测试：定义、确认依据、快照、产物、会话隔离、门、取消、恢复、存储失败、锁、路径、驱动和卸载 | **29/29**（首版28项 + 取消修复新增1项）；[修复后日志](../../evidence/2026-10-30-cancellation-fix/node-tests.tap)，修复前日志见[首版](../../evidence/2026-10-30-development/node-tests.tap)；含真实子进程SIGKILL恢复；提问回答为夹具，不是真人 |
| 无模型示例 | npm run demo | 本地固定脚本计算42，独立文件核验，模型调用0 |
| 真实安装运行时 | scripts/verify-harness-runtime.cjs | Harness tools 0.2.1-rc.3；10工具注册，6次真实工具调用，产物/人工门流程及卸载；Agent和回答为夹具，模型调用0 |
| 独立安装包/profile | npm pack + 临时DSH_HOME内plugin add、dump-config、remove | 真实安装/合成配置/卸载通过；未启动界面、未修改现有profile |
| 本地看板（INTENT-002） | `orch view`：只读运行视图、SSE 实时状态、`next/pause/resume/cancel` 调度、令牌/Origin/Host/只读/转义/损坏快照跳过/符号链接目录拒绝/已登记管线/记录视图/输出物只读服务 | 专项17/17、全量49/49；真实浏览器点击「启动」由ready→waiting-action并显示工作单；真实验收工作区6个运行只读展示，见[证据](../../evidence/2026-10-30-viewer/README.md)；v4 重设计证据见[看板 v4 证据](../../evidence/2026-10-30-dashboard-v4/README.md)；开箱即用/规模化证据见[看板 v5 证据](../../evidence/2026-10-30-dashboard-v5/README.md)；未做局域网/多用户 |
| 真实模型/界面端到端 | 混合管线、重启恢复、脚本节点 | [混合](../../evidence/2026-10-30-harness-e2e/mixed-happy-path.json)、[恢复](../../evidence/2026-10-30-harness-e2e/recovery.json)、[脚本](../../evidence/2026-10-30-harness-e2e/script.json)（均运行于 `66d252f`）；拒绝/取消等反例见下一行 |
| 真实模型/界面反例（追加） | 确认卡reject、skip（无答案）、缺交付、在途取消、对账stopped、对账verified修复回归、人工门reject | 1个会话18/20步、守卫0拒绝；[执行记录](../../evidence/2026-10-30-harness-adverse/README.md)与[汇总](../../evidence/2026-10-30-harness-adverse/ui-adverse.json)，运行于修复提交 `67e0f7c`；8张卡由获授权的验收操作者代点 |
| 已安装Harness运行时反例 | 拒绝意图、无答案、缺文件、取消待确认、恢复拒绝推进、卸载 | [收据](../../evidence/2026-10-30-harness-e2e/runtime-adverse.json)；使用合成Agent及回答，不是UI真人测试 |

运行时探针使用真实Cordis、SystemPrompt、ToolRuntime、AgentRegistry和UserQuestionService，但合成Agent、文件和回答，因此只属已安装运行时夹具层，不计入真实模型/界面端到端。核心测试的“确认”均为明确夹具，不表示机主对演示项目的确认。

## 最终验收待办

- [x] 在隔离真实Harness界面加载打包插件，确认版本、模型、端口和工作目录。
- [x] 由真实Agent复述新的测试Intent，由机主本人确认；拒绝/无回答仍需真人场景实测。
- [x] 创建并运行纯脚本管线；独立核验本次产物及零模型脚本执行路径。
- [x] 真实Agent与真人门混合流程，核验状态展示、产物和交付。
- [x] 中断后重启读回相同操作ID；未知效果不重放，真人对账后接续。
- [x] 取消、门拒绝、未获确认、交付缺项和插件卸载边界有实际证据。取消/对账/交付缺项/门拒绝/未获确认为真实界面证据（[执行记录](../../evidence/2026-10-30-harness-adverse/README.md)）；插件卸载边界为运行时卸载夹具 + 宿主停止后的隔离 profile 移除，**未覆盖活跃 GUI 内热卸载**。
- [x] 留宿主/插件身份、运行ID、原始输入、步骤、状态、产物哈希及失败未验项（见[汇总](../../evidence/2026-10-30-harness-adverse/ui-adverse.json)的 session / runs / notCovered 节）。
- [x] 本地看板（INTENT-002）：只读视图 + SSE 实时状态 + 调度入口测试与真实浏览器点击证据；证据见[看板证据](../../evidence/2026-10-30-viewer/README.md)。

## 可重复命令

npm test；npm run demo；npm pack；`node src/viewer.js <工作区>`（或 `node --test test/viewer.test.js` 单独跑看板测试）。运行时探针需使用目标宿主的Node环境及其app.asar/dsh/package.json，示例命令以实际安装路径替换，不读取或复制生产凭据。探针输出明确标humanE2E=NOT_RUN。

## 确认来源的限制

混合场景的意图与人工门由机主本人通过界面确认。恢复场景的对账卡和脚本场景的意图卡由Codex依据机主在本次验收明确给出的授权代点。Harness记录的 `harness.userQuestions` 只能证明答复经过提问通道，不能证明实际点击者是机主本人；恢复时模型将代点误称机主本人点击，本记录予以纠正。对需要严格区分本人确认与受托代操作的项目，应另建立可验证的身份与审计机制。

本轮授权最多3个测试任务、每项最多20步；三条测试的实际步数分别13、9、10。追加轮次经机主批准1个独立会话、最多20步，实际1会话18步（守卫0拒绝）。两轮中的全部关键确认卡（含本轮的拒绝、跳过/无答案、对账stopped、对账verified、人工门reject共8张）均由获机主明确授权的验收操作者代点；不得将其表述为机主本人点击，也不得将已安装运行时的夹具反例混为真人UI端到端。

剩余界面反例的具体方案见[补充验收卡与执行记录](GUI_ADVERSE_CARD.md)；追加反例已执行，不再有待授权的模型任务。

清理：首轮验收宿主已停止，仅从临时验收profile移除测试插件；回读确认三份运行记录仍在。追加轮次结束后同样停止隔离宿主、从隔离profile移除测试插件，回读确认六份运行记录与 `late.txt` 保留。原有用户profile未改（`~/.dsh/profiles/desktop` 配置文件修改时间早于本次验收）。此为宿主停止后的profile移除，不能代称活跃GUI内卸载验证。

## 取消后对账修复

复核发现：取消请求后，若原动作实际已完成并被对账为verified，旧代码误将状态设为ready，可能继续推进已取消的管线。定向反例先在旧实现失败；修复后保留产物收据但状态为cancelled。新版本[29项测试](../../evidence/2026-10-30-cancellation-fix/node-tests.tap)通过，实际安装的Harness运行时[15次工具调用夹具](../../evidence/2026-10-30-cancellation-fix/runtime.json)覆盖该反例。修复后已在 `67e0f7c` 通过真实界面反例（C场景：取消后在途动作完成、对账verified，仍保持 cancelled 且不可推进），见[执行记录](../../evidence/2026-10-30-harness-adverse/README.md)。三条主要真实界面场景运行于 `66d252f`，未在该修复提交后重跑；修复只涉及这一分支。
