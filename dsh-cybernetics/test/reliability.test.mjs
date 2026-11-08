// dsh-cybernetics — 可靠性层测试
// 对照第十九章：λ / MTBF / k-N 冗余上限；故障类型分类驱动"该不该重试"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  wilsonInterval,
  rateEstimate,
  retryRecoveryBound,
  retryBudgetOf,
  classifyFault,
  classifyBashExit,
  createReliability,
  recordResult,
  toolEstimates,
  toolLine,
  rollupRecords,
  DEFAULT_RETRY_BUDGET,
} from '../reliability.mjs'

test('Wilson 区间：0 失败时下限为 0，上限有限且合理', () => {
  const w = wilsonInterval(0, 100)
  assert.equal(w.p, 0)
  assert.equal(w.lo, 0)
  assert.ok(w.hi > 0.02 && w.hi < 0.06, `hi=${w.hi}`)
})

test('Wilson 区间：全失败时上限为 1，下限 < 1', () => {
  const w = wilsonInterval(100, 100)
  assert.equal(w.hi, 1)
  assert.ok(w.lo > 0.9 && w.lo < 1)
})

test('Wilson 区间：n=0 不抛错，返回全 0', () => {
  assert.deepEqual(wilsonInterval(0, 0), { p: 0, lo: 0, hi: 0 })
})

test('rateEstimate：λ=n/k 口径与 MTBF 口径一致', () => {
  const e = rateEstimate(3, 30)
  assert.equal(e.rate, 0.1)
  assert.equal(e.mtbf, 10)
  const none = rateEstimate(0, 10)
  assert.equal(none.mtbf, null)
  assert.ok(none.hi > 0 && none.hi < 0.3)
})

test('重试可恢复上限：budget=0 或非暂态份额为 0 时无收益', () => {
  assert.equal(retryRecoveryBound(0.2, 1, 0), 0)
  assert.equal(retryRecoveryBound(0.2, 0, 3), 0)
  assert.equal(retryRecoveryBound(0, 1, 3), 0)
})

test('重试可恢复上限：随预算单调增且 < 1', () => {
  const b1 = retryRecoveryBound(0.1, 1, 1)
  const b2 = retryRecoveryBound(0.1, 1, 2)
  const b3 = retryRecoveryBound(0.1, 1, 3)
  assert.ok(Math.abs(b1 - 0.1) < 1e-9)
  assert.ok(Math.abs(b2 - 0.19) < 1e-9)
  assert.ok(b3 > b2 && b3 < 1)
})

test('重试预算：工具专属优先，未知工具走 default', () => {
  assert.equal(retryBudgetOf('bash'), 2)
  assert.equal(retryBudgetOf('write'), 0)
  assert.equal(retryBudgetOf('nonexistent-tool'), 1)
  assert.equal(retryBudgetOf('bash', { bash: 5, default: 0 }), 5)
})

test('故障分类：确定性 / 可纠正 / 暂态 / 致命 / 未归类', () => {
  const sandbox = classifyFault({ isError: true, error: { message: 'Writing outside the workspace is blocked by sandbox', info: { code: 'FS_SANDBOX_DENIED' } } })
  assert.equal(sandbox.kind, 'deterministic')
  const edit = classifyFault({ isError: true, error: { message: 'The text to replace did not appear verbatim', info: { code: 'FS_EDIT_NOT_FOUND' } } })
  assert.equal(edit.kind, 'agent')
  const notObserved = classifyFault({ isError: true, error: { message: 'File has not been read in this session', info: { code: 'FS_NOT_OBSERVED' } } })
  assert.equal(notObserved.kind, 'agent')
  const timeout = classifyFault({ isError: true, error: { message: 'tool timed out after 30000ms', info: { code: 'ETIMEDOUT' } } })
  assert.equal(timeout.kind, 'transient')
  const enospc = classifyFault({ isError: true, error: { message: 'no space left on device', info: { code: 'ENOSPC' } } })
  assert.equal(enospc.kind, 'fatal')
  const invalid = classifyFault({ isError: true, error: { message: 'missing required parameter: goal', info: { code: 'INVALID_ARGUMENT' } } })
  assert.equal(invalid.kind, 'deterministic')
  const vague = classifyFault({ isError: true, error: { message: 'boom' } })
  assert.equal(vague.kind, 'unknown')
  assert.equal(classifyFault({ isError: false }), null)
})

