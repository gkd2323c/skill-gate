# 技能门卫（skill-gate）

Hana v2 App。在模型调用工具后，持续提醒它读取与任务相关的 skill。提醒作为独立消息追加到模型请求末尾。

行为依据：[需求规格](skill-gate-需求规格.md)。

## 行为

| 条件 | 结果 |
| --- | --- |
| 本轮尚未调用工具 | 保持静默 |
| 调用任意工具，尚未读 skill 或声明 | 下一次模型请求末尾带一条提醒 |
| 调用 `read`，且 `resource.kind === "skill"` | 本轮停止提醒 |
| `skill_gate_declare` 的 `reason` 为非空字符串 | 采纳声明，本轮停止提醒 |
| `reason` 缺失、纯空白或类型错误 | 拒收，继续提醒 |

读普通路径的 `SKILL.md`、普通文件、recipe 或 agent 均不算读取 skill。读取判定只使用助手工具调用块中的 `read` 原始入参，不检查返回正文或成功状态。宿主的延迟工具调用 `tool_call(server="core", tool="read")` 使用其 `arguments` 作为实际读取入参；其他服务器的同名工具不计入。

提醒明确规定：声明理由只能是「不存在与本任务相关的 skill」。「我很熟悉」「我已知道怎么做」「这个很简单」不构成理由。代码只检查非空，不判断理由语义。

## 轮次与消息

状态保存在 App 进程内存中，按宿主给出的会话路径隔离；无路径时使用会话 ID。每次 `agent/before-start` 开始新的请求轮次，清除该会话上一轮的读取和声明状态。首个 `agent/pre-step` 将消息中已有的调用 ID 记为历史基线，此后的新调用才计入本轮；即使中途压缩删去历史消息，本轮已确认的状态仍保留。一次请求内可以有多个模型步骤和工具调用。

条件未满足时，每次 `agent/pre-step` 都保留一条提醒；重复裁决时替换本 App 已有提醒，确保同一份请求最多出现一条且位于末尾。读取或声明后移除本 App 已有提醒，其他消息保持原样。关闭会话时清除对应内存状态；App 重载或宿主重启后状态重新建立。

调用观察在 `agent/pre-step` 中完成，只读取宿主规范化的 `assistant.content[].type === "toolCall"`（`id`、`name`、`arguments`）；只有工具结果而没有原始参数时可触发提醒，不能据结果正文认定读取 skill。两个裁决入口都将内部空返回值归一为 `{}`。

本 App 不注册 `tools/pre-execute`。Hana `1.2.1-beta` 的 AppHost 把 `undefined` 编码为 `null`；工具前置钩子有多个持有者时，宿主瀑布读取 `null.block` 会报错。已安装的 `tool-result-tuner` 在此前置钩子返回 `undefined`，因此只修改本 App 的返回值不能解决共存故障。观察已有消息可避免增加该瀑布的持有者，保持原有工具处理链。

App 不注册工具结果改写钩子，不写系统提示词，不向会话发送消息或触发额外回合。

## 安装与权限

通过 Hana 扩展管理入口导入官方打包器生成的安装 ZIP，完成安装审查，并对目标 Agent 启用本 App。

| 能力 | 用途 |
| --- | --- |
| `app/tools.expose-to-model` | 暴露声明工具 |
| `app/hooks.agent-before-start` | 初始化本轮状态 |
| `app/hooks.agent-pre-step` | 观察本轮新增工具调用的原始入参并追加独立提醒 |
| `app/hooks.observe` | 关闭会话时回收内存 |

能力可在 Hana 的 App 权限页查看和授权。运行代码不需要网络、文件写入、进程执行或跨会话读写权限。工具的注册名为 `skill_gate_declare`，模型实际看到的调用名由宿主生成。

声明入参：

```json
{
  "reason": "不存在与本任务相关的 skill：已检查可用技能目录，未找到覆盖本任务的条目。"
}
```

回执的 `details` 包含 `status`、`accepted`、`code`、`summary`。空理由返回 `EMPTY_REASON`；缺少宿主会话身份返回 `SESSION_REQUIRED`；有效声明返回 `DECLARED`。拒收不会停止提醒。

## 开发与校验

源码入口为 `index.js`，状态与文案在 `lib/gate-core.js`。`sdk/` 由官方 Creator 的 SDK 复制函数生成，随包携带，禁止手改生成文件。

核心与入口测试：

```powershell
node --test './test/gate-core.test.mjs' './test/app.test.mjs'
```

宿主传输契约回归测试需要 `HANA_APP_TOOLS_ROOT` 指向实际 Hana Server 版本目录，然后运行：

```powershell
node --test './test/hook-transport.test.mjs'
```

与真实 `tool-result-tuner` 的共存测试另需 `SKILL_GATE_TUNER_ROOT` 指向其安装目录，然后运行：

```powershell
node --test './test/app-coexistence.test.mjs'
```

测试只读宿主产物，从 `bundle/index.js` 提取原始钩子注册器，从 `app-host-entry.js` 提取 RPC 编码表达式；在隔离的 VM 中运行。共存测试加载实际 tuner 源码和本 App 的 SDK 入口，将两者的钩子响应都经过同一编码链，不调用真实宿主或模型、不写生产目录、不启用 App。宿主代码边界变化时测试明确失败，要求重新核对契约。

用官方 `hana-app-creator/scripts/validate_app.mjs` 检查源码与归档，用本仓 `scripts/pack.mjs` 打包。安装包包含完整运行依赖，安装时无需下载依赖或构建。

打包产物必须与 CI 产出的字节一致：脚本固定以 `core.autocrlf=false` 归档并把时区置为 UTC。仓库 blob 本身是 LF，Windows 的 `core.autocrlf=true` 会把 CRLF 带进归档；zip 头的修改时间按本地时区写入，两处都会让同一 tree 在 Windows 与 Linux 打出不同字节。本地 `dist/*.entry.json` 的 `archive.sha256` 与 `archive.size` 正是投市场索引要用的值，与线上附件对不上时索引校验会失败。

### 验证边界

`0.1.2` 的 Node 测试 26 项通过。覆盖调用基线、消息去重、上下文不可变、会话隔离、声明边界、压缩后状态、SDK 入口、宿主原始 RPC 编码与钩子瀑布，以及真实 `tool-result-tuner` 共存。

共存用例在 `0.1.1` 下两项均失败，准确报出 `Cannot read properties of null (reading 'block')`；`0.1.2` 下两项通过。单独运行 tuner 与同时加载技能门卫时，工具前置钩子都只有 tuner 一个持有者；工具后提醒、skill 读取释放、结果不变在同一组合下断言。安装产物排除测试与 `dist/`。

官方隔离启动校验在 Hana `1.2.1-beta` 上缺少 `sessionHooks` 服务，返回 `SMOKE_APPHOST_FAILED`，无法完成完整 AppHost 启动验收。宿主原始代码回归测试可证明本次空值故障的修复，不等同于完整生产会话验收。实际安装后的消息注入、权限生效和工具调用需按需求规格验收。

## 版本

`0.1.2`：通过步骤消息中的工具调用块观察原始入参，移除工具前置钩子及其能力声明；规避与 `tool-result-tuner` 的多钩子空值冲突，增加真实 App 共存回归。

`0.1.1`：三个裁决入口均返回可传输对象。该版本仍会触发其他 App 返回空值的多钩子故障，不用于本机共存部署。
