/**
 * dsh-cybernetics core — 纯函数控制律内核（v4.2）
 *
 * 与插件 index.js 分离，无 Node 副作用、无外部依赖，可被 node:test 直接测试，
 * 也可被其他工具（周检 automation、observer 脚本）复用。
 * 控制回路的数据结构/副作用（state、hooks、日志）留在 index.js。
 *
 * v0.2.0（2026-10-14，规则收敛）：
 *   DEFAULT_FEEDFORWARD 清空——irreversible-write 等不可逆拦截规则移交
 *   dsh-approval-gate（rules.json 内置 deny 段），cybernetics 不再持有拦截类规则；
 *   retry/timeout 类「放行+警告」规则由 cordis.patch.yml 的 feedforward 配置按需下发。
 *
 * v4.2（2026-08-19）：
 *   A1 冗余 hash 改用参数文本（exec.arguments），修复 rc.6 下 exec.args 恒 undefined
 *      导致的同工具全判"同参数重复"假冗余。
 *   C13 健康评分、B4 熵阈值等纯逻辑下沉到此处。
 *
 * v4.6（2026-11-01，对照《工程控制论》二次精读 + 17.5 天实测标定）：
 *   P0-1 误差信号补盲：bash 非零退出码计入 delta（原只看 isError，看不见 60% 调用量的
 *        主要失败模式；实测 9141 次 bash，真失败 3.74%，回路只见 1.0%）
 *   P0-2 判据解耦：pHat 改回恒 alphaLow 的慢统计（删 adaptiveAlpha）。实测共线性 100%——
 *        原 alphaHigh 把 pHat 顶到与 divergence 同一个尖峰上，两支路信息完全重叠
 *   P0-3 阈值标定：escalateAt 0.6→0.20（实测 p90=0.15/p95=0.19/max≈0.44；0.6 时 17 天 0 次触发，
 *        0.20 可额外抓到 12% 的「无突发但失败率 8%+」会话）
 *   P0-3 执行器言之有物：MODE_LIMITS(5/4/3，从未生效) → MODE_VALVE 相对基线的收缩量
 *   P1-7 采样归一：EMA 增益按 Δt 归一化（实测 dt p50=218ms/p99=134s，跨 600 倍，同一 α 含义不同）
 *   P1-4 熵告警加门控：仅当同期有冗余/发散/振荡才注入（实测 202 次里 88% 无佐证信号）
 *
 * v4.7（2026-11-01，补 v4.6 漏项）：健康分从会话级改成跨会话窗口级。
 *   旧公式 (1-pHat)*100 在会话级评分，实测 309 个会话失败率中位数 0 ⇒ 分数长期钉在 100，
 *   属 AGENTS 点名的「必饱和派生指标」；且 observationRate 恒等于 1（每个 pre-execute 必配
 *   一个 result 钩子），本身是恒等式不是观测。改为：跨会话 300 次窗口 + 按工具基线归一
 *   （bash 天生 3.7%、edit 14.3%），观测缺口改用真实未配对调用数。
 *   实测分辨率：15243 个真实样本切成 300 次窗口，各段得分 46~98（旧公式全程 100）。
 */

export const VERSION = 'v4.7'

// 档位标签（v4.6：原 zeta 阻尼系数三档全程无人消费，纯装饰，已删）
export const DEFAULT_MODES = { fast: '快速响应', deep: '深度分析', conservative: '保守稳定' }

export const MODE_ORDER = ['fast', 'deep', 'conservative']

// 档位 → 稳定阀相对基线的收缩量（v4.6：原 MODE_LIMITS 5/4/3 **从未生效**——
// patch 的 maxToolCallsPerTurn 直接短路它，档位切换对阈值零影响，但告警文案仍印 5→4→3，
// 等于对模型说假话。改为相对基线的收缩量，档位才真有执行效果。对照第 5 章 控制装置参数选择）
export const MODE_VALVE = { fast: 0, deep: 5, conservative: 10 }

/** 稳定阀实际阈值（纯）：基线 − 档位收缩量，下限 5。基线 25 → fast 25 / deep 20 / conservative 15 */
export function valveFor(mode, base = 25) {
  const b = Number.isFinite(base) && base > 0 ? base : 25
  return Math.max(5, b - (MODE_VALVE[mode] ?? 0))
}