test('bash 退出码分类：约定非零豁免、127 确定性、124 暂态', () => {
  assert.equal(classifyBashExit({ code: 1, benign: true }), null)
  assert.equal(classifyBashExit({ code: 0, benign: false }), null)
  assert.equal(classifyBashExit({ code: 127, benign: false, token: 'foo' }).kind, 'deterministic')
  assert.equal(classifyBashExit({ code: 124, benign: false }).kind, 'transient')
  assert.equal(classifyBashExit({ code: 2, benign: false }).kind, 'unknown')
})

test('recordResult：工具级与全局计数一致', () => {
  const rel = createReliability()
  recordResult(rel, 'bash', false, null)
  recordResult(rel, 'bash', true, 'deterministic')
  recordResult(rel, 'read', false, null)
  assert.equal(rel.n, 3)
  assert.equal(rel.k, 1)
  assert.equal(rel.kinds.deterministic, 1)
  assert.equal(rel.perTool.get('bash').n, 2)
  assert.equal(rel.perTool.get('bash').k, 1)
})

test('toolEstimates：样本不足被过滤，按 λ 降序，limit 生效', () => {
  const rel = createReliability()
  for (let i = 0; i < 10; i += 1) recordResult(rel, 'bash', i < 1, i < 1 ? 'transient' : null)
  for (let i = 0; i < 10; i += 1) recordResult(rel, 'edit', i < 5, i < 5 ? 'agent' : null)
  recordResult(rel, 'rare', true, 'fatal')
  const rows = toolEstimates(rel, { minSamples: 5, limit: 1 })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tool, 'edit')
  assert.equal(rows[0].rate, 0.5)
})

test('toolLine：包含 λ、区间、MTBF、类型构成与重试预算', () => {
  const rel = createReliability()
  for (let i = 0; i < 10; i += 1) recordResult(rel, 'bash', i < 2, i < 2 ? 'transient' : null)
  const est = toolEstimates(rel, { minSamples: 5 })[0]
  const line = toolLine('bash', est, { budget: DEFAULT_RETRY_BUDGET })
  assert.match(line, /λ=20\.0%/)
  assert.match(line, /MTBF=5\.0/)
  assert.match(line, /重试预算=2/)
  assert.match(line, /可恢复上限=/)
})

test('rollupRecords：窗口过滤、会话/未配对/告警/浪费重试/旧格式兼容', () => {
  const now = 1_000_000
  const records = [
    { ts: now - 10_000, event: 'pre-execute', sid: 's1', tool: 'bash' },
    { ts: now - 9_000, event: 'result', sid: 's1', tool: 'bash', failed: true, kind: 'transient' },
    { ts: now - 8_000, event: 'result', sid: 's1', tool: 'bash', failed: false },
    { ts: now - 7_000, event: 'result', sid: 's2', tool: 'read', failed: false },
    { ts: now - 6_000, event: 'alarm', sid: 's1', code: 'failure' },
    { ts: now - 5_000, event: 'wasted-retry', sid: 's1', tool: 'bash' },
    { ts: now - 4_000, event: 'result', sid: 's2', tool: 'edit', delta: 1 }, // 旧格式
    { ts: now - 3_000, event: 'result', sid: 's1', tool: 'bash', dtMs: 500 },
    { ts: now - 100_000, event: 'result', sid: 'old', tool: 'bash', failed: true, kind: 'fatal' }, // 窗口外
  ]
  const r = rollupRecords(records, { since: now - 20_000, now })
  assert.equal(r.sessions, 2)
  assert.equal(r.res, 5)
  assert.equal(r.pre, 1)
  assert.equal(r.unpaired, 0)
  assert.equal(r.rel.k, 2)
  assert.equal(r.rel.kinds.transient, 1)
  assert.equal(r.rel.kinds.unknown, 1)
  assert.equal(r.alarms.failure, 1)
  assert.equal(r.wastedRetries, 1)
  assert.equal(r.perSession.find((x) => x.sid === 's1').n, 3)
  assert.equal(r.slowest[0].tool, 'bash')
  assert.equal(r.slowest[0].avgMs, 500)
})

test('rollupRecords：未配对调用按 pre-res 计（不为负）', () => {
  const records = [
    { ts: 1, event: 'pre-execute', sid: 's1' },
    { ts: 2, event: 'pre-execute', sid: 's1' },
    { ts: 3, event: 'result', sid: 's1', tool: 'bash', failed: false },
  ]
  const r = rollupRecords(records, { since: 0, now: 10 })
  assert.equal(r.unpaired, 1)
})
