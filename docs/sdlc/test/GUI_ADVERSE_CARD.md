# 剩余真实界面反例：补充验收卡（已执行，见文末执行记录）

2026-10-30。原批准预算为3个真实模型测试任务，每项最多20步；已用3个，步数13/9/10。此卡是备好的具体方案；**2026-10-30 晚机主批准“追加一次，继续验收”，已执行并通过，执行记录见文末。**

## 追加预算及边界

追加1个独立会话、最多20个模型步骤；不使用子Agent，不读取隔离项目之外的文件、不复制凭据、不访问生产业务数据。隔离宿主已退出、profile中的插件已移除；获授权后重装本地测试包并重启同一独立profile，沿用现有模型线路，步骤限制由验收用guard执行并持久计数。测试操作仅在隔离临时目录，完成后退出隔离宿主，保留脱敏证据。

## 同一任务中的真实界面反例

1. 尝试创建候选管线，确认卡选择`reject`；核对未创建运行。
2. 同一候选再次提交，确认卡选择`跳过`或放弃；核对未创建运行。不得将无答案视为确认。
3. 再创建明确的隔离管线并确认，调用next产生工作单，但不启动任何外部动作、不创建产物。调用complete，预期因缺少交付文件失败；核对仍未完成。
4. 取消该在途工作单，预期`cancel-requested`，不能声称外部工作已停止。由于本场景明确没有启动外部动作，由获机主授权的验收操作者在对账卡选择`stopped`，验证状态变`cancelled`且没有重发。
5. 保留运行ID、操作ID、各卡片选择的实际操作者、宿主工具回执、独立状态/文件检查与每步计数。执行后只对隔离profile检查插件移除/注销；不影响机主在用profile。

通过条件：以上每个预期均有独立证据且与界面一致；任何异常即停止，不换题凑通过。结果需明确卡片由本人还是获授权的Codex点击；服务的`harness.userQuestions`标识无法证明具体点击者。

修复后还须覆盖：已取消请求的动作若实际完成且经对账verified，记录收据但状态仍为cancelled，不可继续推进。根据剩余预算优先安排可区分这条行为的用例。

## 执行记录（2026-10-30 晚，Codex 交接后完成）

状态：**已执行并通过**。追加预算 1 个独立会话、最多 20 个模型步骤；实际 **1 会话、18 步**（预算守卫 0 次拒绝），耗时 6 分 3 秒；运行于修复提交 `67e0f7c`、插件包 0.1.0-alpha.1（sha256 `735236398884813a…`），宿主 Harness `0.2.1-rc.3`、模型 `opencode-go/deepseek-v4.1-flash`（reasoning max），隔离会话权限档位 Full access（操作者经真实界面设置）。

| 原卡项 | 实际操作 | 实测结果 | 判定 |
|---|---|---|---|
| 1 候选拒绝 | 确认卡选 `reject` | `{"accepted":false,"reason":"human rejected candidate"}`；无任何运行记录 | 通过 |
| 2 同一候选跳过/无答案 | 确认卡选 `skip`（不选选项直接跳过） | 工具失败：`No unambiguous human decision; state unchanged`；无运行记录 | 通过 |
| 3 缺交付提交 | 创建并确认管线 → `next` → `complete` | `ENOENT ... missing.txt`；运行保持 `waiting-action` | 通过 |
| 4 在途取消 + 对账 stopped | `cancel` → 对账卡选 `stopped` | 先 `cancel-requested`（`unknown: external action may still be running`），对账后 `cancelled`；`action-issued` 恰 1 次（未重发）；`next` 报 `cannot advance from cancelled` | 通过 |
| 修复回归 | 在途取消后写入 `late.txt`、对账卡选 `verified` | 收据 `recovered:true`（`late.txt` sha256 `b35b11e4…`），状态仍为 `cancelled`（不是 `ready`），`next` 被拒 | 通过 |
| 附加：门拒绝（补齐待办） | 只含 gate 的管线 → `next` → `orch_gate` 卡选 `reject` | 事件 `human-decision reject`；状态 `cancelled` | 通过 |

卡片点击者：8/8 张卡均由**获机主明确授权的验收操作者（本会话 Lead，DeepSeek Harness agent）经真实界面代点**，不是机主本人；`harness.userQuestions` 只能证明答复经过提问通道。第 1 步首次模型请求出现 `pi-ai stream idle timeout after 300000ms`，宿主 `llm-retry` 自动重试 1 次（1/5）后同一步完成，仍属同一会话、同一授权任务。

证据：[执行记录与文件清单](../../evidence/2026-10-30-harness-adverse/README.md)、[机器可读汇总](../../evidence/2026-10-30-harness-adverse/ui-adverse.json)、三份运行快照、会话脱敏事件、卡片操作日志、界面截图与步数记录均在 `docs/evidence/2026-10-30-harness-adverse/`。

未覆盖：三条主要场景仍在 `66d252f` 验证、未在修复提交后重跑；活跃 GUI 内插件热卸载未测（卸载证据为运行时卸载夹具 + 宿主停止后的隔离 profile 移除）。清理：隔离宿主已停止，测试插件已从隔离 profile 移除，六份运行记录与产物保留；机主在用 profile 未改动。