export const DEFAULT_FEEDFORWARD = [
  // v0.2.0（2026-10-14 规则收敛）：irreversible-write 拦截规则移交 dsh-approval-gate，
  // 本表默认清空；retry/timeout 类「放行+警告」规则由 cordis.patch.yml 按需配置。
  // 更早历史：network-unstable（git/npm/curl/wget/pnpm 拦截）已于 2026-08-18 移除；
  // 2026-08-20 周检扰动入库（插件加载失败 → systemd 重启风暴）落地为 dsh-web.service
  // ExecStartPre 启动前自检（~/.dsh/scripts/dsh_prestart_check.sh）。
]

/**
 * EMA 一阶递归滤波（P1-1，对照 15.11 递推滤波工程简化）：
 * pHat = (1-α)·pHat + α·delta；delta=1 失败 / 0 成功。
 */
export function ema(prev, delta, alpha = 0.2) {
  return (1 - alpha) * prev + alpha * delta
}

/**
 * 采样归一化的 EMA 增益（纯，v4.6 P1-7，对照第 7 章 采样系统：采样周期必须固定，
 * 否则离散控制律失效）。
 *
 * v4.3 的 adaptiveAlpha（连续失败时 α 从 0.15 跳到 0.5）已删除，理由有二：
 *   1) 实测共线性 100%——凡是 adaptive pHat 能触发升档的会话，全都先被「连续失败」
 *      触发过。大 α 把 pHat 顶到与 divergence 同一个尖峰上，两条判据信息完全重叠。
 *   2) 它掩盖了真正的问题：dtMs 实测 p50=218ms、p99=134s、max=3.2h，跨 5 个数量级，
 *      固定 α 在不同采样节奏下代表的时间常数根本不是一回事。
 *
 * 改为按 Δt 幂律归一：a = 1-(1-α₀)^(Δt/Δt₀)，钳在 [α₀/5, 0.9]。
 * Δt₀ 取实测中位采样周期 250ms ⇒ 常规会话行为与旧版持平，只有长耗时调用才被正确加权。
 * Δt 缺失（首样本/日志回放）退化为 α₀。
 */
export function emaAlphaFor(dtMs, { alpha0 = 0.15, dt0 = 250, max = 0.5 } = {}) {
  if (!Number.isFinite(dtMs) || dtMs <= 0) return alpha0
  const a = 1 - Math.pow(1 - alpha0, dtMs / dt0)
  return Math.min(max, Math.max(alpha0 / 5, a))
}

/** 取工具结果里的纯文本内容（错误码标记、bash 退出码都藏在里面） */
export function textContentOf(result) {
  const c = result?.content
  if (!Array.isArray(c)) return ''
  return c
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')
}

// ---------- P0-1 误差信号补盲：bash 非零退出码 ----------
// bash 的 spawn 错误/abort 才走 isError；命令自身失败（路径不存在、权限不足、python 抛错）
// 只是一行 `[exit code: N]` 标记，isError 仍为 false（dsh-tool-bash/lib/index.js:167）。
// 实测 9141 次 bash 调用：工具级失败 1.0%，命令级真失败 3.74%——占 60% 调用量的主力工具，
// 其主失败模式原控制回路完全看不见。
export const BASH_TOOLS = new Set(['bash', 'ops_bash'])

// 约定非零：这些命令用「无匹配」表达正常结果，退出码 1 不算失败
// （grep/diff 是实测里最常见的两类，占非零退出 388 次中的 46 次）
export const BENIGN_NONZERO_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'test', '[', 'find'])

/** 取命令串里最后一个简单命令的首 token（管道/&&/; 之后那段更可能是真正的判定源） */
export function firstCommandToken(command) {
  if (typeof command !== 'string' || command === '') return ''
  const parts = command.split(/\|\||&&|;|\|/)
  let toks = (parts[parts.length - 1] ?? '').trim().split(/\s+/).filter(Boolean)
  while (toks.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1) // 跳过 FOO=bar 前缀
  return toks[0] ?? ''
}

