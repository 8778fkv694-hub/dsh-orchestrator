# 2026-10-30 可选 Harness 侧栏入口（`entry/`）交付与验证

## 交付内容

新增可选的 DeepSeek Harness profile bundle `entry/`：

- 左侧栏「管线」常驻入口（`sidebar.panellist`，order 5，位于「插件」与「自动化任务」之间）；
- 多看板管理页（`main` 面板）：列表、打开看板、进入会话、添加/移除看板；
- 看板地址/端口可自定义：填工作区由 Host 进程内 `startViewer()` 在 `127.0.0.1`
  启动（端口留空自动分配并写回状态文件）；只填地址则为外链看板；
- 列表持久化在 `entry/data/dashboards.json`（0600，已 gitignore，含每看板令牌）；
- `GET/POST /orch-entry/api/dashboards` 管理接口：`connection.requestRejection`
  信任栅栏 + Origin 校验（`dsh-app://app` 或 Host 同源）；
- 页面右侧「操作说明」、底部「推荐流程」，遵循宿主主题 token，不导入宿主 Client 包。

不修改 DSH 程序、官方包、orchestrator 插件本体；安装/卸载由 DSH Plugin Manager 管理，
卸载会关闭由该 bundle 启动的全部看板。仓库打包产物不受影响（根 `package.json` 的
`files` 仍未包含 `entry/`）。

## 验证

### 离线回归（本仓可复现）

```sh
node --test test/entry-plugin.test.js   # 2/2
npm test                                # 66/66（含新增 2 项）
```

- Host 半：种子看板启动 → 状态文件生成（token/port 持久化）→ GET 列表 →
  外来 Origin/非 JSON POST 被拒 → 外链看板添加 → 缺失工作区/非法端口被拒 →
  托管看板添加 → 移除外链 → 卸载清理关闭所有 viewer。使用假 viewer 模块，
  不启动真实进程。
- Client 半：入口注册（`main` + `sidebar.panellist`，order 5）、加载/列表渲染、
  「打开看板」调用 `window.open`、「进入会话」预填提示词并打开工作区会话、
  添加表单 POST 载荷、移除 POST、说明/流程区块渲染。使用最小 hook 运行时与
  stub `fetch`/`window`，不运行真实浏览器。

### 真实 Harness desktop profile 安装（机主本机，可选）

- Plugin Manager 安装 `@local/orch-entry` 后 entry `active`；
- 首次运行生成状态文件（看板：新闻简报 / `127.0.0.1:8893`，令牌持久化）；
- `GET /api/health` 与看板 HTML 在 `127.0.0.1:8893` 返回 200（带该看板令牌，令牌不外传）；
- 早期版本页面在应用内由机主截图确认；**多看板管理页的视觉与交互验收由机主在应用内
  确认，本记录不声称已完成**。

## 边界

- 测试中的 viewer / 页面运行时 / 提问均为假实现，不含真实模型调用与真实任务执行。
- 未验证：多用户/局域网访问、跨机器、Host 升级后的 slot 兼容性（依赖
  `sidebar.panellist`/`main` 与 `connection`/`webServer` 服务）。
- 看板为本地可信操作面，不是安全边界；人工门与 Intent 确认仍在 Harness 会话内由人完成。
- 管理接口的令牌只出现在 Host 状态文件与页面响应中，不进入仓库、日志或本文档。
