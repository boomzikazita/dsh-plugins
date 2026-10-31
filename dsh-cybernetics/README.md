# dsh-cybernetics — 控制论内核 v4 运行时（DeepSeek Harness 插件）

> 由存档 `dsh-cybernetics插件源码存档.md`（v4.1，2026-08-16 卸载前）与
> `dsh-cybernetics插件开发与自进化经验.md` 重建。
> 对照《工程控制论》（钱学森/宋健·第三版）实现的机制级 Cordis 插件（ESM）。

## 一、文件清单

| 文件 | 说明 |
|------|------|
| `index.js` | 主插件（v4.2，808 行） |
| `core.mjs` | 纯函数控制律内核（EMA/滞环/发散/振荡/hash/熵/健康评分），供单元测试与外部复用 |
| `test/cybernetics.test.mjs` | 单元测试（node:test，10 用例全绿） |
| `cordis.patch.yml` | 插件自身 bundle patch（默认配置） |
| `package.json` | 包声明（dependencies 为空——依赖软链到全局宿主） |

## 二、机制（v4.2）

经典控制回路：

- **观测器**：内存状态（按 session 分区）+ JSONL 持久化（`~/.dsh/cybernetics/state_log.ndjson`）
- **前馈控制**：`tools/pre-execute` 规则表拦截（工具名白名单 + 参数正则）+ 本轮调用计数
- **反馈校正**：`tools/result` → delta → EMA 滤波（pHat）→ 控制律（档位自适应 + 发散/振荡检测）
- **执行器**：`cybernetics_snap` / `cybernetics_status` / `cybernetics_check` / `cybernetics_sandbox_mode`
- **能控性自检**：目标 + 所需工具 vs 当前可用工具（插件工具 ∪ 观测记忆）

### v4.2 完善项（2026-08-19，对照 v4.1 实测反馈）

| 项 | 内容 |
|----|------|
| A1 | 修复冗余 hash 假误报：rc.6 下 `exec.args` 恒 undefined → 改用参数文本（`execArgsText`，arguments 优先） |
| A2 | 观测完整率钳制 ≤1（孤儿 result 不再把分子顶破） |
| A3 | boot 日志回放恢复：pHat/档位跨重启续算（`boot-recover` 事件），消除系统失忆 |
| B4 | 信息熵告警：工具单一化（<1.0 且窗口 ≥8 次）注入警告，熵 ≥1.5 恢复（滞环防抖） |
| B5 | 工具耗时观测：result 记 `dtMs`，status/snap 输出最慢 TOP3 |
| B6 | `agent/disposed` 会话汇总：`session-summary` 事件（pHat 起止/档位/冗余/慢工具），供周检 automation |
| B7 | 按 session 分区状态：并发会话 pHat/档位/计数互不污染，无 session 路径归 `global` 兜底 |
| C8 | 冗余事件聚合：每 10 次记一条 `redundant-burst`，不再逐条刷日志 |
| C9 | status 内存态与日志回放态交叉校验，漂移 >0.1 标注 |
| C10 | 版本常量 `VERSION` 统一（core.mjs） |
| C11 | 警告注入失败留痕（`dropped-warn` 事件） |
| C12 | 纯函数下沉 core.mjs + node:test 单元测试 |
| C13 | 健康评分 `healthScore`（0-100：成功率×100 − 观测缺口×20 − 冗余率×10 − 发散/振荡各 10） |
| C14 | 失败归因观测（2026-08-19，方案 B）：result 事件失败时记 `errorType`（FsError code 优先，如 FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT；无 code 按消息模式归类）+ `errMsg`（截断 120 字符）——供周检第④项做失败根因分布 |

核心参数（`control`，均可经 patch 配置）：