/**
 * 从工具参数文本里取出真正的命令串（纯）。
 * 运行期 execArgsText(exec) 给的是**参数 JSON**（`{"command":"grep -n x ."}`），
 * 不是裸命令——直接 tokenize 会把首 token 取成 `{"command":"grep`，
 * 让「grep 无匹配」的约定非零豁免在真实链路上永远失效（本机 43 次 grep 退出 1 会被误判成失败）。
 */
export function commandTextOf(argsText) {
  if (typeof argsText !== 'string') return ''
  const t = argsText.trim()
  if (!t.startsWith('{')) return t
  try {
    const o = JSON.parse(t)
    if (typeof o?.command === 'string') return o.command
    if (typeof o?.cmd === 'string') return o.cmd
  } catch { /* 非 JSON 就按原文处理 */ }
  return t
}

/**
 * bash 退出码判失败（纯）。返回 { failed, benign, token, code }。
 * 判据分两级：非零 → 看首 token 是否属约定非零命令；属则 benign=true（记观测不记失败）。
 * argsText 接受参数 JSON 或裸命令串两种形态。
 */
export function bashExitDelta(exitCode, argsText) {
  const code = Number.isFinite(exitCode) ? exitCode : 0
  if (code === 0) return { failed: false, benign: false, token: '', code: 0 }
  const token = firstCommandToken(commandTextOf(argsText))
  const benign = code === 1 && BENIGN_NONZERO_COMMANDS.has(token)
  return { failed: !benign, benign, token, code }
}

/**
 * 熵告警门控（纯，v4.6 P1-4）：工具分布熵低本身不是问题——批量读文件、连续跑命令
 * 都是「专注」，熵天然低。实测 202 次熵告警里只有 12.1% 同期真有发散或振荡，
 * 88% 是噪声（每条都要注入一段上下文，还打断注意力）。
 * 改为需要旁证：同期出现冗余调用 / 发散 / 振荡，才认为低熵是「循环/偏执」。
 */
export function entropyGatePure({ redundantCalls = 0, divergence = false, oscillation = false } = {}) {
  return redundantCalls > 0 || divergence === true || oscillation === true
}

/**
 * 振荡检测（纯）：窗口内 0/1 翻转率 ≥ ratio 判振荡（P1-2，对照 7.3 周期运动稳定性）。
 * 与发散（连续失败）区分：振荡要"降耦合"，发散要"查根因"。
 */
export function detectOscillationPure(buf, ratio = 0.7) {
  if (!Array.isArray(buf) || buf.length < 6) return false
  let flips = 0
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] !== buf[i - 1]) flips++
  }
  return flips / (buf.length - 1) >= ratio
}

/**
 * 滞环控制律（纯，P0-1 负反馈 + 滞环防抖；v4.3 发散直通升档 + 升档对称防抖）：
 * 输入当前 pHat/档位/降档防抖/升档防抖/发散计数 → 输出目标档位与迁移标记。不产生副作用，
 * 是否写日志/发警告由调用方决定。
 *
 * v4.3 修订（对照实测）：
 *  - 发散（连续失败 divergenceStreak ≥ 阈值）是强信号，直接升档，不依赖 pHat——
 *    修复"连续失败告警了但 pHat 卡在 0.488 推不动档位"的解耦缺陷。
 *  - 升档加对称防抖（escalateStreak ≥ 阈值才升）——修复"突发失败→瞬间升到顶→快速降回"的档位抖动。
 *
 * v4.6 标定：escalateAt 0.6 → 0.20。实测（309 会话/15096 样本，含 bash 退出码）：
 *   旧 0.6 在 17 天里 0 次触发——pHat 会话末值 p90=0.016、max=0.111，阈值离分布 5 倍余量；
 *   0.20 时约 19.4% 会话会升档，其中 12% 属「无连续失败突发、但失败率持续 8%+」的真劣化，
 *   这是 divergence 抓不到的独立信息。阈值再降到 0.10 则 40% 会话升档，退化为噪声。
 *
 * 返回 { autoMode, deescalateStreak, escalateStreak, escalated, deescalated }
 */
