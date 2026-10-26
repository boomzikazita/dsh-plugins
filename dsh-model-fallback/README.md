# dsh-model-fallback

主模型调用失败时自动切换到备用 provider/model 的 DSH 插件（Host-only，无 UI）。

## 机制

挂在 Cordis 的 `llm/stream` 瀑布事件上（每次流式模型调用都会经过，位于重试/回放/路由之外层）：

1. 主模型流照常透传，流式体验不变；
2. 终态 chunk 为 `finish.kind === 'error'`（适配器选择/派发/迭代失败都会被宿主归一成这个形态，届时 provider 自身的重试策略已耗尽）且满足安全阀时，丢弃本次失败；
3. 按 `chains` 顺序取下一个备用 `{provider, model}`，用**原请求的全部内容**（消息历史、系统提示、工具表、sessionId、取消信号）重新发起一次流式调用，chunk 接续吐给消费端；
4. 备用也失败则继续沿链下落，直到链尾才把最后的 error 透传给用户。

## 安全阀

| 条件 | 行为 |
|---|---|
| `finish.kind === 'aborted'`（用户取消 / signal 中止） | 永不切换 |
| 已产出任何内容块（text/reasoning/tool-call） | 不切换（`onlyBeforeContent: false` 可关），防两个模型的半截输出拼成一条消息 |
| 失败码命中 `skipCodes`（默认 `CONTENT_FILTER`） | 不切换（内容审查拒绝换模型大概率同样拒绝） |
| 插件自发起的 fallback 请求 | WeakSet 标记，瀑布重入直接放行，不会递归拦截自己 |

跨 provider 切换时**默认丢弃 `reasoningEffort`**（各家 effort 语义不通用，显式 effort 不被目标模型支持会在派发前被拒绝）；备用目标可显式覆盖 `reasoningEffort / temperature / maxTokens / stop`。

## 配置（cordis.patch.yml 的 config 段）

```yaml
config:
  onlyBeforeContent: true        # 已在产出内容后不切换（默认 true）
  codes: []                      # 触发切换的失败码白名单；空 = 所有 error 都切
  skipCodes: ['CONTENT_FILTER']  # 永不切换的失败码
  logFile: '~/.dsh/model-fallback/events.ndjson'  # 切换事件日志
  chains:
    - from: { provider: 'kimi-coding' }   # model 省略 = 该 provider 任意模型
      to:
        - provider: 'qwen-token-plan-cn'
          model: 'qwen3-coder-plus'       # 按目标端点实际可用模型 id 填
        # - provider: '...'               # 可继续挂第二、第三备用
          # model: '...'
          # reasoningEffort / temperature / maxTokens / stop 可按目标覆盖
```

备用目标的 provider 必须已在宿主注册（如 `llm-pi-ai` 的 `config.providers` 里配好 `apiKeyEnv`）。目标未注册或模型 id 写错时，该目标会以 error 终态失败并自动落到链的下一个目标——不会炸掉会话。

## 后台设置面板与模型联动（v0.3.x）

- **设置 → 模型 Fallback**（`settings.section` 注册的管理页）：可视化编辑链（主路由 + 备用目标）、失败码黑/白名单、onlyBeforeContent 开关，保存即热生效（`patchReload: live` 走 Loader 正常路径重放）；
- **模型目录联动**：面板里的 provider/模型输入框带 datalist 建议，数据源是 Host 端实时 `llm.listProviders()` + `listModels()`（官方模型有哪些就列哪些；目录外的路由仍可自由输入）；
- 通道：client 半同源 `fetch` ↔ host 半 `connection.fetch.register` 路由（`/api/model-fallback/state|save`，dsh-context 同款模式；不走 `rpc.handle`——它内部经调用方 fiber 访问 webServer，0.3.0 实测缺 inject 必抛 `cannot get property without inject`）。`ctx.inject(['connection','configEditor'])` 条件激活，headless 下跳过面板通道、核心 fallback 不受影响；
- agent 侧另有 `model_fallback_status` 工具（注册表目录 + 生效链 + 最近 5 次切换事件）；
- 插件同时导出 `Config`（schemastery），供激活时校验 patch config 与 inspect 投影。

依赖说明：`node_modules/@deepseek-ai/schemastery` 是指向 dsh 检出 `vendor/schemastery` 的软链（插件目录裸导入不可解析，2026-10-18 实测 ERR_MODULE_NOT_FOUND）；`@deepseek-ai/dsh-tools` 经 profile node_modules 可解析。

## 观测

- 每次切换：console 一条 warn（进宿主日志）+ `logFile` 追加一行 ndjson（含 ts / sessionId / from→to / 失败码 / HTTP 状态 / 截断的错误消息）；
- 日志写盘失败会计数告警（前 3 次），不静默吞错；
- `tail -f ~/.dsh/model-fallback/events.ndjson` 可看切换历史。

## 生效

新增插件条目需**重启 dsh 宿主**（`restart-dsh-web.sh`）；之后改 config 走 `patchReload: live` 热重载。

## 已知边界

- fallback 请求是插件新建的对象，不携带 agent-loop 的 WeakSet 标记：session-title 服务不会把它当作标题生成触发点（无害，仅少一次标题刷新机会）；
- 会话历史由主模型产出、中途切到备用模型时，replay state 只在「历史 provider 与目标 provider 属同一适配器实例」时保留（本机 kimi-coding 与 qwen-token-plan-cn 同属 llm-pi-ai，满足）；
- 只兜底「调用级失败」；模型正常返回但内容质量差不在本插件职责内。
