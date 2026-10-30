# 执行体验与真实新闻落地证据（2026-10-30）

对应 INTENT-009。证据边界：本目录证明本地源码回归、离线夹具、安装/诊断与真实新闻管道；不证明真人点击身份（`harness.userQuestions` 只证明答复经过提问通道），真人业务决定另见 news-briefing 运行记录。

| 文件 | 生成方式 | 结论/边界 |
|---|---|---|
| `tests.tap` | **本轮重跑** `node --test`（12:44） | 64/64 pass；sha256 `3f7d4b581c7cf0f9…` |
| `collector-offline-regression.json` | **本轮重跑** `scripts/verify-news-collect-locale.py`（12:44，桩采集器） | PASS：24 例，0 网络、0 真实新闻运行；修复前 UTF-8 4 例非零、修复后全 0；sha256 `847615c9f5e3b567…` |
| `news-doctor.json` | 12:22 只读 doctor（news-briefing） | 真实只读检查；宿主加载/会话匹配为 unknown |
| `compiled-definition.json` | 12:29 `orch instantiate` | 参数化定义编译通过；不建运行 |
| `clean-install.json` | 12:26 干净目录离线安装 + bin doctor + demo | PASS；包 sha256 与临时文件清理已记录 |
| `runtime.json` | 12:22 装机 Harness 运行时夹具探针 | PASS：11 工具/7 调用；模型 0；`humanE2E=NOT_RUN` |
| `demo.log` | 12:23 `npm run demo` | done，模型调用 0 |
| `shell-reproduction.json` | 12:34 最小用例复现 | C locale 通过；UTF-8 未加花括号失败（最小 -c 用例退出 127） |
| `pack-install-receipt.json` | 本轮 `npm pack` 两次（字节可复现）+ 解包后 packaged CLI `doctor` | PASS；sha256 与文件数见回执；**隔离 profile 安装未跑**（本会话无独立 dsh CLI），现用 profile 未改 |

本轮重跑项：`tests.tap`、`collector-offline-regression.json`、`pack-install-receipt.json`（npm pack + packaged CLI），以及 news-briefing 的第二次真实采集。`runtime/clean-install/demo/compiled-definition/news-doctor` 为同日 12:2x 生成、本轮未重跑，仅登记。

新闻真实试跑证据在相邻项目：`/Users/yiliwen/开发/news-briefing/.orchestrator/ee8e7255-d008-4b99-a47a-46164862b145.json`（gitignored）与 `output/report.md|html|delivery.json`；首次失败留档 `artifacts/collect/attempt-1-failure/`。
