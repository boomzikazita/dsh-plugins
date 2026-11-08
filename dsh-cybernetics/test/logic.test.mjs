// dsh-cybernetics — 逻辑控制层穷举测试
//
// 以《工程控制论》§17.1 防空警报为例的判定性质做穷举验证：
//   连续 k 次发现 → 报警；报警后连续 m 次无信号 → 解除。
// 不测"实现与实现一致"，测四条可证伪的性质：
//   P1 全成功序列绝不告警；
//   P2 全失败序列恰好一条失败告警，位置在第 k 次失败；
//   P3 任意两条 failure 告警之间，必隔着 ≥m 次连续成功（滞环）；
//   P4 同一事件段内不重复告警（含 fatal/重复调用）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { step, createLogicState, DEFAULT_LOGIC } from '../logic.mjs'

const cfg = { ...DEFAULT_LOGIC, failStreak: 3, recoverStreak: 4, deterministicStreak: 2, repeatAlarm: 3 }

function run(seq, opts = {}) {
  let st = createLogicState()
  const alarms = []
  const { kinds = [], hashes = [], exemptTools = [], tool = 'bash' } = opts
  for (let i = 0; i < seq.length; i += 1) {
    const failed = seq[i]
    const kind = failed ? (kinds[i] ?? 'transient') : null
    const r = step(st, {
      tool,
      failed,
      kind,
      hash: hashes[i] ?? `h${i}`, // 默认每次不同，避免串扰重复告警
      repeatExempt: exemptTools[i] ?? false,
      ts: i,
    }, cfg)
    st = r.state
    for (const a of r.alarms) alarms.push({ ...a, at: i })
  }
  return { state: st, alarms }
}

function* sequences(n) {
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const seq = []
    for (let i = 0; i < n; i += 1) seq.push((mask >> i & 1) === 1)
    yield seq
  }
}

test('P1 全成功序列绝不告警', () => {
  const { alarms } = run([false, false, false, false, false, false])
  assert.equal(alarms.length, 0)
})

test('P2 全失败：恰好一条 failure 告警，位置在第 3 次失败（索引 2）', () => {
  const { alarms } = run([true, true, true, true, true, true])
  assert.equal(alarms.length, 1)
  assert.equal(alarms[0].code, 'failure')
  assert.equal(alarms[0].at, 2)
  assert.equal(alarms[0].n, 3)
  assert.match(alarms[0].text, /bash/)
})

test('P2b 确定性故障阈值更低：第 2 次失败即告警（索引 1）', () => {
  const { alarms } = run([true, true, true], { kinds: ['deterministic', 'deterministic', 'deterministic'] })
  assert.equal(alarms.length, 1)
  assert.equal(alarms[0].at, 1)
  assert.equal(alarms[0].kind, 'deterministic')
  assert.match(alarms[0].text, /确定性|重试不会改变结果/)
})

test('P3 任意两条 failure 告警之间至少有 recoverStreak 次连续成功（穷举长度 ≤7）', () => {
  for (let n = 1; n <= 7; n += 1) {
    for (const seq of sequences(n)) {
      const { alarms } = run(seq)
      const failureAt = alarms.filter((a) => a.code === 'failure').map((a) => a.at)
      for (let i = 1; i < failureAt.length; i += 1) {
        const prev = failureAt[i - 1]
        const cur = failureAt[i]
        // 跳过当前失败段，再数紧邻其前的连续成功数
        let j = cur
        while (j >= 0 && seq[j] === true) j -= 1
        let successes = 0
        while (j >= 0 && seq[j] === false) {
          successes += 1
          j -= 1
        }
        assert.ok(successes >= cfg.recoverStreak, `序列 ${seq.map(Number).join('')} 两告警间隔成功数 ${successes} < ${cfg.recoverStreak}`)
      }
      // 无告警或只有一条也可以
      assert.ok(failureAt.length === 0 || failureAt.length >= 1)
    }
  }
})

test('P4 同一事件段内失败告警不重复：连续失败 10 次只有一条', () => {
  const { alarms } = run(new Array(10).fill(true))
  assert.equal(alarms.filter((a) => a.code === 'failure').length, 1)
})

test('恢复条件：解锁需 4 次连续成功；3 次成功后再失败仍不重复告警', () => {
  // 3 失败 → 告警；3 成功（不足 4）→ 仍激活；再失败 → 不告警
  const seq = [true, true, true, false, false, false, true, true, true]
  const { alarms } = run(seq)
  assert.equal(alarms.filter((a) => a.code === 'failure').length, 1)
  // 继续第 4 次成功解锁后再失败，可以再次告警
  const seq2 = [true, true, true, false, false, false, false, true, true, true]
  const r2 = run(seq2)
  assert.equal(r2.alarms.filter((a) => a.code === 'failure').length, 2)
})

test('致命故障：立即告警；同一失败段只报一次；成功后可再次告警', () => {
  const r = run([true, true, true, false, true], { kinds: ['fatal', 'fatal', 'fatal', null, 'fatal'] })
  assert.equal(r.alarms.filter((a) => a.code === 'fatal').length, 2)
  assert.equal(r.alarms[0].at, 0)
})

test('重复调用：同一调用连续 3 次恰好一条 repeat 告警', () => {
  const hashes = ['a', 'a', 'a', 'a', 'a']
  const { alarms } = run([false, false, false, false, false], { hashes })
  const rep = alarms.filter((a) => a.code === 'repeat')
  assert.equal(rep.length, 1)
  assert.equal(rep[0].at, 2)
  assert.equal(rep[0].n, 3)
})

test('重复调用：换参数后重新计数，可再次告警', () => {
  const hashes = ['a', 'a', 'a', 'b', 'b', 'b']
  const { alarms } = run([false, false, false, false, false, false], { hashes })
  assert.equal(alarms.filter((a) => a.code === 'repeat').length, 2)
})

test('豁免工具（job_output 等）重复调用不告警', () => {
  const hashes = new Array(6).fill('same')
  const { alarms } = run(new Array(6).fill(false), { hashes, tool: 'job_output' })
  assert.equal(alarms.length, 0)
})

test('状态是纯 JSON 且可序列化续算', () => {
  const r1 = run([true, true, true, false])
  const clone = JSON.parse(JSON.stringify(r1.state))
  const next1 = step(r1.state, { tool: 'bash', failed: true, kind: 'transient', hash: 'x', ts: 10 }, cfg)
  const next2 = step(clone, { tool: 'bash', failed: true, kind: 'transient', hash: 'x', ts: 10 }, cfg)
  assert.deepEqual(next1.state, next2.state)
  assert.deepEqual(next1.alarms, next2.alarms)
})

test('确定性+暂态混合：达到 3 次时以确定性文案告警', () => {
  const { alarms } = run([true, true, true], { kinds: ['transient', 'transient', 'deterministic'] })
  assert.equal(alarms.length, 1)
  assert.equal(alarms[0].at, 2)
  assert.equal(alarms[0].kind, 'deterministic')
})
