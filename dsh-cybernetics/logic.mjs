/**
 * dsh-cybernetics — 逻辑控制层（对照《工程控制论》第十七章：逻辑控制和有限自动机）
 *
 * 为什么不是 EMA/档位：agent 的工具调用是离散 0/1 序列（成功/失败、第几次重试），
 * 不是由微分方程描述的动力系统。第十七章说得很清楚：这类问题"前面各章内所述的
 * 原理和方法很少有所帮助"，分析工具是逻辑代数与时序逻辑（有限自动机）。
 * 第十七章 §17.1 的防空警报例子就是标准范式：
 *   "连续三次或三次以上搜索发现目标 → 报警；报警后连续四次或四次以上无信号 → 解除。"
 * 本文件把它实现为显式状态机：滞环、防重复、可穷举验证。
 *
 * 设计约定：
 *   1) 状态是纯 JSON，step() 无副作用、无时钟依赖（ts 只做记录），便于穷举测试；
 *   2) 告警由状态迁移产生，不在调用点临时判断；
 *   3) 同一告警在一次"事件段"内只注入一次（防 52 连跪那种单轮 51 次注入）；
 *   4) 故障分类（kind）决定阈值与文案：确定性故障（沙箱拒绝/参数非法）2 次即报，
 *      因为重试同样调用永远不会成功；暂态故障（超时/网络）3 次报。
 */

export const LOGIC_VERSION = 'l1'

export const FAULT_KINDS = ['transient', 'deterministic', 'agent', 'fatal', 'unknown']

export const DEFAULT_LOGIC = {
  // 连续失败达到该值报警（对照 §17.1：三次连续发现目标）
  failStreak: 3,
  // 连续成功达到该值解除报警（对照 §17.1：四次连续无信号）
  recoverStreak: 4,
  // 连续确定性失败（沙箱拒绝/参数非法/未知工具）的更低阈值：
  // 这类失败重试同样调用 100% 再失败，不必等 3 次
  deterministicStreak: 2,
  // 同一调用（同工具+同参数）连续重复达到该值报警
  repeatAlarm: 3,
  // 轮询/状态类工具不参与"重复调用"判定（重复调用是它们的正常用法）
  repeatExemptTools: ['job_output', 'job_kill', 'list_agents', 'todo_write', 'cybernetics_status', 'cybernetics_snap', 'cybernetics_rollup'],
}

function zeroKinds() {
  const o = {}
  for (const k of FAULT_KINDS) o[k] = 0
  return o
}

export function createLogicState() {
  return {
    v: LOGIC_VERSION,
    failStreak: 0,            // 当前连续失败次数
    failKinds: zeroKinds(),   // 当前失败段内各类型计数（判定用）
    alarmActive: false,       // 失败告警是否处于激活态（滞环状态）
    okStreak: 0,              // 激活态下连续成功次数（到 recoverStreak 解除）
    fatalAlarmed: false,      // 本次失败段是否已报过致命故障
    repeatHash: '',           // 当前连续相同调用签名
    repeatCount: 0,
    repeatAlarmed: false,
    alarmsTotal: 0,
    lastAlarmCode: null,
    lastAlarmTs: 0,
  }
}

/** 失败段的主导类型（用于告警文案）：确定性 > 致命 > 可纠正 > 暂态 > 未归类 */
export function dominantKind(kinds) {
  if (kinds.fatal > 0) return 'fatal'
  if (kinds.deterministic > 0) return 'deterministic'
  if (kinds.agent > 0) return 'agent'
  if (kinds.transient > 0) return 'transient'
  return 'unknown'
}

function failureText(kind, tool, n) {
  switch (kind) {
    case 'deterministic':
      return `[逻辑控制] 连续 ${n} 次确定性失败（${tool}：沙箱拒绝/权限/参数非法类）。同样的调用重试不会改变结果——改参数、换工具，或直接向用户说明卡点。`
    case 'transient':
      return `[逻辑控制] 连续 ${n} 次暂态失败（${tool}：超时/网络类）。可在预算内重试一次；再失败请换路或问用户。`
    case 'agent':
      return `[逻辑控制] 连续 ${n} 次调用需修正的失败（${tool}：编辑未匹配/未读先写等）。先修正调用（读目标、改匹配串）再重试，不要原样重放。`
    case 'fatal':
      return `[逻辑控制] 出现致命级故障（${tool}：进程/环境级）。继续调用无意义，请停止并向用户说明环境问题。`
    default:
      return `[逻辑控制] 连续 ${n} 次失败（${tool}，原因未归类）。先看错误信息，不要原样重试。`
  }
}

