# 验证记录

2026-10-30。当前为开发预览，尚未完成最终验收。

| 层级 | 已实际运行的内容 | 结果/边界 |
|---|---|---|
| 核心/适配隔离 | Node内置测试：定义、确认依据、快照、产物、会话隔离、门、取消、恢复、存储失败、锁、路径、驱动和卸载 | 28/28；[测试日志](../../evidence/2026-10-30-development/node-tests.tap)；含真实子进程SIGKILL恢复；提问回答为夹具，不是真人 |
| 无模型示例 | npm run demo | 本地固定脚本计算42，独立文件核验，模型调用0 |
| 真实安装运行时 | scripts/verify-harness-runtime.cjs | Harness tools 0.2.1-rc.3；10工具注册，6次真实工具调用，产物/人工门流程及卸载；Agent和回答为夹具，模型调用0 |
| 独立安装包/profile | npm pack + 临时DSH_HOME内plugin add、dump-config、remove | 真实安装/合成配置/卸载通过；未启动界面、未修改现有profile |
| 真实模型/真人界面端到端 | 未执行 | 最终目标仍未完成 |

运行时探针使用真实Cordis、SystemPrompt、ToolRuntime、AgentRegistry和UserQuestionService，但合成Agent、文件和回答，因此不是用户要求的完整端到端验收。核心测试的“确认”均为明确夹具，不表示机主对演示项目的确认。

## 最终验收待办

- [ ] 在隔离真实Harness界面加载打包插件，确认版本、模型、端口和工作目录。
- [ ] 由真实Agent复述新的测试Intent，由机主本人确认；拒绝/无回答不接受。
- [ ] 创建并运行纯脚本管线；独立核验本次产物及零模型脚本执行路径。
- [ ] 真实Agent与真人门混合流程，核验状态展示、产物和交付。
- [ ] 中断后重启读回相同操作ID；未知效果不重放，真人对账后接续。
- [ ] 取消、门拒绝、未获确认、交付缺项和插件卸载边界有实际证据。
- [ ] 留宿主/插件身份、运行ID、原始输入、步骤、状态、产物哈希及失败未验项。

## 可重复命令

npm test；npm run demo；npm pack。运行时探针需使用目标宿主的Node环境及其app.asar/dsh/package.json，示例命令以实际安装路径替换，不读取或复制生产凭据。探针输出明确标humanE2E=NOT_RUN。