| 参数 | 默认 | 含义 |
|------|------|------|
| `alphaLow` | 0.15 | EMA 基准增益（v4.6 起为唯一增益；原 alphaHigh 已删） |
| `dt0Ms` | 250 | 采样基准周期，增益按 Δt 归一（实测 p50=218ms） |
| `escalateAt` / `deescalateAt` | **0.20** / 0.15 | 升档 / 降档失败率阈值（v4.6 实测标定，原 0.6 不可达） |
| `deescalateStreak` | 5 | 降档防抖连续次数（滞环） |
| `divergenceStreak` | 3 | 连续失败判定发散 |
| `oscillationWindow` / `oscillationRatio` | 10 / 0.7 | 振荡检测窗口 / 翻转率 |
| `redundantWindow` | 20 | 冗余 / 熵窗口 |
| `entropyWarnAt` / `entropyRecoverAt` | 1.0 / 1.5 | 低熵告警 / 恢复阈值（滞环；v4.6 起还需旁证才注入） |

档位 → 稳定阀阈值（v4.6 起真正生效）：基线 25 − 收缩量 `fast: 0` / `deep: 5` / `conservative: 10`
⇒ **25 / 20 / 15**。档位由控制律自动切换（发散直通，或 pHat 慢统计超阈值）。

## 二点五、v4.6（2026-11-01）——《工程控制论》二次精读后的实测修正

17.5 天 / 29784 条日志 / 9141 次 bash 调用做底，逐条对照书本原理：

| 编号 | 原理出处 | 原缺陷（实测） | 改法 |
|---|---|---|---|
| P0-1 | §1.5 受控量只能经控制量改变 | bash 命令失败不进 `delta`（只有 spawn 错才 isError）。占 60% 调用量的主力工具，实测命令级真失败 **3.74%**，回路只看见 1.0% | 退出码取 `value.exitCode`，回退解析输出里 `[exit code: N]`；grep/diff 类退出 1 属约定非零，单列 `exitBenign` |
| P0-2 | §4.11 能控性 / §15.11 增益 | `adaptiveAlpha`（连败时 α 0.15→0.5）让 pHat 与 divergence 落在同一个尖峰上——**实测共线性 100%**，两支路信息完全重叠 | 删 alphaHigh，pHat 回归恒 alphaLow 慢统计；快通路交给 divergence |
| P0-3 | §1.7 质量指标 | `escalateAt=0.6` 离实测分布（会话末 pHat p90=0.016 / max=0.111）5 倍余量，17 天 **0 次**触发；`MODE_LIMITS(5/4/3)` 被 patch 基线短路，档位切换对阈值零影响，但告警文案仍印 5→4→3（对模型说假话） | `escalateAt` 0.6→**0.20**（25.9% 会话升档，与「失败率≥5% 会话占 27.8%」同量级）；阈值改「基线−收缩量」并统一印生效值 |
| P1-4 | §1.7 抗扰/噪声 | 熵告警 204 次里 **62%** 的会话全程无任何旁证事件（冗余/发散/振荡） | 低熵需旁证才注入（`entropyGatePure`） |
| P1-5 | §1.5 控制量受限 | 前馈规则任意位置匹配 `git\|npm\|curl…`，849 次命中 0 次拦截，`ls .../node_modules/...` 也被判网络操作 | 模式锚定到命令起始位 |
| P1-6 | §15.6(3) 饱和限制 | 控制代价（每条告警的 token/注意力）从未进判据；"前馈拦截数"恒为 0 的装饰字段 | 删 `feedforwardBlocks` / `blocked` 字段 |
| P1-7 | 第 7 章 采样系统 | dtMs 实测 p50=218ms / p99=134s / max=3.2h（跨 5 个数量级），固定 α 的时间常数不是一回事 | `emaAlphaFor(dt)`：1−(1−α₀)^(Δt/Δt₀)，钳 [α₀/5, 0.5] |
| P1-8 | 判据精度 | verify-on-stop 49 次里 37 次只有 1 个 `write`（多为新建文件，本无覆盖风险） | 单次 write 不提醒；`edit` 或 ≥2 次写入才提醒 |
| P2 | §21.2 多级协调 | 451 个会话各自一个控制器，无协调级，5 MB 日志无人消费 | 离线 `~/.dsh/scripts/cybernetics_rollup.py` 接入周检 |