function repeatText(tool, n) {
  return `[逻辑控制] 同一调用（${tool}，参数未变）已连续重复 ${n} 次，结果不会改变。换方法或问用户，禁止原样重试。`
}

/**
 * 状态机一步。纯函数。
 * @param {object} state  createLogicState() 或上一步返回值
 * @param {object} obs    { tool, failed, kind, hash, repeatExempt, ts }
 * @param {object} cfg    逻辑配置（DEFAULT_LOGIC 覆盖项）
 * @returns {{state: object, alarms: Array<{code:string, tool:string, n:number, kind?:string, text:string}>}}
 */
export function step(state, obs, cfg = DEFAULT_LOGIC) {
  const c = { ...DEFAULT_LOGIC, ...cfg }
  const st = {
    ...createLogicState(),
    ...state,
    failKinds: { ...zeroKinds(), ...(state?.failKinds ?? {}) },
  }
  const alarms = []
  const ts = Number.isFinite(obs?.ts) ? obs.ts : 0
  const tool = obs?.tool || 'unknown'
  const kind = FAULT_KINDS.includes(obs?.kind) ? obs.kind : 'unknown'

  if (!obs?.failed) {
    // ---- 成功：清失败段，推进告警解除滞环 ----
    st.failStreak = 0
    st.failKinds = zeroKinds()
    st.fatalAlarmed = false
    if (st.alarmActive) {
      st.okStreak += 1
      if (st.okStreak >= c.recoverStreak) {
        st.alarmActive = false
        st.okStreak = 0
      }
    }
  } else {
    // ---- 失败：累计连续失败与类型分布 ----
    st.failStreak += 1
    st.failKinds[kind] += 1
    st.okStreak = 0

    const allDeterministic = st.failKinds.deterministic === st.failStreak
    const threshold = kind === 'fatal'
      ? 1
      : allDeterministic
        ? c.deterministicStreak
        : c.failStreak

    // 致命故障独立成报：不因已有告警而丢弃，但同一失败段只报一次
    if (kind === 'fatal' && !st.fatalAlarmed) {
      st.fatalAlarmed = true
      st.alarmActive = true
      st.okStreak = 0
      st.alarmsTotal += 1
      st.lastAlarmCode = 'fatal'
      st.lastAlarmTs = ts
      alarms.push({ code: 'fatal', tool, n: st.failStreak, kind, text: failureText('fatal', tool, st.failStreak) })
    } else if (!st.alarmActive && st.failStreak >= threshold) {
      const k = allDeterministic ? 'deterministic' : dominantKind(st.failKinds)
      st.alarmActive = true
      st.okStreak = 0
      st.alarmsTotal += 1
      st.lastAlarmCode = 'failure'
      st.lastAlarmTs = ts
      alarms.push({ code: 'failure', tool, n: st.failStreak, kind: k, text: failureText(k, tool, st.failStreak) })
    }
  }

  // ---- 重复调用告警（同工具+同参数连续重复，独立于成功/失败） ----
  if (c.repeatAlarm > 0 && obs?.hash) {
    const exempt = Array.isArray(c.repeatExemptTools) && c.repeatExemptTools.includes(tool)
    if (!exempt) {
      if (obs.hash === st.repeatHash) {
        st.repeatCount += 1
      } else {
        st.repeatHash = obs.hash
        st.repeatCount = 1
        st.repeatAlarmed = false
      }
      if (!st.repeatAlarmed && st.repeatCount >= c.repeatAlarm) {
        st.repeatAlarmed = true
        st.alarmsTotal += 1
        st.lastAlarmCode = 'repeat'
        st.lastAlarmTs = ts
        alarms.push({ code: 'repeat', tool, n: st.repeatCount, text: repeatText(tool, st.repeatCount) })
      }
    } else {
      // 豁免工具不参与重复判定，也不让它们打断别人的连续段
      st.repeatHash = ''
      st.repeatCount = 0
      st.repeatAlarmed = false
    }
  }

  return { state: st, alarms }
}