export function adjustControlPure({ pHat, autoMode, deescalateStreak = 0, escalateStreak = 0, divergenceStreak = 0, control }) {
  const {
    escalateAt = 0.2,
    deescalateAt = 0.15,
    deescalateStreak: dsReq = 5,
    escalateStreak: esReq = 3,
    divergenceStreak: divReq = 3,
  } = control
  let next = autoMode
  let newDs = deescalateStreak
  let newEs = escalateStreak
  let escalated = false
  let deescalated = false

  const divergent = divergenceStreak >= divReq // 发散：连续失败，强信号
  const phHigh = pHat >= escalateAt            // 失败率高
  const phLow = pHat <= deescalateAt           // 失败率低

  if (autoMode !== 'conservative' && (divergent || phHigh)) {
    newDs = 0
    // 发散直接升档（连续失败 divReq 次本身即是防抖）；pHat 高需连续 esReq 次防抖
    if (divergent || newEs + 1 >= esReq) {
      next = MODE_ORDER[Math.min(MODE_ORDER.indexOf(autoMode) + 1, MODE_ORDER.length - 1)]
      escalated = true
      newEs = 0
    } else {
      newEs += 1
    }
  } else if (autoMode !== 'fast' && phLow) {
    newEs = 0
    newDs += 1
    if (newDs >= dsReq) {
      next = MODE_ORDER[Math.max(MODE_ORDER.indexOf(autoMode) - 1, 0)]
      deescalated = true
      newDs = 0
    }
  } else {
    newEs = 0
    newDs = 0
  }
  return { autoMode: next, deescalateStreak: newDs, escalateStreak: newEs, escalated, deescalated }
}

/** 参数文本提取（A1）：rc.6 参数字段为 arguments，兼容旧字段名 args 兜底 */
export function execArgsText(exec) {
  try {
    const raw = exec?.arguments ?? exec?.args ?? ''
    return typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    return ''
  }
}

/** 稳定的对象序列化（键排序），供冗余 hash / 去重使用 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/**
 * 冗余调用 hash（A1 修复）：
 * 旧实现用 exec?.args（rc.6 中恒为 undefined）→ hash 退化为「工具名|''」，
 * 同一工具的所有调用都被判为"同参数重复"→ 假冗余刷屏。
 * 修复：hash 基于参数文本（execArgsText，arguments 优先）。
 */
export function redundantHash(toolName, exec) {
  return `${toolName}|${stableStringify(execArgsText(exec))}`
}

/** 工具分布香农熵（纯，P2 对照 20.2）：calls: [{ tool }]；0=单一化，log2(n)=均匀 */
export function computeEntropyPure(calls) {
  const counts = new Map()
  for (const c of calls) counts.set(c.tool, (counts.get(c.tool) ?? 0) + 1)
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (!total) return 0
  const h = -[...counts.values()].reduce((acc, n) => {
    const p = n / total
    return acc + (p > 0 ? p * Math.log2(p) : 0)
  }, 0)
  return h === 0 ? 0 : h // 单一工具时结果为 -0，规范为 +0
}

/**
 * 健康评分（v4.7，窗口级 + 按工具基线归一）——替换 C13 的会话级公式。
 *
 * 旧公式的致命处：`(1-pHat)*100` 在**会话级**评分。实测 309 个会话里失败率中位数是 0，
 * 于是这个分数长期钉在 100（167 个会话末值 p50≈0、p90=0.016），既不能说好也不能说坏，
 * 属 AGENTS 点名要警惕的「必饱和派生指标」。问题不在常数，在层级：
 * 单个会话太短、非黑即白；跨会话 300 次的窗口才有分布。
 *
 * 新口径：
 *   ① 在**跨会话滚动窗口**（默认 300 次调用）上算观测失败率；
 *   ② 与该窗口内各工具的实测基线加权比较——bash 天生 3.7% 失败、edit 14.3%，
 *      若一视同仁，分数只反映工具配比，不反映系统状态；
 *   ③ ratio = 观测/基线：1.0 记 80 分，0 记 100，2 倍记 40，3 倍记 0（分段线性）；
 *   ④ 再扣未配对调用（真观测缺口）、冗余率，发散/振荡各 5 分。
 */
