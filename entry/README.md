# entry/ — 可选的 Harness 侧栏「管线」入口

这是一个可选的 DeepSeek Harness（DSH）**profile 插件 bundle**：在 Harness Web UI 左侧栏
「插件」图标正下方放一个常驻的「管线」入口，点开是**多看板管理页**。

它不修改 DSH 程序、官方包或本仓库的 orchestrator 插件；安装/卸载都由 DSH 的
Plugin Manager 管理（见 [安装](#安装到-harness)）。

## 能做什么

- **常驻入口**：左侧栏图标，不需要开会话或在对话里提及插件。
- **多看板**：列出任意数量的看板，每个看板独立一行：状态、工作区、地址/端口。
- **打开看板**：在系统浏览器打开该看板的只读页面（verbose 状态、运行记录、输出物、
  启动/继续/暂停/取消）。
- **进入会话**：在对应工作区打开 Harness 会话，并把下一步提示词预填进输入框；
  不会自动发送，人工门仍由人确认。
- **添加看板**：
  - 填工作区目录 → 插件在 `127.0.0.1` 启动一个只读看板；端口留空自动分配，也可自定义；
  - 只填看板地址 → 作为外链入口（适合手工 `orch view` 启动的看板）；
  - 同一工作区可以添加多个看板（不同端口各自独立）。
- **移除看板**：只关闭该看板服务，不动项目数据与管线记录。
- 页面右侧带操作说明，底部带推荐流程。

## 结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半侧：看板列表读写、每个工作区一个 loopback viewer（`startViewer()`）、`GET/POST /orch-entry/api/dashboards` 路由；经 `connection.requestRejection` 信任栅栏 + Origin 校验。 |
| `client.js` | 浏览器半侧：`sidebar.panellist`（order 5，位于「插件」0 与「自动化任务」10 之间）+ `main` 面板。只使用 `slots`/`locale`/`uiWorkspace`/`workspaces` 与自有内联样式/主题 token。 |
| `cordis.patch.yml` | bundle 补丁：插入 `orch-entry` 行。 |
| `data/dashboards.json` | 运行时状态（看板列表、端口、每看板令牌；0600，已被 `.gitignore` 排除）。首次运行由种子生成。 |
| `locale/*.json`、`icon.svg` | 插件管理页显示用标题、描述与图标。 |

## 安装到 Harness

前提：Harness 的 Web 客户端带 `sidebar.panellist` / `main` 席位（0.2.1-rc.x 的
desktop/web 组合满足）。

1. 用 Harness 的 Plugin Manager 安装本目录为 profile bundle：

   - 应用内：**插件 → 添加插件**，选择本目录（绝对路径）；
   - 或 `plugin_manager` 工具：`install_bundle`，target 为本目录绝对路径。

2. 启用后左侧栏出现「管线」图标。首次打开时看板列表由 bundle 配置里的
   `dashboards` 播种（默认为空，可直接在页面「添加看板」）。

### 配置覆盖（可选）

默认 `viewerEntry` 指向本目录旁的 `../src/viewer.js`，`dataFile` 为
`entry/data/dashboards.json`。若本目录被拷贝到别处，用 profile patch 覆盖：

```yaml
- id: orch-entry
  config:
    viewerEntry: /绝对路径/dsh-orchestrator/src/viewer.js
    dataFile: /绝对路径/dashboards.json
    dashboards:            # 仅首次运行播种；之后以页面管理为准
      - label: 我的项目
        workspace: /绝对路径/项目
        port: 8893
```

卸载：Plugin Manager 移除 `@local/orch-entry`。卸载会关闭所有由它启动的看板；
orchestrator 插件与其配置不受影响。

## 使用示例

1. 打开「管线」页 → 「添加看板」：名称 `新闻简报`，工作区 `/path/to/news-briefing`，
   端口 `8893`（或留空自动）→ 添加。
2. 卡片显示「新闻简报 · 运行中 · …/news-briefing · 127.0.0.1:8893」。
3. 「打开看板」→ 系统浏览器打开看板；「进入会话」→ 打开该工作区会话，
   输入框已预填「继续…管线：先用 orch_status…」的提示词。
4. 需要第二个项目/管线时重复添加；不需要的看板点「移除」。

## 安全与边界

- 看板只绑定 `127.0.0.1`，每个看板一个进程内令牌；只读视图 + 调度入口，
  动作只登记工作单，**不执行任务、不调模型、不启动外部命令**。
- 管理接口注册在 Host 的 web server 上：Desktop 由 `dsh-app://` 协议按登录 cookie
  转发，Web profile 为同源访问；请求先过 `connection.requestRejection`，再校验
  `Origin`（`dsh-app://app` 或 Host 同源）。外链看板只保存地址，不经过该接口。
- 看板页面自带 `Content-Security-Policy: frame-ancestors 'none'`，因此用系统浏览器
  打开，不内嵌进 DSH 面板。
- 与 `orch view` 同类：本地可信操作面，不是安全边界，不替代 Harness 的人类确认；
  未做局域网访问、多用户与账号权限。
- 插件代码原地修改后，Plugin Manager 的启用/停用会重新组合并加载新代码；
  替换已安装的包代际或清理遗留路由，重启一次 Harness 即可。

## 验证

- `node --test test/entry-plugin.test.js`：2 项（Host 看板管理/路由加固/增删/清理；
  Client 入口注册/页面动作/添加移除/说明区块），使用假 viewer 与 stub 页面运行时，
  不启动真实进程与模型。
- `npm test`：本仓库全量 **66/66**（含上述 2 项）。
- 真实 Harness desktop profile 安装验证：插件 entry `active`；状态文件生成；
  `GET /api/health` 与看板页面在 `127.0.0.1` 返回 200。页面视觉与交互由机主在
  应用内确认（本仓库记录不声称已完成视觉验收）。

证据记录见 [docs/evidence/2026-10-30-entry-integration](../docs/evidence/2026-10-30-entry-integration/README.md)。
