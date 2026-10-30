# 运行状态动效验收 · 2026-10-30

依据：[INTENT-008](../../sdlc/plan/intent-008-run-motion.md)，SPEC S47–S50，WP12。

## 改动

- waiting-action：卡片与详情动态条、状态点脉冲、当前步骤转动环。
- paused：灰色暂停标志，运行条/环停止；继续后恢复，operation 不变。
- ready、waiting-human、cancel-requested、done、cancelled：各自状态文字与静态标志；不增加完成步骤或模拟进度。
- prefers-reduced-motion：元素/伪元素动画关闭；文字与图标保留。

## 自动检查

baseline.tap：本轮前 54/54。final.tap：本轮后 **55/55**。新增客户端行为回归覆盖七种持久状态、卡片与步骤状态一致性、暂停符号、仅 waiting-action 有活动标记、0/2 不会被动效伪造为有完成进度。

## 真实 Harness 实测摘要

通过 cua_repl 操作现有 DeepSeek Harness 的浏览器侧栏，无模型调用，无业务门代点。

- 独立合成 run：9638e52d-e97c-4d23-9827-8e4f6f8d76bd；确认来源显式标记 synthetic-motion-demo-NOT-HUMAN。
- 启动：ready → waiting-action，revision 1；可见“进行中 · 等待执行结果”。连续两次截图目视检查，动态条高低与环位置均变化。
- 暂停：paused，revision 2；截图可见灰色暂停条、静态“Ⅱ”步骤节点，无活动动态环。
- 继续：waiting-action，revision 3；恢复运行显示。operation 始终 bfe64bd0-a329-421b-9d13-4571e7ba9286。
- 界面留在动效演示详情，供机主直接暂停/继续；服务和合成临时工作区特意保留。没有真实动作在执行，动效仅说明管线当前等待执行结果。

原始持久状态见 gui-run.json，当前源码字节身份见 source-sha256.json。上述截图为本次工具画面观察，未导出截图文件，不冒充原始 Harness 轨迹。

边界：真实业务仍未运行；人工等待与终态的样式由状态回归覆盖，本轮真实 UI 仅点击启动/暂停/继续。减少动态效果 CSS 已复核，未修改机主系统偏好进行切换实测。旧看板服务不自动热更新；当前展示使用新源码进程，现用 Harness 插件和 profile 未修改。
