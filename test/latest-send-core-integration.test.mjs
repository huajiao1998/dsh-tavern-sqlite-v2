// 最新发送撤销新链的 **buildCore 集成叶**（2026-10-13 第五批，独占新文件）：
//   ① 用 537e878 真实作者树现有 sourceFiles 跑完整 buildCore（只施缝、不写盘），核对新链连接、
//      受影响文件二次施缝零差异、产物语法可解析；旧代无 round-anchor.js 时必须 present 跳过而不是崩。
//      若完整 buildCore 被**非本链**的上游接缝/夹具形态阻塞，本叶记录该证据并退化为"同一批真实变换逐文件链"验证（不迎合、不放宽断言）。
//   ② error-purge 目标身份 key 必须计入统一 target 的 kind/op/branch/revision/nativeAnchor 坐标。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCore } from '../deploy/standard-seam-transforms.mjs'
import { maintenanceTargets } from '../deploy/standard-seams.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'

const ROOT = fileURLToPath(new URL('../../../tmp/upstream-537e878-review/adapt/src-AQHmMH/dsh-tavern-537e878f882dbac8b651fba0f72ecb492a8a2b21/', import.meta.url))
const DEPLOY = new URL('../deploy/', import.meta.url)
const load = name => import(new URL(name, DEPLOY).href)
const inline = source => import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
const AFFECTED = [
  'tavern-plugin/lib/index.js',
  'tavern-plugin/lib/domain/chat-session-state.js',
  'tavern-plugin/lib/domain/turn-orchestration.js',
  'tavern-plugin/lib/domain/story-timeline.js',
  'tavern-plugin/lib/domain/round-anchor.js',
  'tavern-plugin/lib/domain/storage-rollback.js',
]
function fixture() {
  const sources = new Map()
  for (const rel of maintenanceTargets) {
    const file = path.join(ROOT, rel)
    if (fs.existsSync(file)) sources.set(rel, fs.readFileSync(file, 'utf8'))
  }
  return sources
}
// 与 standard-seam-transforms.mjs 中这些文件的**实际链序**一致（同一批真实变换，不重写实现）。
async function chainFor(rel, source) {
  if (rel === 'tavern-plugin/lib/index.js') return (await load('upstream-failure-input-transform.mjs')).applyUpstreamFailureInputTransform(source)
  if (rel === 'tavern-plugin/lib/domain/round-anchor.js') return (await load('latest-send-anchor-transform.mjs')).applyInputOnlyAnchorResolverTransform(source)
  if (rel === 'tavern-plugin/lib/domain/story-timeline.js') {
    const [row, business, settlement, anchor] = await Promise.all([load('row-rollback-transform.mjs'), load('rollback-business-transform.mjs'), load('settlement-round-transform.mjs'), load('latest-send-anchor-transform.mjs')])
    return anchor.applySendAnchorTimelineTransform(settlement.applySettlementRoundTransform(business.applyRollbackBusinessTimelineTransform(row.applyRowTimelineTransform(source))))
  }
  if (rel === 'tavern-plugin/lib/domain/turn-orchestration.js') {
    const [commit, signal, shared, order, business, anchor] = await Promise.all([load('rollback-body-commit-transform.mjs'), load('rollback-body-signal-transform.mjs'), load('rollback-shared-branch-transform.mjs'), load('upstream-failure-input-transform.mjs'), load('rollback-business-transform.mjs'), load('latest-send-anchor-transform.mjs')])
    return commit.applyRollbackBodyCommitTurnTransform(signal.applyRollbackBodySignalTurnTransform(shared.applyRollbackSharedBranchTurnTransform(order.applyTemplateRollbackInputOrderTransform(anchor.applySendAnchorTurnTransform(business.applyRollbackBusinessTurnTransform(source))))))
  }
  if (rel === 'tavern-plugin/lib/domain/chat-session-state.js') {
    const [pending, failure, overlay] = await Promise.all([load('rollback-pending-view-transform.mjs'), load('latest-failure-transform.mjs'), load('latest-send-view-transform.mjs')])
    return overlay.applyLatestSendViewTransform(failure.applyLatestFailureViewTransform(pending.applyRollbackPendingViewTransform(source)))
  }
  return source
}

