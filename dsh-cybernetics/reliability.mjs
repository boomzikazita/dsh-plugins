/**
 * dsh-cybernetics — 可靠性层（对照《工程控制论》第十九章：冗余技术和容错系统）
 *
 * 第十九章给的两件工具正好适用于 agent 运维：
 *   1) 可靠性定义：元件在 [0,t] 内正常工作的概率 R(t)=e^{-λt}，平均故障间隔 T=1/λ。
 *      对工具调用，"时间"离散化为调用次数：λ̂ = 失败次数/调用次数，MTBF = 调用次数/失败次数。
 *   2) 冗余：k/N 冗余下系统可靠性 P_{k/N}=Σ C(N,i) R^i (1-R)^{N-i}。
 *      对 agent，重试就是冗余：N=1+budget 次尝试全失败才失败 ⇒ 上限 1-(1-R)^N。
 *      但重试只对"暂态故障"有效；确定性故障（沙箱拒绝/参数非法）重试同一调用 100% 再失败，
 *      所以这里算的是**可恢复上限**，且只按暂态故障份额计。
 *
 * 由此取代旧的 healthScore / pHat：不再造一个 0-100 的综合分（§1.7 末尾自己说
 * 指标相互矛盾、没有放之四海而皆准的配方），只报可指导动作的量：
 *   λ + 95% 置信区间、MTBF、故障类型构成、重试可恢复上限、浪费重试数。
 */

export const RELIABILITY_VERSION = 'r1'

export const FAULT_KINDS = ['transient', 'deterministic', 'agent', 'fatal', 'unknown']

// 每个工具允许的连续重试预算（只是策略口径，插件不强制；用于报告"预算内可恢复上限"）
export const DEFAULT_RETRY_BUDGET = {
  bash: 2,
  read: 1,
  edit: 1,
  write: 0,
  web_fetch: 2,
  default: 1,
}

const FATAL_RE = /transported|abort|enospc|enomem|\beio\b|out of memory|disk full/i
const DETERMINISTIC_RE = /sandbox|denied|eacces|eperm|permission|invalid|must be|required|unknown tool|unsupported|read-only file system|enoent|no such file/i
const AGENT_RE = /not observed|stale|verbatim|no replacement|multiple occurrences|ambiguous|did not appear|fs_edit|fs_ambiguous|fs_not_observed|fs_stale/i
const TRANSIENT_RE = /timeout|timed out|econnreset|econnrefused|econnaborted|epipe|network|socket|temporar|rate limit|429|eagain/i

/** 结构化错误码优先，其次按消息归类 */
export function classifyFault(result, maxMsg = 120) {
  if (!result || result.isError !== true) return null
  const error = result.error ?? {}
  const info = error.info ?? {}
  const code = typeof info.code === 'string' ? info.code : ''
  const message = typeof error.message === 'string' ? error.message : ''
  const hay = `${code} ${message}`
  let kind = 'unknown'
  if (FATAL_RE.test(hay)) kind = 'fatal'
  else if (DETERMINISTIC_RE.test(hay)) kind = 'deterministic'
  else if (AGENT_RE.test(hay)) kind = 'agent'
  else if (TRANSIENT_RE.test(hay)) kind = 'transient'
  const errMsg = message.length > maxMsg ? message.slice(0, maxMsg) + '…' : message
  return { kind, code: code || null, errorType: code || kind, errMsg }
}

/** bash 非零退出码 → 归类：约定非零为 benign（grep 无匹配等），其余按命令判断 */
export function classifyBashExit({ code, benign, token }) {
  if (!Number.isFinite(code) || code === 0) return null
  if (benign) return null
  // 127=命令不存在、126=不可执行：确定性（重试同命令不会变）
  if (code === 127 || code === 126) return { kind: 'deterministic', code: `exit-${code}`, token: token || '' }
  // 124=timeout 命令、137=被 kill：暂态
  if (code === 124 || code === 137) return { kind: 'transient', code: `exit-${code}`, token: token || '' }
  return { kind: 'unknown', code: `exit-${code}`, token: token || '' }
}

function zeroKinds() {
  const o = {}
  for (const k of FAULT_KINDS) o[k] = 0
  return o
}

export function createReliability() {
  return { n: 0, k: 0, perTool: new Map(), kinds: zeroKinds(), wastedRetries: 0 }
}

