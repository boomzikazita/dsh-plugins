/**
 * dsh-cybernetics core — 共享纯函数（v5.0）
 *
 * v5.0（2026-11-08）重构：删除 v4.x 的 EMA/pHat、档位机、稳定阀、熵、振荡、
 * healthScore、adaptiveAlpha 等动力系统组件。理由见 README 与《工程控制论》：
 * agent 的工具调用是离散逻辑序列（第十七章），不是有运动方程的受控对象（第一至十五章），
 * 工具失败是可靠性问题（第十九章），跨会话是协调问题（第二十一章）。
 * 本文件只保留与平台无关的纯工具函数。
 *
 * 保留：bash 退出码解析（误差信号不能只看 isError）、参数文本提取、稳定序列化、
 * 冗余 hash、文本内容提取。
 */

export const VERSION = 'v5.0'

/** bash 类工具（命令级退出码需要单独解析，见 bashExitDelta） */
export const BASH_TOOLS = new Set(['bash', 'ops_bash'])

/** 约定非零：这些命令用「无匹配」表达正常结果，退出码 1 不算失败 */
export const BENIGN_NONZERO_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'diff', 'cmp', 'test', '[', 'find'])

/** 取工具结果里的纯文本内容（错误码标记、bash 退出码都藏在里面） */
export function textContentOf(result) {
  const c = result?.content
  if (!Array.isArray(c)) return ''
  return c
    .map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('')
}

/** 取命令串里最后一个简单命令的首 token（管道/&&/; 之后那段更可能是真正的判定源） */
export function firstCommandToken(command) {
  if (typeof command !== 'string' || command === '') return ''
  const parts = command.split(/\|\||&&|;|\|/)
  let toks = (parts[parts.length - 1] ?? '').trim().split(/\s+/).filter(Boolean)
  while (toks.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0])) toks = toks.slice(1) // 跳过 FOO=bar 前缀
  return toks[0] ?? ''
}

/** 从工具参数文本里取出真正的命令串（运行期参数是 JSON：{"command":"grep -n x ."}） */
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
 * bash 退出码判失败。返回 { failed, benign, token, code }。
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

/** 参数文本提取：运行期字段为 arguments，兼容旧字段名 args */
export function execArgsText(exec) {
  try {
    const raw = exec?.arguments ?? exec?.args ?? ''
    return typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    return ''
  }
}

/** 稳定的对象序列化（键排序），供重复调用 hash 使用 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** 调用签名（同工具+同参数）：重复调用告警与浪费重试统计的依据 */
export function callSignature(toolName, exec) {
  return `${toolName}|${stableStringify(execArgsText(exec))}`
}
