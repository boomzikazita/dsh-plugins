/**
 * dsh-cybernetics core 单元测试（C12，node:test）
 * 运行：node --test test/*.test.mjs   （Node 22 下 `node --test test/` 会把目录当模块报 MODULE_NOT_FOUND）
 * 覆盖：EMA 滤波/采样归一、振荡检测、滞环控制律（升/降档 + 防抖）、
 *       A1 冗余 hash 回归、execArgsText 兼容、熵与熵门控、健康评分、
 *       稳定阀阈值、bash 退出码判失败、verify-on-stop 精度。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VERSION,
  MODE_ORDER,
  MODE_VALVE,
  valveFor,
  ema,
  emaAlphaFor,
  detectOscillationPure,
  adjustControlPure,
  execArgsText,
  redundantHash,
  stableStringify,
  computeEntropyPure,
  entropyGatePure,
  healthScorePure,
  classifyToolError,
  bashExitDelta,
  firstCommandToken,
  commandTextOf,
  textContentOf,
} from '../core.mjs'
import { makeControl } from '../control.mjs'
import { createSessionState } from '../state.mjs'

test('verify-on-stop（v4.6）：改既有文件无回读提醒；单次新建 not 提醒；回读静默', () => {
  const cfg = { control: { oscillationWindow: 10, oscillationRatio: 0.7 } }
  const { trackWriteVerify, verifyOnStopWarn } = makeControl({ cfg, state: {}, logState: () => {}, logFile: '/dev/null' })
  const s = createSessionState('t-verify-1')
  trackWriteVerify(s, 'edit')
  trackWriteVerify(s, 'bash') // bash 不计写入也不计回读
  assert.ok(verifyOnStopWarn(s)?.includes('verify-on-stop'), 'edit 无回读应提醒')
  trackWriteVerify(s, 'read')
  assert.equal(verifyOnStopWarn(s), null, '写入后回读应静默')
  const s2 = createSessionState('t-verify-2')
  trackWriteVerify(s2, 'grep')
  assert.equal(verifyOnStopWarn(s2), null, '纯回读不提醒')
  assert.equal(s2.turnWrites.length, 0)
  // v4.6 P1-8：单次 write（多为新建文件）不提醒；成批写入（≥2）仍提醒
  const s3 = createSessionState('t-verify-3')
  trackWriteVerify(s3, 'write')
  assert.equal(verifyOnStopWarn(s3), null, '单次新建不提醒（实测 49 次触达里 37 次属此类）')
  trackWriteVerify(s3, 'write')
  assert.ok(verifyOnStopWarn(s3)?.includes('verify-on-stop'), '成批写入仍提醒')
})

test('EMA 滤波：连续失败收敛到 1，连续成功收敛到 0', () => {
  let p = 0
  for (let i = 0; i < 50; i++) p = ema(p, 1, 0.2)
  assert.ok(p > 0.99, `EMA 应逼近 1.0，实际 ${p}`)
  for (let i = 0; i < 50; i++) p = ema(p, 0, 0.2)
  assert.ok(p < 0.01, `EMA 应逼近 0.0，实际 ${p}`)
  // 单次失败不足以让 pHat 越界（滤波的意义：单次失败 ≠ 失稳）
  const single = ema(0, 1, 0.2)
  assert.equal(single, 0.2)
})

test('振荡检测：高频翻转判振荡，稳定成功/稳定失败不判', () => {
  assert.equal(detectOscillationPure([], 0.7), false, '空窗口')
  assert.equal(detectOscillationPure([0, 1], 0.7), false, '不足 6 条')
  assert.equal(detectOscillationPure([0, 1, 0, 1, 0, 1, 0, 1, 0, 1], 0.7), true, '高频翻转')
  assert.equal(detectOscillationPure([0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.7), false, '稳定成功')
  assert.equal(detectOscillationPure([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 0.7), false, '稳定失败（发散而非振荡）')
})

test('v4.3 升档对称防抖：pHat 高需连续 3 次才升档，单次不升', () => {
  const control = { escalateAt: 0.6, deescalateAt: 0.15, deescalateStreak: 5, escalateStreak: 3, divergenceStreak: 3 }
  let r = adjustControlPure({ pHat: 0.8, autoMode: 'fast', deescalateStreak: 0, escalateStreak: 0, divergenceStreak: 0, control })
  assert.equal(r.escalated, false, '单次超阈值不升（防抖）')
  assert.equal(r.escalateStreak, 1)
  r = adjustControlPure({ pHat: 0.8, autoMode: 'fast', deescalateStreak: 0, escalateStreak: r.escalateStreak, divergenceStreak: 0, control })
  assert.equal(r.escalated, false, '第 2 次仍不升')
  assert.equal(r.escalateStreak, 2)
  r = adjustControlPure({ pHat: 0.8, autoMode: 'fast', deescalateStreak: 0, escalateStreak: r.escalateStreak, divergenceStreak: 0, control })
  assert.equal(r.escalated, true, '第 3 次升档')
  assert.equal(r.autoMode, 'deep')
  assert.equal(r.escalateStreak, 0, '升档后防抖清零')
  // 顶档不再升
  const top = adjustControlPure({ pHat: 0.9, autoMode: 'conservative', deescalateStreak: 0, escalateStreak: 3, divergenceStreak: 0, control })
  assert.equal(top.autoMode, 'conservative', '顶档不升')
  assert.equal(top.escalated, false)
})

test('v4.3 发散直通升档：连续失败不依赖 pHat 立即升档（修复 0.488 卡档）', () => {
  const control = { escalateAt: 0.6, deescalateAt: 0.15, deescalateStreak: 5, escalateStreak: 3, divergenceStreak: 3 }
  // 关键场景：pHat=0.488（连续 3 次失败的 EMA 稳态值）< escalateAt=0.6，但 divergenceStreak=3 → 直通升档
  const r = adjustControlPure({ pHat: 0.488, autoMode: 'fast', deescalateStreak: 0, escalateStreak: 0, divergenceStreak: 3, control })
  assert.equal(r.escalated, true, '发散直通升档，不依赖 pHat 越过 0.6')
  assert.equal(r.autoMode, 'deep')
  // 发散升档也清零降档防抖（方向一致）
  assert.equal(r.deescalateStreak, 0)
  // 顶档发散不再升（饱和兜底在 index.js 层处理）
  const top = adjustControlPure({ pHat: 0.488, autoMode: 'conservative', deescalateStreak: 0, escalateStreak: 0, divergenceStreak: 6, control })
  assert.equal(top.escalated, false)
  assert.equal(top.autoMode, 'conservative')
})

test('v4.6 采样归一增益：Δt 越长得重越大，钳在 [α₀/5, 0.5]，缺失退回 α₀', () => {
  const base = emaAlphaFor(250)
  assert.ok(Math.abs(base - 0.15) < 1e-9, `Δt=Δt₀ 应等于 α₀=0.15，实际 ${base}`)
  assert.ok(emaAlphaFor(50) < base, '快采样（Δt 小）应小于 α₀')
  assert.ok(emaAlphaFor(5000) > base, '慢采样（Δt 大）应大于 α₀')
  assert.ok(emaAlphaFor(3 * 3600 * 1000) <= 0.5, '单样本不得越过 0.5（不重置估计）')
  assert.ok(emaAlphaFor(1) >= 0.15 / 5, '下限 α₀/5')
  assert.equal(emaAlphaFor(0), 0.15, 'Δt 缺失/为 0 退化为 α₀')
  assert.equal(emaAlphaFor(undefined), 0.15)
  // 单调性：Δt 越大 α 越大
  const seq = [50, 250, 1000, 10000].map((d) => emaAlphaFor(d))
  for (let i = 1; i < seq.length; i++) assert.ok(seq[i] >= seq[i - 1], 'α 应随 Δt 单调不减')
})

test('v4.6 P0-1 bash 退出码判失败：约定非零豁免，真失败计 1', () => {
  assert.equal(bashExitDelta(0, 'ls').failed, false)
  assert.equal(bashExitDelta(2, 'ls /nope').failed, true)
  assert.equal(bashExitDelta(7, 'sh -c "exit 7"').failed, true)
  // grep/diff 无匹配：退出 1 属正常结果
  const g = bashExitDelta(1, 'grep -rn foo .')
  assert.equal(g.failed, false)
  assert.equal(g.benign, true)
  assert.equal(bashExitDelta(1, 'diff a b').benign, true)
  // 同名但退出码 2 就是真失败（grep 参数错/文件不存在）
  assert.equal(bashExitDelta(2, 'grep foo').failed, true)
  // 管道取最后一段作为判定源
  assert.equal(firstCommandToken('ls | head -3'), 'head')
  assert.equal(firstCommandToken('A=1 ls -la'), 'ls')
  assert.equal(firstCommandToken('cd /tmp && npm test'), 'npm')
  assert.equal(firstCommandToken(''), '')
  assert.equal(bashExitDelta(1, 'ls | grep x').benign, true, '末段 grep 退出 1 属约定非零')
  // 运行期真实形态：参数是 JSON，不是裸命令（否则首 token 会取成 `{"command":"grep`，豁免永不生效）
  const jsonArgs = JSON.stringify({ command: 'grep -rn foo .', description: 'x' })
  assert.equal(firstCommandToken(jsonArgs), '{"command":"grep', '裸 tokenize 的坑：这正是要修的')
  assert.equal(bashExitDelta(1, jsonArgs).benign, true, 'JSON 参数形态也要认出 grep')
  assert.equal(bashExitDelta(1, JSON.stringify({ command: 'rg -n x' })).benign, true)
  assert.equal(bashExitDelta(2, JSON.stringify({ command: 'ls /nope' })).failed, true)
  assert.equal(commandTextOf('{"command":"ls -la","description":"d"}'), 'ls -la')
  assert.equal(commandTextOf('ls -la'), 'ls -la', '裸命令原样返回')
  assert.equal(commandTextOf('not json {'), 'not json {', '坏 JSON 退回原文')
})

test('v4.6 P0-1 文本兜底：从 [exit code: N] 标记取退出码', () => {
  const r = { isError: false, content: [{ type: 'text', text: 'boom\n[exit code: 7]' }] }
  assert.match(textContentOf(r), /\[exit code: 7\]/)
  assert.equal(textContentOf({ content: [{ type: 'image' }] }), '')
  assert.equal(textContentOf(null), '')
})

test('v4.6 P1-4 熵门控：无旁证的低熵不告警', () => {
  assert.equal(entropyGatePure({ redundantCalls: 0, divergence: false, oscillation: false }), false, '专注型批量作业不告警')
  assert.equal(entropyGatePure({ redundantCalls: 1, divergence: false, oscillation: false }), true, '有冗余调用才告警')
  assert.equal(entropyGatePure({ divergence: true }), true)
  assert.equal(entropyGatePure({ oscillation: true }), true)
})

test('滞环：降档需连续 5 次低失败率（防抖），中途反弹清零', () => {
  const control = { escalateAt: 0.6, deescalateAt: 0.15, deescalateStreak: 5 }
  let streak = 0
  let r
  for (let i = 0; i < 4; i++) {
    r = adjustControlPure({ pHat: 0.1, autoMode: 'deep', deescalateStreak: streak, control })
    streak = r.deescalateStreak
  }
  assert.equal(streak, 4)
  assert.equal(r.deescalated, false, '4 次不应降档')
  const fifth = adjustControlPure({ pHat: 0.1, autoMode: 'deep', deescalateStreak: streak, control })
  assert.equal(fifth.deescalated, true, '第 5 次降档')
  assert.equal(fifth.autoMode, 'fast')
  // 中途出现高 pHat → 防抖计数清零
  const bounce = adjustControlPure({ pHat: 0.8, autoMode: 'deep', deescalateStreak: 4, control })
  assert.equal(bounce.deescalateStreak, 0, '反弹清零')
})

test('A1 回归：冗余 hash 区分参数（rc.6 arguments 字段），同参数相同', () => {
  const a = redundantHash('bash', { arguments: 'ls -la' })
  const b = redundantHash('bash', { arguments: 'rm -rf /tmp/x' })
  assert.notEqual(a, b, '不同参数 hash 应不同')
  assert.equal(redundantHash('bash', { arguments: 'ls -la' }), a, '相同参数 hash 应相同')
  // 旧实现 bug 复现：exec.args 恒 undefined → 全工具 hash 相同（本测试必须失败才算修复）
  const legacyA = redundantHash('bash', { args: 'ls' })
  const legacyB = redundantHash('bash', { args: 'rm -rf /tmp/x' })
  assert.notEqual(legacyA, legacyB, '即使走 args 字段也应区分（stableStringify 参数文本）')
})

test('execArgsText 兼容 arguments / args / 对象 / 空', () => {
  assert.equal(execArgsText({ arguments: 'hello' }), 'hello')
  assert.equal(execArgsText({ args: 'legacy' }), 'legacy')
  assert.equal(execArgsText({ arguments: { a: 1 } }), '{"a":1}')
  assert.equal(execArgsText(null), '')
  assert.equal(execArgsText({}), '')
})

test('stableStringify 键排序稳定', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
  assert.equal(stableStringify([3, 1]), '[3,1]')
  assert.equal(stableStringify('x'), '"x"')
})

test('熵：单一工具 = 0，均匀分布 = log2(n)，混合介于其间', () => {
  assert.equal(computeEntropyPure([{ tool: 'a' }, { tool: 'a' }, { tool: 'a' }]), 0)
  assert.equal(computeEntropyPure([{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }, { tool: 'd' }]), 2)
  const mixed = computeEntropyPure([{ tool: 'a' }, { tool: 'a' }, { tool: 'b' }])
  assert.ok(mixed > 0 && mixed < 1, `混合熵应在 (0,1)，实际 ${mixed}`)
  assert.equal(computeEntropyPure([]), 0)
})

test('健康评分（C13）：满分 100、全失败 0、发散/振荡扣分', () => {
  assert.equal(healthScorePure({ pHat: 0, observationRate: 1, redundantRate: 0, divergence: false, oscillation: false }), 100)
  assert.equal(healthScorePure({ pHat: 1, observationRate: 1, redundantRate: 0, divergence: false, oscillation: false }), 0)
  const penalized = healthScorePure({ pHat: 0, observationRate: 1, redundantRate: 0, divergence: true, oscillation: true })
  assert.equal(penalized, 80, '发散+振荡各扣 10')
  const mid = healthScorePure({ pHat: 0.5, observationRate: 0.5, redundantRate: 0.5, divergence: false, oscillation: false })
  assert.ok(mid > 0 && mid < 100, `中间态应在 (0,100)，实际 ${mid}`)
  // 输入越界钳制：负 pHat（钳 0 = 全成功）→ 100；超限观测/冗余钳到边界不溢出
  assert.equal(healthScorePure({ pHat: -1, observationRate: 5, redundantRate: -2, divergence: false, oscillation: false }), 100)
})

test('MODE 常量与版本', () => {
  assert.deepEqual(MODE_ORDER, ['fast', 'deep', 'conservative'])
  // v4.6：MODE_LIMITS(5/4/3，从未生效) → MODE_VALVE 收缩量；基线 25 → 25/20/15
  assert.deepEqual(MODE_VALVE, { fast: 0, deep: 5, conservative: 10 })
  assert.equal(valveFor('fast', 25), 25)
  assert.equal(valveFor('deep', 25), 20)
  assert.equal(valveFor('conservative', 25), 15)
  assert.equal(valveFor('unknown', 25), 25, '未知档位不收缩')
  assert.equal(valveFor('conservative', 12), 5, '下限 5')
  assert.equal(valveFor('fast', undefined), 25, '基线缺失回落到 25')
  assert.ok(VERSION.startsWith('v4.'), `版本号应以 v4. 开头，实际 ${VERSION}`)
})

test('失败归因（方案 B）：结构化 code 优先，消息模式兜底，成功返回 null', () => {
  // 成功 → null
  assert.equal(classifyToolError({ isError: false, value: 'ok' }), null)
  assert.equal(classifyToolError(null), null)
  assert.equal(classifyToolError({}), null)
  // FsError 结构化 code（edit 工具实际格式：result.error.info = { name, code }）
  const editNotFound = classifyToolError({
    isError: true,
    error: { message: 'No replacement was performed, old_str `foo` did not appear verbatim in /a/b.md.', info: { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' } },
  })
  assert.equal(editNotFound.errorType, 'FS_EDIT_NOT_FOUND')
  const ambiguous = classifyToolError({
    isError: true,
    error: { message: 'No replacement was performed. Multiple occurrences of old_str `x`...', info: { name: 'FsError', code: 'FS_AMBIGUOUS_EDIT' } },
  })
  assert.equal(ambiguous.errorType, 'FS_AMBIGUOUS_EDIT')
  const sandbox = classifyToolError({
    isError: true,
    error: { message: 'FS_SANDBOX_DENIED: no write access', info: { name: 'FsError', code: 'FS_SANDBOX_DENIED' } },
  })
  assert.equal(sandbox.errorType, 'FS_SANDBOX_DENIED')
  // 无 code → 消息模式归类
  assert.equal(classifyToolError({ isError: true, error: { message: 'ECONNREFUSED connect' } }).errorType, 'network')
  assert.equal(classifyToolError({ isError: true, error: { message: 'The path /x does not exist' } }).errorType, 'not-found')
  assert.equal(classifyToolError({ isError: true, error: { message: 'Parameter `old_str` is required' } }).errorType, 'param-invalid')
  assert.equal(classifyToolError({ isError: true, error: { message: 'something weird happened' } }).errorType, 'other')
  // errMsg 截断
  const long = classifyToolError({ isError: true, error: { message: 'x'.repeat(300) } })
  assert.ok(long.errMsg.length <= 122, `errMsg 应截断，实际 ${long.errMsg.length}`)
  assert.ok(long.errMsg.endsWith('…'))
})
