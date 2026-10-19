// 最新发送兼容回归（独占新文件；真实 latestSendRecord/latestSendTarget，**不 mock selector**）。
// 只用小对象，无任何用户数据。四叶各自独立：
//   ① 在途清理回放同一turn/id（不得回落签52）
//   ② cp-only 的 row-v1（rowBefore+participants）形态可签最新 53
//   ③ 同轮 body 无基准而 cp 有 businessBefore ⇒ 仍签 body 的 operationId，source 是 cp
//   ④ 操作终态/状态名不改变 target
import test from 'node:test'
import assert from 'node:assert/strict'
import { latestSendRecord, latestSendTarget } from '../lib/latest-send.js'

const BIZ = (messageCount, hp) => ({ version: 1, messageCount, fields: { variables: { hp } }, participants: {} })
// row-v1 形态：只有 rowBefore + participants（无 businessBefore）也算有基准。
const ROW_V1 = { rowBefore: { revision: 51, eventCount: 8 }, participants: { left: {} } }
const base = overrides => ({
  id: 'chat-compat', sessionId: 'session-compat', mode: 'story', _storageRevision: 9,
  messages: [{ role: 'user', text: '输入' }, { role: 'assistant', turn: 52, text: '正文', variables: [{ hp: 2 }] }],
  timeline: {
    schemaVersion: 1, branchId: 'branch-compat', revision: 52, participants: {}, checkpoints: [],
    operations: { body52: { kind: 'body', role: 'body', status: 'completed', turn: 52, userText: '输入', businessBefore: BIZ(2, 2) } },
  },
  ...overrides,
})

test('退役迁移：pending回放同一次清理目标，不回落已恢复的上一轮', () => {
  const target = {kind:'native-only',turn:53,chatId:'chat-compat',sessionId:'session-compat'}
  const pending = {id:'pending-1',turn:53,failureTarget:target}
  const chat = base({rollbackPending:pending})
  assert.equal(latestSendRecord(chat,{events:[]}).turn,52,'记录层是恢复后的52')
  assert.deepEqual(latestSendTarget(chat,{events:[]}),{...target,kind:'rollback',turn:53,rollbackId:'pending-1'})
  assert.equal(latestSendTarget(base(),{events:[]}).turn,52,'无在途意图才选择当前52')
  const ordinaryTarget = {...target,kind:'rollback',revision:9,branchId:'branch-compat'}
  const ordinary = base({rollbackPending:{...pending,ordinaryTarget}})
  assert.deepEqual(latestSendTarget(ordinary,{events:[]}),{...ordinaryTarget,rollbackId:'pending-1'})
})

test('兼容回归②：cp-only 的 row-v1（rowBefore+participants）可签最新53', () => {
  const chat = base({
    _storageRevision: 12,
    messages: [{ role: 'user', text: '输入' }, { role: 'assistant', turn: 53, text: '新正文' }],
    timeline: { schemaVersion: 1, branchId: 'branch-compat', revision: 53, participants: {}, operations: {}, checkpoints: [{ id: 'cp53', turn: 53, userText: '输入', ...ROW_V1 }] },
  })
  const record = latestSendRecord(chat, { events: [] })
  assert.equal(record.turn, 53, 'row-v1 的 rowBefore+participants 必须算作基准')
  assert.equal(record.source, chat.timeline.checkpoints[0], 'source 必须是该 checkpoint')
  const target = latestSendTarget(chat, { events: [] }, chat._storageRevision)
  assert.equal(target.kind, 'rollback')
  assert.equal(target.turn, 53)
  assert.equal(target.operationId, undefined, 'cp-only 不得虚构 operationId')
  assert.equal(target.revision, 12)
})

test('兼容回归③：同轮 body 无基准而 cp 有 businessBefore 时仍签 body operationId、source 是 cp', () => {
  const chat = base({
    messages: [{ role: 'user', text: '输入' }, { role: 'assistant', turn: 53, text: '新正文' }],
    timeline: {
      schemaVersion: 1, branchId: 'branch-compat', revision: 53, participants: {}, checkpoints: [{ id: 'cp53', turn: 53, businessBefore: BIZ(4, 4) }],
      operations: { body53: { kind: 'body', role: 'body', status: 'running', turn: 53, userText: '输入' } },
    },
  })
  const record = latestSendRecord(chat, { events: [] })
  assert.equal(record.turn, 53)
  assert.equal(record.operationId, 'body53', 'op 身份仍取同轮 body op')
  assert.equal(record.source, chat.timeline.checkpoints[0], 'source 必须是带基准的 cp（body 自身无基准）')
  assert.deepEqual(latestSendTarget(chat, { events: [] }, chat._storageRevision).operationId, 'body53')
})

test('兼容回归④：操作终态/状态名不改变 target', () => {
  const targets = ['running', 'completed', 'failed', 'foreground-completed', '未知终态'].map(status => {
    const chat = base({
      messages: [{ role: 'user', text: '输入' }, { role: 'assistant', turn: 53, text: '新正文' }],
      timeline: {
        schemaVersion: 1, branchId: 'branch-compat', revision: 53, participants: {}, checkpoints: [],
        operations: { body53: { kind: 'body', role: 'body', status, turn: 53, userText: '输入', businessBefore: BIZ(4, 4), ...(status === 'failed' ? { error: 'boom', reason: { kind: 'error' } } : {}) } },
      },
    })
    return latestSendTarget(chat, { events: [] }, chat._storageRevision)
  })
  for (const target of targets.slice(1)) assert.deepEqual(target, targets[0], '终态/状态名不得改变 target 坐标')
  assert.equal(targets[0].turn, 53)
  assert.equal(targets[0].operationId, 'body53')
  assert.deepEqual(targets[0].nativeAnchor, undefined, '无锚点证据时不附锚点（不猜 seq）')
})