/** 记录一次结果（就地更新可靠性计数器）。kind 对成功传 null */
export function recordResult(rel, tool, failed, kind) {
  const t = tool || 'unknown'
  let e = rel.perTool.get(t)
  if (!e) {
    e = { n: 0, k: 0, kinds: zeroKinds() }
    rel.perTool.set(t, e)
  }
  rel.n += 1
  e.n += 1
  if (failed) {
    rel.k += 1
    e.k += 1
    const kk = FAULT_KINDS.includes(kind) ? kind : 'unknown'
    rel.kinds[kk] += 1
    e.kinds[kk] += 1
  }
  return e
}

/** Wilson 95% 置信区间（失败率）。小样本下比正态近似可靠，且天然落在 [0,1] */
export function wilsonInterval(k, n, z = 1.96) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return { p: 0, lo: 0, hi: 0 }
  const p = Math.min(1, Math.max(0, k / n))
  const den = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / den
  const half = (z / den) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  // 端点吸附：浮点误差会给出 0.9999999999999999，报告里应显示 100%
  const snap = (x) => (x < 1e-12 ? 0 : x > 1 - 1e-12 ? 1 : x)
  return { p, lo: snap(Math.max(0, center - half)), hi: snap(Math.min(1, center + half)) }
}

/** 可靠性估计：失败率 + 区间 + MTBF（调用次数/失败一次） */
export function rateEstimate(k, n, z = 1.96) {
  const w = wilsonInterval(k, n, z)
  return {
    n,
    k,
    rate: w.p,
    lo: w.lo,
    hi: w.hi,
    mtbf: k > 0 ? n / k : null,
  }
}

/**
 * 重试可恢复上限（第十九章 k/N 冗余的工程化，N=1+budget）：
 * 只有暂态故障能靠"同一调用再试一次"恢复，确定性/可纠正/致命故障不能。
 * 返回 P(recover) ≤ 1-(1-λ_transient)^budget，仅作上限，不当预测。
 */
export function retryRecoveryBound(rate, transientShare, budget) {
  const b = Math.max(0, Math.floor(Number(budget) || 0))
  if (b === 0 || !Number.isFinite(rate) || rate <= 0) return 0
  const share = Math.max(0, Math.min(1, Number(transientShare) || 0))
  const lambdaT = rate * share
  if (lambdaT <= 0) return 0
  return 1 - Math.pow(1 - lambdaT, b)
}

export function retryBudgetOf(tool, budget = DEFAULT_RETRY_BUDGET) {
  const b = budget && typeof budget === 'object' ? budget : DEFAULT_RETRY_BUDGET
  return Number.isFinite(b[tool]) ? b[tool] : Number.isFinite(b.default) ? b.default : 1
}

// 旧日志（v4 时代）没有 kind 字段，只有 errorType / exitCode。回放时不要一律判"未归类"，
// 否则历史样本会把故障构成统计拖成 100% unknown。
const LEGACY_TYPE_MAP = {
  'sandbox-denied': 'deterministic',
  'not-found': 'deterministic',
  'param-invalid': 'deterministic',
  'edit-no-match': 'agent',
  'edit-ambiguous': 'agent',
  'FS_EDIT_NOT_FOUND': 'agent',
  'FS_AMBIGUOUS_EDIT': 'agent',
  'FS_NOT_OBSERVED': 'agent',
  'FS_STALE_VERSION': 'agent',
  network: 'transient',
  timeout: 'transient',
}

/** 从旧格式日志行推导故障类型（回放/rollup 兼容用） */
export function kindFromLegacy(e) {
  if (!e) return 'unknown'
  if (FAULT_KINDS.includes(e.kind)) return e.kind
  if (Number.isFinite(e.exitCode) && e.exitCode !== 0 && !e.exitBenign) {
    const c = classifyBashExit({ code: e.exitCode, benign: false, token: e.cmd })
    return c?.kind ?? 'unknown'
  }
  if (typeof e.errorType === 'string') {
    if (LEGACY_TYPE_MAP[e.errorType]) return LEGACY_TYPE_MAP[e.errorType]
    if (FAULT_KINDS.includes(e.errorType)) return e.errorType
  }
  return 'unknown'
}