标定数据与回放脚本：`00-工作区运维/_probe_bash_exit.py`、`_calib2.py`、`_calib3.py`、`_calib4.py`。

**遗留（未做，下次再谈）**：`healthScore` 仍以 pHat 为主项，会话末 pHat 中位数≈0 ⇒ 该分数长期停在 100，
属饱和指标；要真正有分辨力需按工具基线与时间窗归一，不能在现有公式上调常数。

## 三、挂载方式

**标准安装（bundle，推荐）**——本目录即 bundle 形态，含自身 `cordis.patch.yml`：

```bash
dsh plugin --profile web add <本地插件路径>
```

或手工方式（旧版本兼容）：把 `dsh-cybernetics` 加入 profile 的 `dsh.profile.bundles`，
或直接追加到 profile 的 `cordis.patch.yml`：

```yaml
# 追加到 ~/.dsh/profiles/web/cordis.patch.yml 或 headless
- insert:
    - id: cybernetics
      name: '<插件安装路径>/index.js'
```

**关键**：插件 node_modules 必须软链到全局宿主（`ln -s $DSH_NODE_MODULES node_modules`），
**绝不自己 pnpm 装依赖**——否则 `TOOL_RUNTIME_SCHEDULER` Symbol 不匹配，所有工具调度崩溃。

## 四、开发教训（来自经验文档）

1. **依赖副本冲突（最大坑）**：插件自装 `@deepseek-ai/dsh-tools` → 宿主出现两个副本 →
   `TOOL_RUNTIME_SCHEDULER`（module-level Symbol）不同 → 所有工具调度崩。解法：软链到全局宿主。
2. **waterfall 监听器必须 `return next()`**：光调 `next()` 返回 undefined → 断链 → 后续工具全崩。
3. **rc.6 defineTool 签名**：`execute(args, exec)` + `output:{schema, render}`；工具列表用 `ctx.tools.schemas()`。
4. **HMR 副作用回滚**：改插件后 cordis HMR 只重载配置，`ctx.tools.register` 副作用被回滚 → 需重启 `dsh web`。
5. **稳定阀三缺陷（积分饱和教训）**：计数器跨轮累计不重置 → 锁死（改滑动窗口）；
   一票否决无恢复路径（降级为警告注入）；全部工具一视同仁（交互/观测工具豁免）。
6. **TRANSPORT 报错根因**：`tools/pre-execute`（工具执行期）注入消息破坏角色交替约束 →
   移到 `agent/pre-step`（请求组装期）用 `createUserMessage` 构造完整消息。
7. **控制律要自适应**：档位切换 + 滞环防抖；**反馈要滤波**（EMA 估计失败率）。
8. **能控性判定防冷启动误报**：观测记忆持久化（`observed_tools.json`）+ 未观测 ≠ 缺失的语义分层。
9. **rc.6 参数字段是 `arguments` 不是 `args`**：所有 exec 参数读取必须走 `execArgsText`，
   否则 `exec.args` 恒 undefined（A1 假冗余根因）。

## 五、验证

```bash
# 语法检查
node --check index.js && node --check core.mjs
# 单元测试（17 用例；Node 22 下 `node --test test/` 会把目录当模块报 MODULE_NOT_FOUND）
node --test test/*.test.mjs
# 导入冒烟测试（需先软链 node_modules）
node -e "import('./index.js').then(m => console.log(m.name, m.inject))"
# 运行时验证（重启 dsh web 后）
cybernetics_status   # 应含 healthScore / boot 恢复 / 最慢工具
# A3 生效标志：重启后日志出现 event:"boot-recover"
grep boot-recover ~/.dsh/cybernetics/state_log.ndjson | tail -1
# A1 生效标志：重启后冗余计数骤降（不再每调一次 bash 都算冗余）
grep redundant-burst ~/.dsh/cybernetics/state_log.ndjson | tail -1
```
