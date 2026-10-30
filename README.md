# DSH Orchestrator

**简体中文** | [English](README.en.md)

把确认过的意图组织成可观察、可验证、可恢复的管线。独立核心首先通过 DeepSeek Harness 插件交付。

**当前为开发预览。** 核心与插件适配已具备可运行代码。真实模型与真实界面的三个主要场景已在 `66d252f` 验证；修复提交 `67e0f7c`（取消后对账修复）上追加的真实界面反例（拒绝、无答案、缺交付、在途取消、对账 verified 回归、人工门拒绝）已通过。三条主要场景未在修复提交后重跑、确认卡为受托验收操作者代点等边界见[当前状态](STATUS.md)和[验证记录](docs/sdlc/test/verification.md)。

## 方法

- 人的话是原始输入；AI引导梳理并复述，经人确认才建立正式Intent。
- 定义说明方法，运行固定版本，具体权限沿用宿主实际机制。
- AI需要判断时使用宿主Agent，确定的工作可由可信脚本驱动；关键取舍由人决定。
- 任务派发先持久化操作编号。中断后先读回状态，不自动重复未知副作用。
- 模型回报完成后，独立检查声明的文件产物；运行结束与交付合格分别判断。
- `harness.userQuestions` 表示答复经过宿主提问通道，不能单凭它证明具体是谁点击；需要区分本人和受托代操作时，应使用额外身份与审计机制。

方法来自数字员工的管线实践；本仓原创实现，不要求安装数字员工。与[起飞](https://github.com/8778fkv694-hub/pre-flight)衔接：起飞建立AGENT、Intent、Spec与Plan，管线引用相关路径并固定内容摘要。

## 安装到隔离 Harness 配置

需要Node 22+及支持插件bundle的DeepSeek Harness。已核验运行时接口：`0.2.1-rc.3`；其他版本需重新验证。

下载本仓库，进入目录运行：

```sh
npm test
npm run demo
npm pack
```

将生成包安装到一个**新建验收profile**，使用你安装的 `dsh` 命令：

```sh
dsh plugin --profile orch-acceptance add /绝对路径/dsh-orchestrator-0.1.0-alpha.1.tgz
```

在该profile的 `cordis.patch.yml` 覆盖插件配置，填入专用测试项目的真实绝对路径：

```yaml
- id: evidence-orchestrator
  config:
    workspace: /绝对路径/测试项目
    questionTimeoutMs: 90000
```

先核对该profile的宿主界面、模型、提问服务和端口配置，再启动；不要覆盖正在使用的profile。具体profile启动和界面配置以安装版本为准。默认工作目录为空，配置好后工具才能读写管线状态。

## 在 Harness 中使用

让Agent读取本仓库的 `examples/pipeline.json`，用你自己的目标改写候选定义，并调用 `orch_create`。插件会显示AI复述、步骤及验收条件，通过宿主提问让你确认。拒绝、无答案或超时均不建立正式运行。

工具流：`orch_create` → `orch_next` → 按工作单使用已获授权的宿主工具 → `orch_complete` → `orch_next`。遇到人工门调用 `orch_gate`；状态查看用 `orch_status`。

暂停/继续：`orch_pause`、`orch_resume`。恢复读回：`orch_recover`。未知效果先检查执行端与文件，再由 `orch_reconcile` 请求人确认已核验或已停止。`orch_cancel` 遇到在途动作只记取消请求，不能证明外部进程已经停止。

## 无模型脚本运行

核心不执行提示词或任意shell。可信应用可以为节点ID提供明确的执行函数，再使用 `dsh-orchestrator/driver` 的 `driveScripts`。示例见 `examples/script-demo.js`；该演示使用标明来源的合成确认夹具，不是实际人的批准记录。恢复时驱动器拒绝重放已有在途动作。

CLI支持读取、推进、提交和暂停恢复，运行 `node src/cli.js` 查看用法。CLI与核心是可信本地编程接口，不是防止同权限进程篡改状态的安全边界；Agent不得用CLI的确认参数代替宿主真人确认。

## 数据、限制与恢复

状态仅写入配置项目下 `.orchestrator/`。同一运行限定所属会话；不要把状态目录提交开源。路径禁止越界及符号链接，文件证据上限4MB。节点目前是线性task/gate/check，任务产物须相对派发前基线有内容变化；相同字节重写保守拒绝。

文件存在/内容/哈希仅证明声明的文件性质，不能代称外部业务提交成功。当前没有DAG、跨机器并发、分布式事务、自动补偿和恰好一次保证。真实故障留下的锁不自动删除；先确认无写者，备份状态，再由操作人处理锁并读回。机器损坏和断电需要另做存储验证。

卸载隔离profile内的插件：

```sh
dsh plugin --profile orch-acceptance remove dsh-orchestrator
```

卸载会注销工具并中止插件等待；它不负责停止由宿主工具启动的外部任务。请先核对执行端。保留状态目录以便检查和接手。

## 研发依据

[Intent](docs/sdlc/plan/intent.md) · [Spec](docs/sdlc/design/spec.md) · [Plan](docs/sdlc/build/plan.md) · [验证](docs/sdlc/test/verification.md) · [交付](docs/sdlc/deploy/delivery.md)

代码采用[MIT许可](LICENSE)。非DeepSeek官方插件，与DeepSeek无隶属关系。插件规范参考[官方文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。
