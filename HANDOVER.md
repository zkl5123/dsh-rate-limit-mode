# 速率限制模式插件 — 交接文档

## 背景与目标

当 LLM 提供方返回「每日额度耗尽」的 429（例如 DeepSeek 的
`used up today's text quota and are now limited to 1 request every minute`），
会话不应直接报错终止，而是：

1. **限速节奏**：把整个会话族（父会话 + 子/孙会话）按 1 分钟 1 次的节奏冻结，
   让下一分钟的请求自然通过（提供方每分钟放行 1 次）；
2. **弹出模型选择框**：客户端显示一条限额提示，引导用户切换到其他可用模型，
   切换后自动解除冻结、会话继续。

会话日志中可观察到：`llm/retry` 事件连续 5 次（每日额度 429），随后
`turn/end` 以 `kind: "error"` 结束——这是旧实现「返回 undefined 杀死回合」
的缺陷，本版已修复。

## 已实现（本仓库）

### 宿主端 `index.js`（`@local/dsh-rate-limit-mode` 宿主插件）

1. **滑动窗口限速器**：每个会话族一个共享桶，`maxPerMinute`（默认 10）/
   `windowMs`（默认 60s）。`agent/request` 瀑布先 `admit`（窗口满则排队等待
   释放），超限自动排队到下一分钟。

2. **每日限额冻结**：`agent/request-error` 中检测 429 + 每日额度语义
   （`isDailyLimitFailure`：status 429 / RATE_LIMIT code + 中英关键词），命中则
   `setFrozen` 冻结会话族 `DAILY_FREEZE_MS = 60_000`，并在下一个
   `agent/request` 处 `holdDailyFreeze` 等待——实现「1 分钟 1 次」节奏。

3. **关键修复**：每日限额 429 时返回 `{ kind: 'retry' }` 而非 undefined，
   保证回合存活（agent-loop 对非 retry action 会抛 LlmError 杀死回合）。

4. **解除节奏**：监听宿主 `session/event`，用户通过内置模型选择器切换模型会
   产生持久的 `model/selection` 事件，`retirePacing` 清除该会话族的冻结与
   `everFrozen` 跟踪，下一次请求不再被 1 分钟冻结卡住，路由到新用户选定的
   模型（由内置 `installModelSelection` 的 `agent/request` 瀑布完成路由）。

5. **会话投影 `llmRateLimit`**：纯持久折叠（只读 `llm/retry` 与
   `model/selection` 事件），wire 视图 `pendingModelSwitch` / `frozenUntil` /
   `lastDailyLimit` 同步给客户端，供 UI 判断是否显示提示。

### 预设补丁 `cordis.patch.yml`

复制标准 `@deepseek-ai/dsh-agent-preset` 并挂载宿主端
`@local/dsh-rate-limit-mode`，preset id 为 `rate-limit`（速率限制模式）。

## 未实现（需要继续完成的部分）

### 1. 客户端模型选择提示 UI（核心缺失）

宿主端已把每日限额状态通过 `llmRateLimit` 投影 wire 视图同步到客户端，
但**客户端半边（`client.js`）尚未编写**。需要：

- 新建 `rate-limit-mode/client.js`（客户端插件模块，用
  `window.__ModuleLoader__.load` 注册懒工厂，factory 内 `require('react')` 取
  React，宿主 React 不重复安装）；
- `package.json` 增加 `./client` export 与 `dsh.client` 段：
  `platform: web`、`immediately: true`、`inject: ['slots', 'sessions', 'remote', 'remote.session']`；
- 在 `shell.quota-notice` 链槽注册一个提示条（`select: (owner) => unknown | null`
  注册形态）：读取当前会话的 `llmRateLimit` 投影 wire 视图，当
  `pendingModelSwitch === true`（即最近一次每日限额 429 且之后没有更新的
  `model/selection`）时渲染提示；
- 提示条提供「切换模型」操作，调用 `remote.session.selectModel`
  （持久化 `model/selection` 事件），宿主端 `session/event` 监听器随之
  `retirePacing` 解除冻结；
- 样式只使用宿主 theme token（`--dsw-*` / `--dsh-*`），不引入
  `@deepseek-ai/dsh-client-ui-primitives`；
- 文案走客户端 locale 服务。

