# 2026-10-30 · 真实界面反例验收（真实模型）

本目录是 Codex 交接后完成后半段的执行记录：在**隔离的 DeepSeek Harness**（真实模型、真实界面、真实提问卡）上跑完原授权之外追加的**一次**模型任务，覆盖拒绝、无答案、缺交付、在途取消、取消后对账 verified（修复回归）和人工门拒绝。

- 宿主：DeepSeek Harness `0.2.1-rc.3`，隔离 profile `orch-acceptance`（独立 `DSH_HOME` 与临时工作区，未触碰机主在用 profile）。
- 插件：`dsh-orchestrator 0.1.0-alpha.1`，源码提交 `67e0f7c`（含取消后对账修复），打包 sha256 `735236398884813a234ede12637ccef83f6b276f9c27a9a7017782965b23e2e5`。
- 模型：`opencode-go` / `deepseek-v4.1-flash`，reasoning `max`；会话权限档位 `danger-full-access`（操作者经真实界面设置，与上一轮机主切换后的真实验收一致）。
- 预算：机主追加批准 **1 个独立会话、最多 20 个模型步骤**；实际 **18 步**，预算守卫 0 次拒绝，会话 6 分 3 秒完成。
- 点击者：8/8 张卡由**获机主明确授权的验收操作者**（本会话 Lead，DeepSeek Harness agent，经 Chrome DevTools Protocol 点击真实界面按钮）代点，不是机主本人。

## 结果

| # | 检查 | 预期 | 实测 | 结果 |
|---|---|---|---|---|
| A1 | 候选意图确认卡 reject | 返回 `accepted:false`，不创建运行 | `{"accepted":false,"reason":"human rejected candidate"}`；候选定义无任何运行记录 | 通过 |
| A2 | 同一候选卡 skip（无答案） | 工具失败、状态不变、不创建运行 | `Error: No unambiguous human decision; state unchanged` | 通过 |
| B1 | 缺交付提交 | `orch_complete` 失败，运行仍等待执行 | `ENOENT ... missing.txt`；状态保持 `waiting-action` | 通过 |
| B2 | 在途取消 | 只进入 `cancel-requested`，不得声称已停止 | `cancel-requested`，事件 `unknown: external action may still be running` | 通过 |
| B3 | 对账卡选 `stopped` | `cancelled`；不重发；不可再推进 | `cancelled`；`action-issued` 恰 1 次；`orch_next` 报 `cannot advance from cancelled` | 通过 |
| C | 取消后动作实际完成、对账 verified | 记录收据但状态仍 `cancelled`、不可推进（`67e0f7c` 修复） | 收据 `recovered:true`、`late.txt` sha256 `b35b11e4…`；状态仍 `cancelled`；`orch_next` 被拒 | 通过 |
| D | 人工门选 reject | 运行取消 | `cancelled`；事件 `human-decision reject` | 通过 |
| E | 预算 | 1 会话 ≤20 步 | 18 步、0 拒绝 | 通过 |

## 文件

- `ui-adverse.json`：逐项检查、卡片点击记录、运行终态、边界与来源的机器可读汇总。
- `session-evidence.jsonl`：会话事件脱敏副本（保留步骤/工具调用/工具回执/时序；路径替换为 `<home>`、`<dsh-app>`、`<isolated-root>`）。
- `cards-driver.jsonl`：卡片操作守则的实际执行记录（卡片标题片段、选项、点击动作、关闭确认、截图路径）。
- `budget-excerpt.jsonl`：本次会话的 18 条步数计数（无拒绝）。
- `task-prompt.txt`：发给隔离 Harness 的唯一任务提示词（脱敏路径）。
- `runs/`：三份运行快照（`.orchestrator/<runId>.json`），可直接核对状态、事件与收据。
- `pack-install-receipt.json`：`npm pack`（字节可复现）+ 临时 `DSH_HOME` 内 add/compose/remove 回执。
- `plugin-remove.log`：宿主停止后从隔离 profile 移除插件的输出。
- `ui/`：真实界面截图（卡片与最终报告）。
- `MANIFEST.sha256`：本目录除自身外所有文件哈希。

## 方法与边界

执行方式：用真实浏览器打开隔离 Harness 的 Web 界面，操作者的点击通过 Chrome DevTools Protocol 的鼠标事件落到真实 DOM 按钮上；翻转/等待期间用截图与 DOM 快照留证。会话日志中的 `harness.userQuestions` 记录答复来源，但不能证明点击者身份，故本记录如实标注为**受托代点**。

环境细节：隔离 profile 在宿主层只读引用机主 `~/.dsh/.credentials.yaml` 以调用现有模型线路（未复制凭据）；会话默认工作目录是一个既有的空目录（`~/Documents/deepseek-harness/default-workspace`），本套件的插件状态与产物全部写入隔离临时工作区（`<isolated-root>/workspace`）。

本轮**未覆盖**（不得外推）：

1. 三条主要场景的真实界面证据运行在 `66d252f`；修复提交 `67e0f7c` 后未重跑这三条。修复只改 `cancel-requested + verified` 分支，该分支已由本套件 C 场景在真实界面覆盖。
2. 活跃 GUI 内插件热卸载未测；卸载边界证据为已安装运行时的卸载夹具 + 宿主停止后的隔离 profile 移除。
3. 卡片点击者为受托操作者，不是机主本人；若验收要求本人点击，需机主再抽验。
4. 第 1 步首次模型请求出现 `pi-ai stream idle timeout after 300000ms`，宿主 `llm-retry` 自动重试 1 次（1/5）后同一步完成；仍属同一会话、同一授权任务，步数只计 1 次。

清理：验收后已停止隔离宿主，并从隔离 profile 移除测试插件；六份运行记录与 `late.txt` 保留。机主在用 profile 未改动（`~/.dsh/profiles/desktop` 的配置文件修改时间早于本次验收）。

## 复现要点

1. 在源码仓 `npm pack`，确认包 sha256 与上面一致。
2. 新建独立 `DSH_HOME` 与 profile，安装包、配置独立工作区/模型线路/提问服务；**不要覆盖在用 profile**。
3. 启动隔离 Web 界面，按 `task-prompt.txt` 的原样任务发一轮；操作者按 `cards-driver.jsonl` 记录的卡片顺序（reject → skip → confirm → stopped → confirm → verified → confirm → reject）代为选择。
4. 结束后读回 `.orchestrator/<runId>.json`、会话日志与步数记录，对照 `ui-adverse.json`。
