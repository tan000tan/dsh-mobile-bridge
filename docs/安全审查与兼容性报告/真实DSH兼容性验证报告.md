# 真实 DSH 兼容性验证报告（阶段二 · 第五阶段，只读比对）

审计时间：2026-10-24。方法：对**本机已安装** `@deepseek-ai/dsh@0.1.7-rc.2` 的 lib 做只读 grep 取证（未启动、未修改），与官方仓库 0.2.1-rc.3 快照及手机端客户端期望逐项比对。真实端到端测试见文末授权边界。

## 一、协议面逐项比对矩阵

| 协议要素 | 手机端期望（P1 fork） | 本机 0.1.7-rc.2 实证 | 官方 0.2.1-rc.3 | 结论 |
|---|---|---|---|---|
| RPC 路由 | `POST /api/<ns>/<method>`，body 仅 `{"args":{…}}`，`client-request/server-response` 信封 | `dsh-api-gateway\lib\index.js` 含 `/api/` 前缀处理 | 同（`docs\api-gateway.md`） | ✅ 一致 |
| 事件复用 | WS `/api/remote.mux`；`$events` 首帧 ready；`open/item/end/cancel` 帧 | `dsh-api-gateway\lib\{index,client}.js` 含 `remote.mux` 字符串（grep 命中） | 同 | ✅ 一致 |
| 审批应答端点 | `POST /api/$events/result`，`{clientId,eventId,outcome:{kind,value}}` | `dsh-api-gateway\lib\{index,client}.js` 含 `events/result` 字符串 | 同（waterfall 语义） | ✅ 一致 |
| 认证链 | `GET /?token=<launch token>`→`dsh-auth-<authority>` cookie；token 不进 /api 与 Authorization | 安装包 `dsh-client-connection\lib\index.js`：`dsh-auth-"` 前缀字面量命中；`launchToken`×4、`cookieMaxAgeDays`×4、`sec-fetch-site`×1 | 同 + 新增 `/connect` | ✅ 一致（见下行差异） |
| `/connect` 独立 API 接入 | 客户端**不依赖**它（走浏览器式交换，两版通用） | **不存在**（`"/connect"`=0、`interactions`=0 次 grep 命中） | 0.2.1-alpha.2 新增 | ✅ 客户端选了兼容两版的路径；/connect 记为未来优化项 |
| 转发事件白名单 | 客户端消费 `approval/request`、`api-session/status`、`api-session/error` 等 | 安装包 `dsh-api-remotes\lib\index.js` 逐字命中全部所需事件（含 `api-session/error`——本次新增"会话错误通知"的数据源真实存在） | 同 | ✅ 一致 |
| 会话/文件 RPC | `session/list|create|prompt|cancel|follow|updateQueue`、`workspaceFiles/stat|read|list`、`goal.pause/resume` | `dsh-api-remotes\lib\client.js`、`dsh-api-session-controller\lib\typert.host.js` 命中 `session/follow`、`session/updateQueue`、`workspaceFiles` | 同 | ✅ 一致 |
| 会话持久化 | 客户端不直读日志（走 API） | 本机实际写 `session.v4.jsonl.zstd`（只读确认过文件名） | v4 为已发布格式 | ✅ 客户端不依赖该格式 |
| 0.2.x 专有能力 | schedule/*、pluginManager/* 等 | 0.1.7 无 → 404 | 有 | ✅ 客户端按 capability-unavailable 自动隐藏（`FeatureAvailability.kt`），mock 环境实测横幅如实显示 |

## 二、版本差异风险评估（0.1.7-rc.2 ↔ 0.2.1-rc.3）

官方 `docs/upgrade-guide/` 中与接入相关的变化：`/connect` 新增（客户端未用，无影响）；`webRuntime`→`webStartup`、通配 host 加载即拒（服务器内部，客户端无感）；JSONL 持久化改命名空间插件（客户端不直读）；`working-directory` 语义变化（客户端经 RPC 使用，不依赖旧 cwd 配置键）；schedule bundle 往返（客户端按能力探测）。**结论：客户端的接入路径（浏览器式 token→cookie + POST /api + WS mux）在两版上同一，且 P1 官方兼容性声明明确 "0.1.7-rc.x hosts still work"（其 docs/COMPATIBILITY.md），其 0.12.0 版协议基线即钉在 0.1.7-rc.2 并留有专项 DTO（Harness017Dtos.kt）与 v3/v4 事件双读。**

剩余不确定项（如实声明）：P1 自述"保留回退不等于对每个老 host 逐一回归"——因此真实 0.1.7-rc.2 端到端仍列为需授权项；桥接为版本无关的反向代理（不解析业务协议），对两版同样透明。

## 三、真实端到端测试的授权边界（未执行）

1. 已完成的准备：全部只读检查（本报告）+ 模拟全链路测试（ApprovalAuditTest 等）+ 测试步骤设计（交付报告第 13 节的使用步骤即测试步骤）。
2. 需要的条件：**由你手动启动** `dsh web`（本项目不得自动启动）；手机/模拟器与电脑同网；无需访问真实工作区即可验证（只建空会话发一条"你好"级消息）。
3. 可能的副作用：在真实 DSH 中新建一个测试会话（可在电脑端删除）；launch token 属敏感凭据——测试时仅由你粘贴进手机端设置，**本项目代码与报告不记录、不保存、不传播该 token**。
4. 回滚：删除测试会话即可，无其他副作用。
5. 未获授权前不执行；不把 mock-harness 结果冒充真实 DSH 测试结果。
