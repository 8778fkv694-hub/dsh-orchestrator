# 当前版本落地复核与改进循环

日期：2026-10-30（Asia/Shanghai）。基线：`acbf950`；开始时工作区 clean。

正式依据：[INTENT-007](../plan/intent-007-implementation-validation.md)。

## 意图复述（已确认）

原始输入：“你去deepseekharness测试项目落地情况，测试验证要有计划进行，形成改进循环，转换我的意图并执行”。

复述：在 DeepSeek Harness 核验 dsh-orchestrator 当前版本的可用性与真实项目落地状态，以“计划→测试→问题记录→修复→复测→证据更新”闭环推进。保留人工门和宿主配置边界，不发布、不代替机主选择新闻偏好。

确认来源：本次 Codex 对话中机主回答“确认，按此范围执行”，随后要求“你现在是一个项目执行经理，替我全权工作”。授权范围内自主排期、测试、修复、复测与归档；既有人工业务门仍保留。

## 执行计划与判据

| 编号 | 检查 | 通过判据 | 证据层级 |
|---|---|---|---|
| V1 | 当前版本全量回归、无模型 demo | 断言通过、独立核验 42 | 本地源码 |
| V2 | 装机 Harness 正向与反例探针 | 10 工具注册、调用、取消对账及卸载通过 | 真实服务 + 合成 Agent/答复；不算真人 E2E |
| V3 | Harness 内看板启动、暂停、继续、取消、输出物刷新 | 点击产生明确反馈，状态符合动作语义 | 真实 GUI + 隔离合成数据 |
| V4 | 核对 news-briefing 登记、运行、交付状态 | 分别报告工程准备与业务验收状态 | 只读检查，不重跑新闻采集、不代点业务门 |
| V5 | 缺陷回归与交付核对 | 每个缺陷有失败证据、根因、修复、复测；全量回归无新增失败 | 修复后源码 + GUI |

不修改机主正在使用的 Harness 配置，不启动子 Agent，不向外发送消息，不改新闻项目文件。测试命令和子进程设超时；仅回收本轮创建的临时目录和进程。若需机主业务决定，保留现场而不伪造通过。

## 循环记录

### AUDIT-001：Harness 内点击“启动”无反馈

- 发现：现有 Harness 会话中机主曾反馈“按启动没反应”；本轮在其演示看板选择 ready 运行，真实点击“启动”后仍为 ready，未出现确认框或成功提示。
- 初步定位：页面 `runAction()` 使用 `window.confirm()`；嵌入式浏览器可能不支持此原生模态框。需以页面内确认替代并实测。此处是调度确认，人工业务门仍由 Harness 处理。
- 根因与修复：原生 `window.confirm()` 在当前嵌入式浏览器中未呈现确认交互。改用页面内确认；取消仍需显式选择；确认期间运行选择或 revision 改变则拒绝提交；重复提交有在途保护。
- 复测：真实 Harness 内出现“确认启动”，确认后 ready → waiting-action，显示 operation；暂停/继续保持原 operation；取消经页面内确认后为 cancel-requested。通过。

### AUDIT-002：输出物刷新事件抛错

- 代码发现：`renderOutputs()` 局部 `var refresh` 指向刷新按钮，点击回调调用 `refresh()`，遮蔽同名刷新函数。
- 影响：输出物工具栏手动刷新失效；自动刷新不能替代对此入口的验证。
- 修复：局部变量改名，恢复调用 API 刷新函数。
- 复测：新增客户端回归在 `acbf950` 报 `refresh is not a function`；修复后通过；真实 Harness 点击输出物工具栏“刷新”显示“已刷新”。通过。

### AUDIT-003：运行时探针不兼容结构化展示

- 发现：装机服务探针首次失败，JSON.parse 收到 Markdown 围栏；反例探针遇拒绝意图回执时又缺机器可读 JSON。
- 根因：renderer 已变化，探针仍假设最后文本必为裸 JSON；拒绝分支遗漏 JSON。
- 修复：共用解码器兼容结构化内容、裸 JSON 和 JSON 围栏；拒绝回执补齐 JSON；无可解析内容仍报错，不从摘要猜测通过。
- 复测：装机 tools **0.2.1-rc.5** 正向 10 工具/6 调用、反例 15 调用均 PASS，含拒绝/无回答/缺交付/取消对账 stopped 与 verified/卸载。合成 Agent/答复、0 模型调用。通过。

### AUDIT-004：自动跟随立即重开已关闭预览

