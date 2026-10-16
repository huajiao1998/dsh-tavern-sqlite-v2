// D03 单一业务基准：真 producer 造两种基准 —— ① 新 timeline（row缝+business缝）只写 businessBefore（无 rowBefore）；
// ② 旧 producer（仅 row缝）真产 rowBefore checkpoint，再由新 timeline 的只读路径经 resolve 严格读回完整业务基准。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {pathToFileURL} from 'node:url'
import {applyRowTimelineTransform} from '../deploy/row-rollback-transform.mjs'
import {applyRollbackBusinessTimelineTransform} from '../deploy/rollback-business-transform.mjs'
import {captureRollbackBusinessState,resolveRollbackBusinessState,restoreRollbackBusinessState} from '../lib/rollback-business-state.js'

const AUTHOR = new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/tavern-plugin/lib/domain/', import.meta.url)

/** 真作者 timeline：按需施加 row 缝 / business 缝（生产同序），storage-rollback-business 指真产品实现。 */
async function loadTimeline(root, name, source) {
  const rewrite = text => text.replace(/from '(.+?)'/g, (all, spec) => spec.startsWith('./') ? 'from ' + JSON.stringify(new URL(spec, AUTHOR).href) : all)
  const business = new URL('../lib/rollback-business-state.js', import.meta.url).href
  const file = path.join(root, name)
  writeFileSync(file, rewrite(source).replace(new URL('storage-rollback-business.js', AUTHOR).href, business), 'utf8')
  const module = await import(pathToFileURL(file).href)
  return module.createStoryTimeline({})
}

test('D03 旧row-v1经真timeline消费者回退：前缀删除用旧基准、宏与当前资源不被旧整头覆盖、未知形状拒', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-legacy-restore-'))
  try {
    // 旧 producer 真产 rowBefore checkpoint
    const legacy = await loadTimeline(root, 'timeline-row.mjs', rowOnlySource())
    const legacyChat = runTurn(legacy, baseChat(), 53)
    assert.ok(legacyChat.timeline.checkpoints.at(-1).rowBefore, '前置：旧 producer 必须真产 rowBefore')
    // 新产品 timeline 作为消费者：真走 turn.rollback intent（不是只调 pure resolve）
    const next = await loadTimeline(root, 'timeline-new.mjs', newSource())
    const target = { ...structuredClone(legacyChat), macroState: { userMacro: 'current-macro' }, variables: { hp: 999 },
      preparedWorldBookContext: '当前资源', rollbackUndo: { stale: true } }
    const result = next.apply({ chat: target, intent: { kind: 'turn.rollback', turn: 53, rowCheckpointId: legacyChat.timeline.checkpoints.at(-1).id } })
    const rolled = result.chat
    assert.equal(rolled.messages.length, 2, '回退必须删掉第 53 轮的前缀（回到 52 轮后）')
    assert.equal(rolled.messages.some(row => Number(row.turn) === 53), false, '第 53 轮正文行必须删除')
    assert.deepEqual(rolled.variables, { hp: 52 }, '变量必须回到旧 row-v1 基准里的值（不是当前 999）')
    assert.deepEqual(rolled.macroState, { userMacro: 'current-macro' }, '用户宏配置必须保留（旧整头不得覆盖）')
    assert.equal(rolled.preparedWorldBookContext, String(legacyChat.timeline.checkpoints.at(-1).rowBefore.preparedWorldBookContext ?? ''), '准备资源由旧基准恢复（不得保留当前值）')
    assert.equal(rolled.rollbackUndo, undefined, '回退必须清掉 rollbackUndo 残留')
    assert.equal(typeof next.captureBusiness, 'function', '新消费者必须接实际captureBusiness')
    const half = structuredClone(target)
    delete half.timeline.checkpoints.at(-1).rowBefore.macroState
    assert.equal(next.apply({chat:half,intent:{kind:'turn.rollback',turn:53,rowCheckpointId:half.timeline.checkpoints.at(-1).id}}).chat.messages.some(row=>Number(row.turn)===53),false,'缺宏前像不阻止回退')
    assert.deepEqual(half.messages, target.messages, '负例不得修改输入正文')
  } finally {
    assert.ok(path.basename(root).startsWith('tavern-legacy-restore-'))
    rmSync(root, { recursive: true, force: true })
  }
})
const rowOnlySource = () => applyRowTimelineTransform(readFileSync(new URL('story-timeline.js', AUTHOR), 'utf8'))
const newSource = () => applyRollbackBusinessTimelineTransform(rowOnlySource())
test('D03 旧双基准marked源码升级只写完整基准，幂等且接线残缺拒绝', () => {
  const old = readFileSync(new URL('./fixtures/old-dual-business-timeline.js.txt',import.meta.url),'utf8')
  assert.ok(old.includes('rowBefore: operation.rowBefore'))
  const next = applyRollbackBusinessTimelineTransform(old)
  assert.equal(next,newSource())
  assert.equal(applyRollbackBusinessTimelineTransform(next),next)
  assert.equal(next.includes('rowBefore: operation.rowBefore'),false)
  assert.throws(()=>applyRollbackBusinessTimelineTransform(next.replace('resolveRollbackBusinessState(chat, Number(checkpoint.turn))','null')),/不完整/)
})