参考实现形态（宿主内置模型选择插件 `@deepseek-ai/dsh-client-ui-model-selection`
的 `client.js`）：`ModelDirectory` 通过
`binding.session.projections.faceOf("modelSelection")` 读投影，通过
`ctx.remote.session.selectModel({ sessionId, provider, model })` 提交选择，
通过 `ctx.remote.session.modelCatalog()` 取模型目录。本插件可复用同样的
服务面，目录数据也可直接来自 `modelSelection` / `modelCatalog`。

### 2. 安装与验证

- 用 `plugin_manager install_bundle`（target 指向本包目录）把
  `@local/dsh-rate-limit-mode` 安装进当前 profile；
- 安装后确认 `cordis.patch.yml` 的 preset 行与宿主行挂载成功
  （`Config.listConfigs` 查 `name: '@local/dsh-rate-limit-mode'` 的 entry）；
- 端到端验证：触发一次每日限额 429，确认 (a) 日志出现
  `[llm-rate-limit] daily-limit freeze` 且回合不终止；(b) 1 分钟后下一请求
  放行；(c) 客户端提示条出现，选择新模型后 `model/selection` 事件提交、
  冻结解除、会话继续。

### 3. 可选增强

- `frozenUntil` 倒计时（客户端用 `Date.now()` 与 `frozenUntil` 差值渲染，
  宿主视图保持引用稳定，不含宿主端 `Date.now()`）；
- 若提供方 429 文案不在现有关键词表内，补充 `isDailyLimitFailure` 的正则；
- 为 `freezeOnDailyLimit` 增加 Config 开关的 UI 呈现（当前仅宿主侧生效）。

## 关键机制备忘（避免重复踩坑）

- `agent/request` 瀑布 payload 为 `{ turn, step, signal }`，`agent` 由
  `agentEvents` 的 fused dispatcher 注入（`@deepseek-ai/dsh-agent` 的
  `fused(payload) => ({...payload, agent})`），解构 `{ agent, signal }` 安全；
- `agent/request-error` 瀑布 payload 为
  `{ turn, step, provider, failure, retryPolicy, signal }`，同样注入 `agent`；
- agent-loop 在 `agent/request-error` 瀑布返回非 `{kind:'retry'}` 的 action 时
  会 `throw new LlmError(...)` 终止回合（`dsh-agent-loop` 约 1133 行），
  因此每日限额分支必须返回 `{kind:'retry'}`；
- 内置 `installModelSelection`（`@deepseek-ai/dsh-agent`）已通过
  `system-prompt/assemble` + `agent/request` 两个瀑布消费
  `modelSelection` 投影的 `pending`，负责把请求路由到用户选定的模型——
  本插件不需要自己做路由，只需在用户选模型时解除自己的冻结；
- 宿主 `ctx.commands` 不存在（仅客户端有 commands 服务），旧版
  `ctx.commands?.register?.()` 是死代码，已删除；
- 投影 `view` 必须引用稳定（不依赖宿主 `Date.now()`），时间比较逻辑放客户端；
- 宿主 `session/event` 监听器签名 `(session, event)`，`event` 为完整
  SessionEvent 信封（`seq` / `time` / `type` / `data`）。

## 文件清单

| 文件 | 状态 |
|---|---|
| `index.js` | 宿主端，已完成 |
| `cordis.patch.yml` | 预设补丁，已完成 |
| `package.json` | 宿主插件清单，已完成（待补 `dsh.client` 段） |
| `locale/en.json` | 宿主 locale，已完成 |
| `client.js` | **未实现**（见上文「1. 客户端模型选择提示 UI」） |

## 待办清单（按优先级）

1. [ ] 编写 `client.js`：`shell.quota-notice` 提示条 + 调用 `remote.session.selectModel`
   切换模型（详见上文第 1 节）；
2. [ ] `package.json` 增加 `./client` export 与 `dsh.client` 段（`platform: web`、
   `immediately: true`、`inject: ['slots','sessions','remote','remote.session']`）；
3. [ ] `plugin_manager install_bundle` 安装进当前 profile，用
   `Config.listConfigs` 确认宿主行挂载成功；
4. [ ] 端到端验证：触发每日限额 429 → 日志出现 freeze 且回合不终止 →
   1 分钟后下一请求放行 → 客户端提示条出现 → 选新模型 → `model/selection`
   提交 → 冻结解除、会话继续；
5. [ ] （可选）`frozenUntil` 倒计时 UI、补充 `isDailyLimitFailure` 关键词、
   `freezeOnDailyLimit` 的 Config UI。
