// dsh-cybernetics — 会话状态构造 / 注入消息工厂（v5.0）
//
// 会话状态只保留"本会话事实"：计数、本 turn 的写入/回读、逻辑状态机、待注入告警。
// 不再有 pHat / 档位 / 熵窗口 / 振荡缓冲 —— 这些属于被删除的动力系统层。
import { randomUUID } from 'node:crypto'
import { createLogicState } from './logic.mjs'

/** 注入消息工厂：优先宿主 @deepseek-ai/dsh-llm 的 createUserMessage；解析不到时用等价形态兜底 */
let _createUserMessage = null // null=未探测 / function=宿主工厂 / false=不可用
let _injectFactoryWarned = false
export async function makeInjectedUserMessage({ text, kind }) {
  const content = [{ type: 'text', text }]
  if (_createUserMessage === null) {
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      _createUserMessage = typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : false
    } catch {
      _createUserMessage = false
    }
  }
  if (typeof _createUserMessage === 'function') {
    return _createUserMessage({ content, source: { kind } })
  }
  if (!_injectFactoryWarned) {
    _injectFactoryWarned = true
    console.warn('[dsh-cybernetics] @deepseek-ai/dsh-llm 不可解析，注入消息走等价兜底形态')
  }
  return Object.freeze({ id: randomUUID(), role: 'user', content, source: { kind } })
}

export function createSessionState(sid) {
  return {
    sid,
    createdAt: Date.now(),
    currentTurn: null,
    toolCallsInTurn: 0,
    preExecCount: 0,
    resultCount: 0,
    logic: createLogicState(),
    pendingWarns: [],        // 待注入告警（agent/pre-step 消费，合并成一条 user 消息）
    alarmsInjected: 0,       // 本会话累计注入的告警条数
    wastedRetries: 0,        // 本会话"确定性/致命失败后又原样重试"的次数
    toolDurations: new Map(), // tool → { totalMs, count }
    sessionObserved: new Set(),
    lastStartTs: 0,
    lastStartTool: '',
    lastCall: null,          // { sig, tool, failed, kind, nonRetryable, ts }
    turnWrites: [],          // verify-on-stop：本 turn 写入调用
    turnVerifies: 0,         // verify-on-stop：本 turn 回读调用
    sandboxMode: null,       // 本插件切过的沙箱档位（提权判定用；null=未知）
  }
}