function fmtPct(x, digits = 1) {
  return `${(x * 100).toFixed(digits)}%`
}

function fmtCI(lo, hi) {
  return `[${fmtPct(lo)}, ${fmtPct(hi)}]`
}

/** 单工具可靠性行（status/rollup 共用） */
export function toolLine(tool, est, { budget } = {}) {
  const b = retryBudgetOf(tool, budget)
  const mtbf = est.mtbf == null ? '—' : est.mtbf.toFixed(1)
  const base = `${tool}  n=${est.n}  λ=${fmtPct(est.rate)} ${fmtCI(est.lo, est.hi)}  MTBF=${mtbf}次/失败`
  const kinds = est.kinds || zeroKinds()
  const total = Object.values(kinds).reduce((a, b) => a + b, 0)
  if (!est.k || total === 0) return `${base}  无失败`
  const share = (k) => (kinds[k] / total) * 100
  const unknownOnly = kinds.unknown === total
  const recover = unknownOnly
    ? '—（未归类，无法估计）'
    : kinds.transient === 0
      ? '0%（无暂态故障，重试无收益）'
      : fmtPct(retryRecoveryBound(est.rate, kinds.transient / total, b))
  return `${base}  类型: 暂态${share('transient').toFixed(0)}% 确定${share('deterministic').toFixed(0)}% 可纠${share('agent').toFixed(0)}% 致命${share('fatal').toFixed(0)}%` +
    `  重试预算=${b} 可恢复上限=${recover}`
}

/** 从可靠性计数器生成按工具的估计列表（按 λ 降序，n≥minSamples 优先） */
export function toolEstimates(rel, { minSamples = 5, limit = 8 } = {}) {
  const rows = []
  for (const [tool, e] of rel.perTool.entries()) {
    if (e.n < minSamples) continue
    const est = rateEstimate(e.k, e.n)
    est.tool = tool
    est.kinds = e.kinds
    rows.push(est)
  }
  rows.sort((a, b) => b.rate - a.rate || b.n - a.n)
  return rows.slice(0, limit)
}

/**
 * 跨会话汇总（第二十一章：大系统的多级结构——下层自治、上层汇总）。
 * 输入是 NDJSON 解析后的记录数组；兼容旧格式（delta / pHat 时代）。
 * 返回纯数据对象，格式化交给调用方（工具/脚本）。
 */
export function rollupRecords(records, { since = 0, now = Date.now() } = {}) {
  const rs = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object')
  const window = rs.filter((r) => (r.ts ?? 0) >= since)
  const rel = createReliability()
  const alarms = {}
  const sessions = new Set()
  let pre = 0
  let res = 0
  let wasted = 0
  const slow = new Map()
  const perSession = new Map()

  for (const e of window) {
    if (e.sid) sessions.add(e.sid)
    if (e.event === 'pre-execute') {
      pre += 1
      continue
    }
    if (e.event === 'wasted-retry') {
      wasted += 1
      continue
    }
    if (e.event === 'alarm') {
      alarms[e.code] = (alarms[e.code] ?? 0) + 1
      continue
    }
    if (e.event !== 'result') continue
    res += 1
    const tool = e.tool || 'unknown'
    // 兼容：新格式 failed/kind；旧格式 delta
    const failed = e.failed === true || e.delta === 1
    const kind = failed ? kindFromLegacy(e) : null
    recordResult(rel, tool, failed, kind)
    const sid = e.sid || 'unknown'
    const ps = perSession.get(sid) ?? { sid, n: 0, k: 0 }
    ps.n += 1
    if (failed) ps.k += 1
    perSession.set(sid, ps)
    if (Number.isFinite(e.dtMs)) {
      const d = slow.get(tool) ?? { total: 0, count: 0 }
      d.total += e.dtMs
      d.count += 1
      slow.set(tool, d)
    }
  }

  const slowest = [...slow.entries()]
    .map(([tool, d]) => ({ tool, avgMs: Math.round(d.total / Math.max(1, d.count)), count: d.count }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 5)

  return {
    since,
    now,
    sessions: sessions.size,
    pre,
    res,
    unpaired: Math.max(0, pre - res),
    rel,
    alarms,
    wastedRetries: wasted,
    slowest,
    perSession: [...perSession.values()].sort((a, b) => b.n - a.n),
  }
}
