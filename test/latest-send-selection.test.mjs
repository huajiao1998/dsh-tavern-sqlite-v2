// 最新发送选择（latestSendRecord / latestSendTarget）独占新叶：
//   ① 四个操作状态共用同一 max turn；历史 failed 早轮不抢；新原生轮没基准不得误回前一轮；narrow 与完整坐标一致。
//   ② narrow 摘要（no anchor）与完整目标坐标一致；无基准的新原生轮仍可签最新范围（不依赖failed列表）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { latestSendRecord, latestSendTarget } from '../lib/latest-send.js'

const baseline = (messageCount, hp) => ({ version: 1, messageCount, fields: { variables: { hp } }, participants: {} })
const eventsFor = (...turns) => turns.flatMap((turn, index) => [
  { seq: index * 3, type: 'turn/start', data: { turn } },
  { seq: index * 3 + 1, type: 'user/message', data: { id: 'u' + turn, role: 'user', content: [], source: { kind: 'user' } } },
])
function chatOf({ latestStatus = 'completed', latestBaseline = baseline(4, 4), olderFailed = false, nativeOnly = true } = {}) {
  const operations = {}
  if (olderFailed) operations.bodyFailed = { kind: 'body', role: 'body', status: 'failed', turn: 51, userText: '历史失败', businessBefore: baseline(2, 2) }
  operations.bodyLatest = { kind: 'body', role: 'body', status: latestStatus, turn: 53, userText: '最新输入', ...(latestBaseline ? { businessBefore: latestBaseline } : {}), ...(nativeOnly ? { nativeAnchor: { turn: 53, input: 4, reply: null } } : {}) }
  return {
    id: 'chat-select', sessionId: 'session-select', _storageRevision: 7, windowRevision: 7, mode: 'story',
    messages: [{ role: 'user', text: '输入' }, { role: 'assistant', turn: 53, text: '正文', variables: [{ hp: 4 }] }],
    timeline: { schemaVersion: 1, branchId: 'branch-select', revision: 53, operations, checkpoints: [], participants: {} },
  }
}

test('最新发送选择：四状态共用同一max turn、历史failed不抢、新原生无基准不回前轮、narrow与完整坐标一致', () => {
  const events = eventsFor(51, 53)
  const turns = new Set()
  for (const status of ['running', 'completed', 'failed', '未知状态']) {
    const chat = chatOf({ latestStatus: status, olderFailed: true })
    const record = latestSendRecord(chat, { events })
    assert.equal(record.turn, 53, status + '：必须选最新轮 53（历史 failed 51 不得抢）')
    assert.equal(record.operationId, 'bodyLatest', status + '：必须选最新 op')
    const target = latestSendTarget(chat, { events }, chat._storageRevision)
    assert.equal(target.turn, 53)
    assert.equal(target.operationId, 'bodyLatest')
    assert.deepEqual(target.nativeAnchor, { turn: 53, input: 4, reply: null })
    turns.add(target.turn)
  }
  assert.deepEqual([...turns], [53], '四个状态必须共用同一 max turn 坐标')
  // 历史 failed 早轮不抢：即使它是 summary 候选（narrow cleanable）也不改变选择。
  const withSummary = { ...chatOf({ latestStatus: 'completed', olderFailed: true }), failureCleanup: { turn: 51, cleanable: true, operationId: 'bodyFailed' } }
  assert.equal(latestSendTarget(withSummary, { events }, withSummary._storageRevision).turn, 53, 'narrow summary 候选也不得抢过最新轮')
  // 新原生轮没有基准：不得误回前一轮（历史 51 有基准也不许回落）。
  const noBaseline = chatOf({ latestStatus: 'running', latestBaseline: null, olderFailed: true })
  assert.equal(latestSendRecord(noBaseline, { events }).turn, 53, '缺前像仍选最新轮，不回落旧轮')
  assert.equal(latestSendTarget(noBaseline, { events }, noBaseline._storageRevision).turn, 53)
  // narrow 与完整坐标一致：summary 与 body op 同轮同 op 时，target 坐标只由该轮决定（anchor 可缺）。
  const narrowChat = chatOf({ latestStatus: 'running', olderFailed: true })
  const narrowTarget = latestSendTarget(narrowChat, { events: [] }, narrowChat.windowRevision)
  const fullTarget = latestSendTarget(narrowChat, { events }, narrowChat._storageRevision)
  assert.equal(narrowTarget.turn, fullTarget.turn, 'narrow 与完整目标轮号必须一致')
  assert.equal(narrowTarget.operationId, fullTarget.operationId, 'narrow 与完整目标 op 必须一致')
  assert.equal(narrowTarget.revision, fullTarget.revision)
})

test('最新发送选择：无 target 时 baseline 只认 body/checkpoint 现有 source，不依赖 failed 列表', () => {
  const events = eventsFor(53)
  // 只有 checkpoint（无 body op）：仍必须签出该轮，且 anchor 可为空（narrow 不投影 anchor）。
  const checkpointChat = chatOf({ latestBaseline: null, olderFailed: false, nativeOnly: false })
  checkpointChat.timeline.checkpoints = [{ id: 'cp53', turn: 53, businessBefore: baseline(4, 4) }]
  const fromCheckpoint = latestSendTarget(checkpointChat, { events }, checkpointChat._storageRevision)
  assert.equal(fromCheckpoint.turn, 53, 'checkpoint 有基准时必须可签（不依赖 failed 列表）')
  assert.equal(fromCheckpoint.operationId, 'bodyLatest', 'op 存在时仍以 op 身份优先')
  // body与checkpoint都无基准：仍签最新轮，不回落更早轮。
  const bare = chatOf({ latestBaseline: null, olderFailed: true, nativeOnly: false })
  bare.timeline.operations.bodyLatest = { kind: 'body', role: 'body', status: 'running', turn: 53, userText: '最新输入' }
  assert.equal(latestSendTarget(bare, { events }, bare._storageRevision).turn, 53, '无前像仍可回退最新轮')
})

test('最新发送选择：同轮坏 body 前像不得遮蔽有效 checkpoint 前像', () => {
  const chat = chatOf({ latestBaseline: baseline(4, 4), nativeOnly: false })
  const valid = chat.timeline.operations.bodyLatest.businessBefore
  chat.timeline.operations.bodyLatest.businessBefore = { version: 1, fields: null, messageCount: 0, participants: {} }
  chat.timeline.checkpoints = [{ id: 'cp53', turn: 53, businessBefore: valid }]
  const record = latestSendRecord(chat, { events: eventsFor(53) })
  assert.equal(record.turn, 53)
  assert.equal(record.source, chat.timeline.checkpoints[0], '必须改用同轮完整 checkpoint 前像，不能把坏 body 当有效基准')
})