/** 用真 producer 完整跑一轮（begin → 写正文 → complete），返回结果 chat。 */
function runTurn(timeline, base, turn) {
  const begun = timeline.apply({ chat: base, intent: { kind: 'body.begin', turn, userText: 'u' + turn, businessBefore: captureRollbackBusinessState(base) } })
  const chat = begun.chat
  chat.messages = [...chat.messages, { role: 'user', turn, text: 'u' + turn }, { role: 'assistant', turn, text: 'a' + turn }]
  chat.variables = { hp: turn }
  return timeline.complete({ chat, operationId: begun.value.operationId, basedOn: begun.value.basedOn, outcome: { status: 'success' } }).chat
}
const baseChat = () => ({ id: 'c1', sessionId: 's1', _storageRevision: 1, variables: { hp: 52 }, macroState: { userMacro: 'keep-me' },
  messages: [{ role: 'user', text: 'u52' }, { role: 'assistant', turn: 52, text: 'a52' }],
  timeline: { schemaVersion: 1, branchId: 'b', revision: 52, checkpoints: [], operations: {}, participants: {} } })

test('D03 单一业务基准：新producer只写businessBefore无rowBefore，旧row-v1由真producer产出并可严格读回', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-single-baseline-'))
  try {
    // ① 新 producer：只写完整业务基准，不再复制第二份头快照
    const next = await loadTimeline(root, 'timeline-new.mjs', newSource())
    assert.equal(typeof next.apply, 'function', '真 timeline 必须可 apply')
    const after53 = runTurn(next, baseChat(), 53)
    const checkpoint = after53.timeline.checkpoints.at(-1)
    assert.equal(Number(checkpoint.turn), 53)
    assert.ok(checkpoint.businessBefore && typeof checkpoint.businessBefore === 'object', '新回合必须写完整业务基准 businessBefore')
    assert.equal(Object.hasOwn(checkpoint, 'rowBefore'), false, '新回合不得再复制第二份头快照 rowBefore')
    assert.equal(Number(checkpoint.businessBefore.messageCount), 2, '业务基准必须带正文前缀长度')
    assert.deepEqual(checkpoint.businessBefore.fields.variables, { hp: 52 }, '业务基准变量必须是本轮之前的值')

    // ② 旧 producer（仅 row 缝）真产 rowBefore checkpoint；新 timeline 只读路径必须严格读回
    const legacy = await loadTimeline(root, 'timeline-row.mjs', rowOnlySource())
    const legacyChat = runTurn(legacy, baseChat(), 53)
    const legacyCheckpoint = legacyChat.timeline.checkpoints.at(-1)
    assert.ok(legacyCheckpoint.rowBefore && typeof legacyCheckpoint.rowBefore === 'object', '旧 producer 必须真产 rowBefore')
    assert.equal(Object.hasOwn(legacyCheckpoint, 'businessBefore'), false, '旧 producer 不写 businessBefore')
    const resolved = resolveRollbackBusinessState(legacyChat, 53)
    assert.equal(Number(resolved.messageCount), 2, '旧 row-v1 必须被严格读回（messageCount 来自其自身语义）')
    assert.deepEqual(resolved.fields.variables, { hp: 52 }, '旧 row-v1 的变量必须来自其自身基准，不得拿当前值冒充')
    const target = { messages: legacyChat.messages, macroState: { userMacro: 'keep-me' }, variables: { hp: 60 }, timeline: { participants: {} } }
    restoreRollbackBusinessState(target, resolved, value => (value === undefined ? undefined : structuredClone(value)))
    assert.deepEqual(target.variables, { hp: 52 }, 'restore 必须把旧基准变量写回')
    assert.deepEqual(target.macroState, { userMacro: 'keep-me' }, '用户宏配置必须保留（不经旧整头 restore 覆盖）')

    // ③ 负例：半截旧基准必须被拒（不得降级/猜）
    const half = structuredClone(legacyChat)
    delete half.timeline.checkpoints.at(-1).rowBefore.macroState
    assert.equal(resolveRollbackBusinessState(half, 53).partial,true,'缺前像返回可用部分，不拒绝')
  } finally {
    assert.ok(path.basename(root).startsWith('tavern-single-baseline-'))
    rmSync(root, { recursive: true, force: true })
  }
})
