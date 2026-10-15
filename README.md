# 速率限制模式（Rate-Limit Mode）

DSH（DeepSeek Harness）宿主插件：在标准 Agent 预设基础上加入会话族级 LLM 速率限制与
「每日额度耗尽」检测，使会话在提供方返回每日配额 429 时不直接终止，而是按
1 分钟 1 次的节奏冻结等待，并预留客户端模型选择提示的同步通道。

## 功能

- **滑动窗口限速**：同一会话族（父会话 + 它启动的所有子/孙会话）共享一个
  每分钟 10 次的模型请求桶（含自动重试）。超限请求自动排队到下一分钟。
- **配额检测**：`status === 429`、`code === 'RATE_LIMIT'`，或消息中出现
  429 / `rate limit` 即视为配额耗尽。**措辞不参与判定**：真实提供方
  （agnes 免费档）返回的两种文案——`You've reached the API rate limit for
  free users…` 与 `You have used up today's text quota…`——都是配额信号，
  而前者不含 `daily`/`quota` 等任何关键词。措辞仅在没有 status 与 code 时
  作为兜底（中英「每日上限」等）。
- **冻结由已提交事件驱动**：命中后冻结会话族 1 分钟，实现「1 分钟 1 次」
  节奏。驱动源是已提交的 `llm/retry`、`assistant/attempt`（finish failure）
  与 `turn/end` 三个事件，**不是** `agent/request-error` 瀑布位——内置
  `@deepseek-ai/dsh-llm-retry` 一旦决定重试就返回 `{ kind: 'retry' }` 且
  不调用 `next()`，其后的瀑布位永远不会执行。折叠三个来源还有第二个必要
  原因：重试耗尽后的终态失败只记录在 `assistant/attempt` 与 `turn/end`，
  不会再产生 `llm/retry`。
- **回合存活**：冻结只延后下一次请求，不终止回合。
- **切换模型解除节奏**：用户通过内置模型选择器切换模型（持久化
  `model/selection` 事件）后，宿主端自动解除该会话族的冻结，请求路由到
  新模型。
- **会话投影 `llmRateLimit`**：把配额状态作为 wire 视图同步给客户端，
  供 UI 判断是否显示「切换模型」提示。

## 安装

```
plugin_manager install_bundle target=<本包绝对路径>
```

安装后，宿主预设补丁 `cordis.patch.yml` 会把 `@local/dsh-rate-limit-mode`
挂载进 `rate-limit`（速率限制模式）预设。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `maxPerMinute` | 10 | 会话族每 60 秒滚动窗口允许的模型请求次数 |
| `windowMs` | 60000 | 滚动窗口长度（毫秒） |
| `freezeOnDailyLimit` | true | 检测到每日额度耗尽时是否冻结会话族 1 分钟 |

## 客户端提示与验证

客户端在输入框上方显示每日额度提示，并提供模型选择器。客户端同时声明
`remote` 和 `remote.session` 依赖，使用会话插槽提供的 `sessionId`、
`useProjection` 读取状态；字典和插槽随插件卸载清理，支持重新加载。

## 验证

宿主回归检查（真实配额文案识别、三来源折叠、横幅开合、schema 校验）：

```sh
node --test index.test.mjs
```

客户端回归检查（依赖声明、卸载重载、投影加载与提示渲染）：

```sh
node --test --test-isolation=none client.test.mjs
```

提示横幅在用户切换模型前**持续显示**（早期实现带 60 秒过期窗口，用户稍后
回到页面时配额仍然耗尽却看不到任何提示）。

`HANDOVER.md` 是早期交接记录，其中「客户端未实现」的描述已过时。