export const TOOL_BASELINE = {
  bash: { rate: 0.037, n: 9141 },      // 含命令级退出码口径（实测 342/9141）
  read: { rate: 0.010, n: 1785 },
  edit: { rate: 0.143, n: 1297 },      // FS_NOT_OBSERVED / FS_STALE_VERSION 集中在 edit
  write: { rate: 0.051, n: 646 },
  web_fetch: { rate: 0.160, n: 231 },
  subagent: { rate: 0.575, n: 73 },    // 样本不足，走下面的兜底
}
export const DEFAULT_BASELINE_RATE = 0.056 // 全局实测 5.6%（15096 样本）
export const BASELINE_MIN_SAMPLES = 300    // 样本不足不拿它当基线（p≈0.1 时 300 次的相对标准误约 5%）

/** 某工具的有效基线（纯）：样本不足回落全局基线 */
export function baselineRateOf(tool, table = TOOL_BASELINE) {
  const b = table[tool]
  return b && b.n >= BASELINE_MIN_SAMPLES ? b.rate : DEFAULT_BASELINE_RATE
}

/**
 * 窗口级健康分（纯）。window: [{ tool, failed }]，返回 { score, n, fails, observed, expected, ratio }。
 * 样本为空时 score=null——「没有观测」不等于「健康」，不默认满分。
 */
export function healthWindowPure({ window = [], redundantRate = 0, unpairedRate = 0, divergence = false, oscillation = false } = {}) {
  const n = window.length
  if (!n) return { score: null, n: 0, fails: 0, observed: 0, expected: 0, ratio: 0 }
  const fails = window.reduce((a, w) => a + (w && w.failed ? 1 : 0), 0)
  const observed = fails / n
  const expected = window.reduce((a, w) => a + baselineRateOf(w && w.tool), 0) / n
  const ratio = expected > 0 ? observed / expected : 0
  let score = ratio <= 1 ? 100 - 20 * ratio : Math.max(0, 80 - 40 * (ratio - 1))
  score -= Math.min(1, Math.max(0, Number.isFinite(unpairedRate) ? unpairedRate : 0)) * 10
  score -= Math.min(1, Math.max(0, Number.isFinite(redundantRate) ? redundantRate : 0)) * 10
  if (divergence) score -= 5
  if (oscillation) score -= 5
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    n,
    fails,
    observed,
    expected,
    ratio,
  }
}

/**
 * 工具失败归类（纯，2026-08-19 方案 B：给周检装"显微镜"）。
 * 输入 tools/result 的 result payload（dsh-tools 结构）：
 *   错误: { isError: true, error: { message, info?: { name, code } } }
 *   info.code 来自 HarnessError 子类（如 FsError 的 FS_EDIT_NOT_FOUND / FS_AMBIGUOUS_EDIT / FS_SANDBOX_DENIED）。
 * 返回 { errorType, errMsg } 或 null（成功时）。errMsg 截断 120 字符防日志膨胀。
 */
export function classifyToolError(result, maxMsg = 120) {
  if (!result || result.isError !== true) return null
  const error = result.error ?? {}
  const info = error.info ?? {}
  const message = typeof error.message === 'string' ? error.message : ''
  const code = typeof info.code === 'string' ? info.code : ''
  // 1) 有结构化 code（FsError/HarnessError）→ 直接使用
  if (code) {
    return { errorType: code, errMsg: message.length > maxMsg ? message.slice(0, maxMsg) + '…' : message }
  }
  // 2) 无 code：按消息模式归类到粗类
  const lower = message.toLowerCase()
  const patterns = [
    ['sandbox-denied', /sandbox|denied|permission/i],
    ['not-found', /does not exist|not found|enoent/i],
    ['edit-no-match', /did not appear verbatim|no replacement was performed/i],
    ['edit-ambiguous', /multiple occurrences|not unique|ambiguous/i],
    ['network', /econn|etimedout|network|socket/i],
    ['param-invalid', /required|must be|invalid/i],
    ['timeout', /timeout|timed out/i],
  ]
  for (const [type, re] of patterns) {
    if (re.test(lower)) return { errorType: type, errMsg: message.length > maxMsg ? message.slice(0, maxMsg) + '…' : message }
  }
  return { errorType: 'other', errMsg: message.length > maxMsg ? message.slice(0, maxMsg) + '…' : message }
}
