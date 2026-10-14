# 速率限制模式（Rate-Limit Mode）

DSH（DeepSeek Harness）宿主插件：在标准 Agent 预设基础上加入会话族级 LLM 速率限制与
「每日额度耗尽」检测，使会话在提供方返回每日配额 429 时不直接终止，而是按
1 分钟 1 次的节奏冻结等待，并预留客户端模型选择提示的同步通道。

## 功能

- **滑动窗口限速**：同一会话族（父会话 + 它启动的所有子/孙会话）共享一个
  每分钟 10 次的模型请求桶（含自动重试）。超限请求自动排队到下一分钟。
- **每日额度检测**：识别「每日额度耗尽」型 429（status 429 / `RATE_LIMIT`
  码 + 中英关键词），命中则冻结会话族 1 分钟，实现「1 分钟 1 次」节奏。
- **回合存活**：每日额度 429 时向 `agent/request-error` 瀑布返回
  `{ kind: 'retry' }`，保证回合不被 agent-loop 终止。
- **切换模型解除节奏**：用户通过内置模型选择器切换模型（持久化
  `model/selection` 事件）后，宿主端自动解除该会话族的冻结，请求路由到
  新模型。
- **会话投影 `llmRateLimit`**：把每日限额状态作为 wire 视图同步给客户端，
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

## 未完成

客户端「切换模型」提示 UI 尚未实现，详见 [`HANDOVER.md`](HANDOVER.md)。
