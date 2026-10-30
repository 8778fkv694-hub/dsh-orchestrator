# 交付状态

版本：0.1.0-alpha.1，开发预览。公开仓库 `github.com/8778fkv694-hub/dsh-orchestrator`（`main` 与本地同步）已回读；验收所用包由 `npm pack` 从提交 `67e0f7c` 生成并字节复现（sha256 `735236398884813a…`；此后提交只改文档/证据，`src/` 与 `package.json` 未改），隔离 profile 内 add / 配置合成 / remove 有回执（[pack-install-receipt.json](../../evidence/2026-10-30-harness-adverse/pack-install-receipt.json)）。

真实 Harness 验收：三条主要场景（混合管线、重启恢复、脚本节点）在 `66d252f` 的隔离真实界面通过；追加反例套件（拒绝、无答案、缺交付、在途取消、对账 stopped、对账 verified 修复回归、人工门拒绝）在 `67e0f7c` 的真实界面通过，见[反例执行记录](../../evidence/2026-10-30-harness-adverse/README.md)。边界：三条主要场景未在修复提交后重跑；确认卡为获授权的验收操作者代点而非机主本人；活跃 GUI 内热卸载未测。

分发：**不发布 npm**（包名 `dsh-orchestrator` 已被他人占用），以公开源码 + 本地打包分发；tag / GitHub Release 待机主决定。不向现有用户 profile 覆盖安装。隔离 profile 安装和移除保留具体收据；用户生产任务不作为测试数据。回滚：退出专用测试宿主，移除专用 profile 里的本插件，保留项目状态；外部任务另行核实停止。
