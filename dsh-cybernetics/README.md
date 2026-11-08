# dsh-cybernetics — 控制论内核 v5（逻辑控制 + 可靠性 + 跨会话汇总）

> DeepSeek Harness 插件（ESM）。本版是 2026-11-08 对照钱学森/宋健《工程控制论》
> （第三版）重读后的**重构**，不是调参。理论依据与旧版的错位见下文。
>
> 包：`@boomzzzzzz/dsh-cybernetics@0.3.0`　运行时版本常量：`v5.0`

## 一、为什么重构：章节选错了

旧版 v4.x 把 agent 工具调用当成**有运动方程的受控对象**：EMA（一阶递归滤波）估计失败率
`pHat`、档位（fast/deep/conservative）自适应、稳定阀收缩工具调用上限、熵告警、振荡检测、
healthScore。对照原书，这套机器属于**第一至第十五章**（物理系统的微分方程、传递函数、
稳定性判据），而 agent 的工具调用是离散 0/1 序列：

- **第十七章**（逻辑控制和有限自动机）明确写道：这类"仅取值为 0 或 1 的信号序列"，
  "前面各章内所述的原理和方法很少有所帮助"，分析工具是逻辑代数与时序逻辑。
  §17.1 的防空警报例子就是标准范式："连续三次或三次以上搜索发现目标 → 报警；
  报警后连续四次或四次以上无信号 → 解除。"——滞环逻辑，不是反馈控制。
- **第十九章**（冗余技术和容错系统）才是工具失败的正确框架：λ、MTBF、k/N 冗余、
  致命/局部故障分类、自检 + 备份。
- **第二十一章**（大系统）给出多级结构：下层自治、上层汇总（多会话/多 agent 协调）。

旧版自己的实测也印证了错位：`escalateAt=0.6` 17 天 0 次触发、`MODE_LIMITS` 从未生效、
熵告警 62–88% 无旁证、`observationRate` 恒等于 1、healthScore 长期钉在 100、
前馈 849 次命中 0 次拦截。问题不是阈值没调好，是机制用错了章节。

## 二、现在的机制（按章节）

| 层 | 实现 | 章节 | 说明 |
|---|---|---|---|
| 逻辑控制 | `logic.mjs` | §17 | 显式状态机：连续失败 ≥3 报警，连续成功 ≥4 解除；确定性故障阈值降为 2；致命故障立即报；同一调用连续 3 次重复报警。一次事件段只注入一条（修掉 52 连跪那种单轮 51 次注入） |
| 可靠性 | `reliability.mjs` | §19 | 每工具 λ̂、95% Wilson 区间、MTBF（次/失败）、故障分类（暂态/确定性/可纠正/致命/未归类）、重试预算下可恢复上限 `1-(1-λ_暂态)^budget`、浪费重试计数 |
| 汇总 | `cybernetics_rollup` | §21 | 跨会话读 NDJSON，按时间窗汇总会话/调用/λ/故障构成/告警/浪费重试/最慢工具 |
| 自检 | `verify-on-stop` | §19 | 本 turn 有 edit 或 ≥2 次写入但无回读 → turn 边界提醒；单次新建 write 不提醒 |
| 宿主能力 | `cybernetics_sandbox_mode` | — | 切换会话沙箱；提权走宿主审批门 |

**已删除**：EMA/`pHat`、档位机、稳定阀、工具分布熵、振荡检测、healthScore、
`adaptiveAlpha`、Δt 归一、前馈规则表（含 `network-unstable`，实测对 `git status`
也注入噪声）。运行时约 1530 行降到 1236 行（净删 292 行运行时 + 306 行旧测试），测试从 17 条纯函数变成 35 条 + 9 项集成冒烟。

## 三、工具

| 工具 | 用途 |
|---|---|
| `cybernetics_status` | 本会话逻辑态 + 跨会话工具可靠性（λ/CI/MTBF/故障构成/重试预算/浪费重试/最慢） |
| `cybernetics_snap` | 把当前事实写入日志（snap 事件） |
| `cybernetics_rollup` | 跨会话汇总（`days` 默认 7，`limit` 默认 5000 行） |
| `cybernetics_check` | 工具可用性自检（能力清单，不再叫"能控性"） |
| `cybernetics_sandbox_mode` | 切换会话文件沙箱（提权需宿主批准） |

## 四、配置（`cordis.patch.yml`）

```yaml
config:
  stateLog: '~/.dsh/cybernetics/state_log.ndjson'
  logic: { failStreak: 3, recoverStreak: 4, deterministicStreak: 2, repeatAlarm: 3 }
  reliability: { minSamples: 5, retryBudget: { bash: 2, read: 1, edit: 1, write: 0, web_fetch: 2, default: 1 } }
  log: { maxBytes: 8388608, keep: 3 }
```

## 五、日志

JSONL，事件：`boot`/`session-start`/`pre-execute`/`result`/`alarm`/`wasted-retry`/
`verify-on-stop`/`sandbox-mode-switch`/`snap`/`session-summary`。
`result` 带 `failed`、`kind`、`errorType`、`dtMs`，bash 另带 `exitCode`/`exitBenign`。
超过 `maxBytes` 自动转存 `.1`、`.2`、`.3`，不再无限增长（旧版 17.5 天 5 MB 无人消费）。

## 六、验证

```bash
node --check index.js && node --check logic.mjs && node --check reliability.mjs
node --test test/*.test.mjs          # 35 条：逻辑状态机穷举 + 可靠性数学 + 共享纯函数
node test/smoke.integration.mjs      # 9 项集成冒烟（需 node_modules/@deepseek-ai/dsh-tools）
```

## 七、从 0.2.x 迁移

- 工具名不变（`snap`/`status`/`check`/`sandbox_mode`），新增 `rollup`；
  `snap` 的 `mode` 参数已删除。
- 日志字段：`delta` 保留（兼容），新增 `failed`/`kind`；旧日志行仍可被 `rollup` 统计。
- 配置：`control`/`modes`/`stability`/`feedforward` 段全部失效，换成 `logic`/`reliability`/`log`。
- 安装后需要**重启 dsh web**（HMR 会回滚 `ctx.tools.register` 的副作用）。

## 八、局限（诚实清单）

- 状态机是**逻辑告警**，不是控制回路：它不会让失败率下降，只保证"该报的时候报一次、
  不该报的时候不吵"。真正的动作（换路、重试、问用户）仍由模型执行。
- λ/MTBF 是**外模型**（统计关系），不是内模型（运动方程）；样本小的时候 CI 很宽，
  报告里必须带着区间看。
- `重试可恢复上限` 是上界而不是预测：它假设暂态故障独立，确定性故障重试无效。
- `cybernetics_check` 只是工具名单核对，不构成"能控性"分析（能控性在原书里是
  状态空间矩阵的秩条件，需要模型）。