- 发现：真实 Harness 窄侧栏里点击“关闭预览”，抽屉立即重开，遮住列表工具栏。
- 根因：closeDrawer 调用 render，自动选择逻辑立即重选文件。
- 修复：本次输出物视图尊重手动关闭；刷新不自动重开；可点文件重开或切换视图恢复跟随。不修改持久偏好。
- 复测：新增回归在 `acbf950` 失败（抽屉应隐藏但仍显示）；修复后通过；真实 Harness 关闭后抽屉移除，随后工具栏刷新不再重开。通过。

### AUDIT-005：新闻采集收尾行在 UTF-8 locale 下报“未绑定变量”

- 发现：真实新闻试跑在 collect 节点以退出码 1 失败（`scripts/collect.sh: line 101: fetch_status…: unbound variable`），摘要与 meta.json 在报错前已写完；脚本用 `$fetch_status` 紧跟全角右括号“）”，在 C.UTF-8/en_US.UTF-8 下被 Bash 并入变量名，`set -u` 报未定义。
- 同类写法：collect.sh:47、news-collector/collect-with-fallback.sh:34、render.sh:51（均在错误分支，风险较低）。
- 修复：news-briefing 四处改为 `${var}`，不改变采集语义；首次失败证据保留在 `news-briefing/artifacts/collect/attempt-1-failure/`，不把失败重写成成功。
- 回归：`scripts/verify-news-collect-locale.py` 用桩采集器跑 24 例（2 shell × 2 locale × 修复前/后 × 3 模式），0 网络、0 真实新闻运行；修复前 UTF-8 4 例如实非零，修复后全部 0；证据 [collector-offline-regression.json](../../evidence/2026-10-30-execution-experience/collector-offline-regression.json)。
- 真实复测：同一 run 的同一 pending collect 工作单在修复后执行第 2 次，退出 0、status=ok、20 条；该 run 最终 `done`，3 份交付哈希与回执一致。

## 结果

首轮闭环完成：发现 4 项问题，修复 4 项，相关回归与界面复测通过。

第二轮追加（12:40–12:55）：修正采集回归脚本的期望退出码并重建非空证据；修复 news-briefing 采集收尾行的 locale 缺陷；news-briefing 真实端到端运行到达 `done` 并交付 3 份文件。

| 计划项 | 实际结果 |
|---|---|
| V1 | 基线 49/49；demo done、modelCalls=0；修复后完整回归 **54/54** |
| V2 | 当前装机服务正向与反例均 PASS；合成答复，不计真人/真实模型 E2E |
| V3 | 真实 Harness：启动、暂停、继续、取消、输出物刷新与关闭通过；合成工作区未执行外部任务 |
| V4 | news-briefing：1 管线、9 节点、3 声明交付；**0 运行、0 输出物**；界面与磁盘一致 |
| V5 | 新增 5 项回归，全量 54/54；两条客户端反例在旧提交实际失败；运行时初始失败保留 |
| V1（第二轮） | 全量 **64/64**（12:44 重跑 `node --test`）；新增 claim/doctor/template/observation 回归 | 本轮 TAP |
| V4（第二轮） | news-briefing 真实端到端 `done`；3 份交付哈希与回执一致 | 运行快照 + 交付文件 |
| V5（第二轮） | 采集 locale 缺陷：24 例离线回归 PASS；首次失败留档、未重写 | collector-offline-regression.json |

证据：[本轮索引](../../evidence/2026-10-30-implementation-audit/README.md)。

工程结论：交互与验证工具缺陷已修复，当前源码完整回归 **64/64**；采集 locale 缺陷已修复并离线回归。业务结论：news-briefing 完成一次真实端到端运行（runId `ee8e7255-d008-4b99-a47a-46164862b145`，status `done`），Markdown/HTML/回执哈希一致；新闻事实准确性未逐条核查。

## 下一轮队列与触发条件

1. **WP7 新闻业务验收（已完成一次）**。沿用 INTENT-003 与 news-briefing/TRIAL.md；2026-10-30 12:53 运行 `ee8e7255-d008-4b99-a47a-46164862b145` 到达 `done`，交付 Markdown/HTML/回执；偏好与两张门经真实提问通道由获授权验收操作者代点（受托代操作），新闻事实准确性未逐条核查。
2. **规模验收缺口**。WP10 目标为 200 运行/50 管线/200 输出物；历史证据仅 36/2/26，本轮不把它标为已验。下一轮应补足规模数据与首屏性能测量。
3. 活跃 GUI 插件热卸载与修复版真实模型全流程仍未重测；本轮没有构建/安装新包，不改变现用插件或宿主配置。

清理：归档合成 GUI run 后停止本轮两台临时验收服务并回收夹具目录；原有 8891/8892 服务未动。为机主保留一个当前源码启动的真实新闻项目只读看板，并在 Harness 当前浏览器展示；它不执行业务。
