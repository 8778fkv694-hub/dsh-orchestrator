# 2026-10-30 落地复核证据

依据：[INTENT-007](../../sdlc/plan/intent-007-implementation-validation.md)、[计划/问题/结果](../../sdlc/test/implementation-audit-2026-10-30.md)。基线 acbf950，本轮为工作区修复版本，字节身份见 source-sha256.json。

| 文件 | 内容 |
|---|---|
| baseline.tap | 开始时 49/49 |
| regressions-before.tap | 本轮刷新/关闭回归运行于旧 acbf950 客户端，两条均失败 |
| client-fixed.tap | 修复后四项客户端行为回归；VM + 最小 DOM，不代替界面 |
| final.tap | 修复后全量 54/54 |
| demo.log | 无模型 demo，独立文件证据，done |
| runtime.log | 首次失败：旧 JSON 解析遇到 Markdown 围栏 |
| runtime-after.log | 装机服务正向：10 工具，6 调用，tools 0.2.1-rc.5 |
| runtime-adverse-after.log | 中间失败：拒绝意图回执缺 JSON |
| runtime-adverse-fixed.log | 最终反例：15 调用，含 cancel→verified 仍取消 |
| gui-run.json | 真实 Harness 页面调度的完整合成快照，revision 4 |
| news-project.json | 真实项目只读检查：1 管线、0 运行、0 输出物 |

## 真实 GUI 操作记录

工具：Codex cua_repl；目标为 DeepSeek Harness 现有窗口的浏览器侧栏。操作者为 Codex，不是机主本人、不代点业务门。独立临时工作区，owner 为 audit-synthetic-owner；确认依据标为 audit-fixture-NOT-HUMAN。

运行：57a579a3-d493-4a94-9c28-e65efc5a4d9f；operation：7e069d17-886b-4b2d-99f3-db22cf6fb0b3。

1. 旧演示页点击“启动”无确认框/状态变化；定位原生 window.confirm；没有重复派发未知任务。
2. 当前源码临时看板：点击“启动”可见“确认调度动作 / 确认启动”；确认后显示“启动成功：等待执行结果 · 工作单 7e069d17”，revision 1。
3. 暂停→已暂停 revision 2；继续→等待执行结果 revision 3；operation 未变。
4. 取消→可见“确认取消”与对账说明；确认后“正在核对取消” revision 4，operation 未变、无继续调度动作。
5. 自动预览合成 audit.txt；发现关闭立即重开。第二轮修复后重新启动源码服务，在同一工作区复测：关闭后预览从 AX 树移除；工具栏刷新显示“已刷新”，预览保持关闭。
6. 最后展示新闻项目只读看板：界面显示“只读模式 / 1 已登记管线 / 运行 0 次 / 还没有运行记录”。

以上为工具观察后的摘要与持久快照，不冒充导出的原始宿主轨迹或真人确认。未调用真实模型、未触发采集、未修改新闻项目、数字员工或现用 profile；没有安装新 bundle，现用插件不自动获得本轮源码修复。