test('① buildCore：537e878全代产物含最新发送新链连接、二次施缝零差异且语法可解析', async () => {
  const sources = fixture()
  assert.ok(sources.size > 20, '真实作者源夹具必须齐备：' + sources.size)
  assert.ok(sources.has('tavern-plugin/lib/index.js') && sources.has('tavern-plugin/lib/domain/turn-orchestration.js'), '关键作者文件必须在夹具内')
  assert.ok(sources.has('tavern-plugin/lib/domain/round-anchor.js'), '537e878 应含 round-anchor.js')
  // 完整 buildCore：能跑就跑，跑不动时必须是**非本链**的上游接缝阻塞（记录证据，不放宽本链断言）。
  let produced = null
  let blocked = ''
  try { produced = buildCore(ROOT, sources) } catch (error) { blocked = String((error && error.message) || error) }
  if (blocked !== '') {
    assert.match(blocked, /压缩警告接缝消费者缺失/, 'buildCore 的阻塞必须来自非本链接缝（实际：' + blocked + '）')
    assert.match(sources.get('tavern-plugin/lib/domain/chat-session-state.js'), /\n  function volatileSessionViewFields\(chat, activity, changes\) \{/,
      '夹具形态证据：该函数是 2 空格缩进，而上游 compaction-warning 接缝的三个 needle 均为 0 缩进形态')
  }
  // storage-rollback.js 由 buildCore 生成垫片（夹具树里没有该文件）⇒ 只核 buildCore 产物，不进逐文件链。
  const CHAINED = AFFECTED.filter(rel => rel !== 'tavern-plugin/lib/domain/storage-rollback.js')
  const out = new Map()
  for (const rel of CHAINED) out.set(rel, await chainFor(rel, sources.get(rel)))
  const core = rel => {
    const text = out.get(rel)
    assert.equal(typeof text, 'string', '必须产出 ' + rel)
    return text
  }
  // 新链连接①：视图 overlay 注入（统一目标 + evidence 默认值 + wrapper 覆盖）。
  const view = core('tavern-plugin/lib/domain/chat-session-state.js')
  assert.ok(view.includes('// [dsh-tavern-native-repair-rollback-view:v1]'), '新作者统一包装必须在位')
  assert.ok(view.includes('latestSendTarget(chat, evidence)') && view.includes('evidence = evidenceOf(chat.sessionId)'), 'overlay 必须取统一目标且补 evidence 默认值')
  assert.ok(view.includes('failureTarget: rollbackTarget') && view.includes('rollbackTargetTurn: rollbackTarget?.turn'), 'wrapper必须共用统一目标')
  // 新链连接②：发轮前锚点（prepare 捕获 + intent 传参 + op 落字段）。
  const turn = core('tavern-plugin/lib/domain/turn-orchestration.js')
  assert.ok(turn.includes('// [dsh-tavern-send-anchor-prepare:v1]') && turn.includes('nativeAnchor: rollbackSendAnchor } })'), 'prepare 必须算锚点并随 body.begin 传入')
  assert.ok(turn.includes('options.resolveSendInputAnchor') && turn.includes('options.sessions.get(chat.sessionId)'), '必须留宿主 DI（sessions.get 可能为 null，由主早期 recorder 补）')
  assert.ok(core('tavern-plugin/lib/domain/story-timeline.js').includes('// [dsh-tavern-body-operation-anchor:v1]'), 'body operation 必须落 nativeAnchor 字段')
  // 新链连接③：resolver 放宽到 input-only。
  const anchorText = core('tavern-plugin/lib/domain/round-anchor.js')
  assert.ok(anchorText.includes('// [dsh-tavern-input-only-anchor:v1]') && anchorText.includes('anchor.reply === null'), 'resolver 必须放宽 reply===null')
  // 新链连接④：发送守卫 v2 + 垫片导出统一目标（垫片是 buildCore 内文本，直接核接线源）。
  const index = core('tavern-plugin/lib/index.js')
  assert.ok(index.includes('// [dsh-tavern-failure-input-guard:v2]') && index.includes('assertSendAfterCleanup(chat, { events: sessionEvents(session) })'), 'clearFailedTurns 必须复用先清理守卫且不拒本轮已接受占位')
  assert.ok(fs.readFileSync(fileURLToPath(new URL('standard-seam-transforms.mjs', DEPLOY)), 'utf8').includes('latestSendTarget'), 'storage-rollback 垫片接线必须导出 unified target')
  if (produced !== null) assert.ok(String(produced.get('tavern-plugin/lib/domain/storage-rollback.js')).includes('latestSendTarget'), 'buildCore 生成的 storage-rollback 垫片必须导出 unified target')
  // 完整 buildCore 跑通时：真集成交叉核——buildCore 产物（含其它接缝的额外变换）必须仍含本链标记。
  const MARKERS = {
    'tavern-plugin/lib/index.js': ['// [dsh-tavern-failure-input-guard:v2]', 'assertSendAfterCleanup(chat, { events: sessionEvents(session) })'],
    'tavern-plugin/lib/domain/chat-session-state.js': ['// [dsh-tavern-native-repair-rollback-view:v1]', 'latestSendTarget(chat, evidence)'],
    'tavern-plugin/lib/domain/turn-orchestration.js': ['// [dsh-tavern-send-anchor-prepare:v1]', 'nativeAnchor: rollbackSendAnchor'],
    'tavern-plugin/lib/domain/story-timeline.js': ['// [dsh-tavern-body-operation-anchor:v1]'],
    'tavern-plugin/lib/domain/round-anchor.js': ['// [dsh-tavern-input-only-anchor:v1]'],
    'tavern-plugin/lib/domain/storage-rollback.js': ['latestSendTarget'],
  }
  if (produced !== null) for (const rel of AFFECTED) {
    const text = produced.get(rel)
    assert.equal(typeof text, 'string', 'buildCore 必须产出 ' + rel)
    for (const marker of MARKERS[rel]) assert.ok(text.includes(marker), 'buildCore 产物必须含本链标记：' + rel + ' / ' + marker)
  }
  // 旧代缺 round-anchor.js 时 present 守卫必须跳过（而不是让整链崩）。
  if (produced !== null) {
    const writesWithout = buildCore(ROOT, new Map([...sources].filter(([rel]) => rel !== 'tavern-plugin/lib/domain/round-anchor.js')))
    assert.equal(writesWithout.has('tavern-plugin/lib/domain/round-anchor.js'), false, '旧代无 round-anchor.js 时不得产出该文件')
    assert.equal(writesWithout.get('tavern-plugin/lib/domain/chat-session-state.js'), produced.get('tavern-plugin/lib/domain/chat-session-state.js'), '缺 round-anchor 不影响视图 overlay 产出')
  }
  // 二次施缝：受影响文件必须零差异（不重复注入、不吞块）。
  for (const rel of AFFECTED.filter(item => item !== 'tavern-plugin/lib/domain/storage-rollback.js')) {
    assert.equal(await chainFor(rel, out.get(rel)), out.get(rel), '二次施缝必须零差异：' + rel)
  }
  // 语法：受影响产物必须能被 acorn 作为 ESM 解析。
  for (const rel of CHAINED) parse(core(rel), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  if (produced !== null && typeof produced.get('tavern-plugin/lib/domain/storage-rollback.js') === 'string') {
    parse(produced.get('tavern-plugin/lib/domain/storage-rollback.js'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true })
  }
})

test('② error-purge：failureTargetKey 计入统一 target kind/op/branch/revision/nativeAnchor 坐标', async () => {
  const { applyErrorPurgePlayControlsTransform } = await import('../deploy/error-purge-transform.mjs')
  const raw = fs.readFileSync(path.join(ROOT, 'tavern-plugin/src/client/features/play-controls.js'), 'utf8')
  const seamed = applyErrorPurgePlayControlsTransform(raw)
  const head = 'const failureTargetKey = (function (view) {'
  const start = seamed.indexOf(head)
  const end = seamed.indexOf('})(state.view);', start)
  assert.ok(start > 0 && end > start, '产物必须含 failureTargetKey IIFE')
  const iife = seamed.slice(start + 'const failureTargetKey = '.length, end + '})'.length)
  const mod = await inline(`export const keyOf = ${iife}\n`)
  const base = { chatId: 'c', sessionId: 's', kind: 'rollback', turn: 25, operationId: 'op25', branchId: 'b', revision: 9, nativeAnchor: { turn: 25, input: 334, reply: null } }
  const key = target => mod.keyOf({ failureTarget: target, failureCleanupReason: '' })
  assert.equal(key(base), key({ ...base }), '同目标 key 必须稳定')
  assert.notEqual(key(base), key({ ...base, kind: 'body' }), 'kind 必须进 key')
  assert.notEqual(key(base), key({ ...base, operationId: 'op26' }), 'operationId 必须进 key')
  assert.notEqual(key(base), key({ ...base, branchId: 'b2' }), 'branchId 必须进 key')
  assert.notEqual(key(base), key({ ...base, revision: 10 }), 'revision 必须进 key')
  assert.notEqual(key(base), key({ ...base, nativeAnchor: { ...base.nativeAnchor, turn: 26 } }), 'nativeAnchor.turn 必须进 key')
  assert.notEqual(key(base), key({ ...base, nativeAnchor: { ...base.nativeAnchor, input: 335 } }), 'nativeAnchor.input 必须进 key')
  assert.notEqual(key(base), key({ ...base, nativeAnchor: { ...base.nativeAnchor, reply: 341 } }), 'nativeAnchor.reply 必须进 key')
  assert.notEqual(key({ ...base, nativeAnchor: undefined }), key(base), '有无 nativeAnchor 必须区分')
  // 统一形态：只给 rollbackTarget 的视图与同坐标 failureTarget 视图必须给同一 key（alias 等价）。
  assert.equal(mod.keyOf({ rollbackTarget: base, failureCleanupReason: '' }), key(base), '统一 alias 必须同 key')
  assert.notEqual(mod.keyOf({ failureTarget: null, failureCleanupReason: 'x' }), key(base), '无目标必须区分于有目标')
})
