// 重生成采用 × 最新发送签名（独占新文件，单叶）：
// 直接执行真实 createRegenerationAdoption(...).adopted（无 RPC / 无真实模型），随后**顺序执行**同链上的
// 真实 retainRegenerationRollbackState（从施缝后的作者 round-history.js 抽出），最后核 latestSendTarget。
// 目标：synthetic body 必须**物理删除**、非 body 运行条目归原 turn、original 基准逐字保留、
// 签名只落 original 轮/op（绝不签 synthetic），nativeAnchor 采用 plan 实际映射字段。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRegenerationAdoption } from '../lib/regeneration-adoption.js'
import { planRegenerationEvents } from '../lib/regeneration-events.js'
import { latestSendTarget } from '../lib/latest-send.js'
import { buildCore } from '../deploy/standard-seam-transforms.mjs'
import path from 'node:path'
import { maintenanceTargets } from '../deploy/standard-seams.mjs'

const TREE = fileURLToPath(new URL('../../../tmp/upstream-537e878-review/adapt/src-AQHmMH/dsh-tavern-537e878f882dbac8b651fba0f72ecb492a8a2b21/', import.meta.url))
const ROUND_HISTORY = 'tavern-plugin/lib/domain/round-history.js'
const inline = source => import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'))
// 从施缝后产物里按大括号配对抽出函数（任意缩进）。
function extractFunction(source, name) {
  const match = new RegExp('(^|\\n)([ \\t]*)function ' + name + '\\(').exec(source)
  if (!match) throw new Error('缺少函数：' + name)
  const start = match.index + match[1].length
  let depth = 0
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') { depth -= 1; if (depth === 0) return source.slice(start, index + 1) }
  }
  throw new Error('函数括号未闭合：' + name)
}
const baseline = (messageCount, hp) => ({ version: 1, messageCount, fields: { variables: { hp } }, participants: {} })

function regenerationChat() {
  return {
    id: 'chat-regen', sessionId: 'session-regen', _storageRevision: 9, mode: 'story',
    messages: [
      { role: 'user', text: '输入A' },
      { role: 'assistant', turn: 55, text: '原文A', swipeId: 0, swipes: ['原文A'], variables: [{ hp: 2 }] },
      { role: 'user', text: '输入B' },
      { role: 'assistant', turn: 58, text: '新正文', swipeId: 0, swipes: ['新正文'], variables: [{ hp: 5 }], nativeAnchor: { turn: 58, input: 44, reply: 33 } },
    ],
    timeline: {
      schemaVersion: 1, branchId: 'branch-1', revision: 58,
      operations: {
        bodyOriginal: { kind: 'body', role: 'body', status: 'completed', turn: 55, userText: '输入A', businessBefore: baseline(2, 2), nativeAnchor: { turn: 55, input: 11, reply: 22 } },
        bodySynthetic: { kind: 'body', role: 'body', status: 'running', turn: 58, userText: '新正文', businessBefore: baseline(4, 4) },
        agentOp: { kind: 'agent', role: 'settlement', status: 'running', turn: 58 },
      },
      checkpoints: [{ id: 'cp55', turn: 55, businessBefore: baseline(2, 2) }, { id: 'cp58', turn: 58, businessBefore: baseline(4, 4) }],
      participants: {},
    },
    rollbackSessionCuts: {},
  }
}

test('重生成采用：synthetic body 物理删除、运行条目归原turn且 latestSendTarget 只签 original 轮', async () => {
  // 只用 adopted/plan 之外不取用其它入口：chats 需给出形状（构造期解构），运行期 adopted 不调用它们。
  const adoptionTool = createRegenerationAdoption({ chats: { read: async () => undefined, update: async () => undefined, readRollbackOperationSnapshot: () => undefined } })
  const chat = regenerationChat()
  const checkpoint = { id: 'cp55', turn: 55, businessBefore: baseline(2, 2) }
  const original = { ...regenerationChat(), timeline: { ...regenerationChat().timeline, operations: {}, checkpoints: [checkpoint] }, rollbackSessionCuts: { '55': { 'session-back': 3 } } }
  const adoption = { version: 1, keep: 3, anchor: { turn: 55, input: 33, reply: 44 }, expected: [], output: [] }
  const next = adoptionTool.adopted(chat, {
    oldTurn: 55, syntheticTurn: 58,
    generatedAssistant: chat.messages.at(-1), originalAssistant: chat.messages[1], adoption,
  })
  // ① original 基准逐字保留：不得被 synthetic 的前像顶掉（messageCount 仍是 2、变量仍是 hp2）。
  assert.deepEqual(next.timeline.operations.bodyOriginal, chat.timeline.operations.bodyOriginal, 'original body 必须逐字保留')
  assert.equal(next.timeline.operations.bodyOriginal.businessBefore.messageCount, 2)
  assert.deepEqual(next.timeline.operations.bodyOriginal.businessBefore.fields.variables, { hp: 2 })
  // ② synthetic body 必须物理删除（对象节点不在），不得改号冒充原轮。
  assert.equal(Object.hasOwn(next.timeline.operations, 'bodySynthetic'), false, 'synthetic body 必须物理删除')
  assert.equal(Object.values(next.timeline.operations).filter(op => op.kind === 'body').length, 1, '不得存在两个同 turn 的 body（假 before）')
  // ③ 非 body 运行条目归原 turn；synthetic 轮 checkpoint 删除。
  assert.equal(next.timeline.operations.agentOp.turn, 55, '非 body 运行条目必须归原 turn')
  assert.deepEqual(next.timeline.checkpoints.filter(cp => Number(cp.turn) === 58), [], 'synthetic 轮 checkpoint 必须删除')
  // ④ 锚点由真实SQL计划映射，采用直接承接；不再用手造错轮计划要求下游重复审查。
  assert.deepEqual(next.messages.at(-1).nativeAnchor, { turn: 55, input: 33, reply: 44 }, 'nativeAnchor 必须用 plan 实际映射字段')
  assert.equal(next.messages.at(-1).turn, 55, '采用正文必须归原轮')
  const planned = planRegenerationEvents({ oldTurn: 55, syntheticTurn: 58, eventStart: 3, oldAssistantSeq: 2, events: [
    { seq: 0, type: 'turn/start', data: { turn: 55 } },
    { seq: 1, type: 'user/message', data: { id: 'u55', role: 'user', content: [], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { turn: 55, step: 1, message: { id: 'a55' } } },
    { seq: 3, type: 'turn/start', data: { turn: 58 } },
    { seq: 4, type: 'assistant/message', data: { turn: 58, step: 1, message: { id: 'a58' } } }
  ] })
  const mapped = adoptionTool.adopted(regenerationChat(), { oldTurn: 55, syntheticTurn: 58,
    generatedAssistant: regenerationChat().messages.at(-1), originalAssistant: regenerationChat().messages[1], adoption: planned })
  assert.deepEqual(mapped.messages.at(-1).nativeAnchor, { turn: 55, input: 1, reply: 2 }, '真实计划与采用不能留下临时轮锚点')
  const noAnchor = adoptionTool.adopted(regenerationChat(), { oldTurn: 55, syntheticTurn: 58,
    generatedAssistant: regenerationChat().messages.at(-1), originalAssistant: regenerationChat().messages[1], adoption: { ...adoption, anchor: null } })
  assert.equal(noAnchor.messages.at(-1).nativeAnchor, undefined, '计划无正文锚点时不得继承临时轮旧锚点')
  // ⑤ 顺序执行同链上的真实 retainRegenerationRollbackState：只重建 checkpoints/sessionCuts，绝不回填 synthetic body。
  // 从**完整 buildCore 产物**取该文件的施缝文本（单独对该函数所在文件重施前置接缝会因前置变换已改建而失配）。
  const seamedSources = new Map()
  for (const rel of maintenanceTargets) {
    const file = path.join(TREE, rel)
    const { existsSync } = await import('node:fs')
    if (existsSync(file)) seamedSources.set(rel, readFileSync(file, 'utf8'))
  }
  const seamed = buildCore(TREE, seamedSources).get(ROUND_HISTORY)
  const retainMod = await inline(`export const retain = ${extractFunction(seamed, 'retainRegenerationRollbackState')}\n`)
  const retained = retainMod.retain(next, original, checkpoint)
  assert.equal(Object.hasOwn(retained.timeline.operations, 'bodySynthetic'), false, 'retain 之后 synthetic body 仍必须不存在（不得回填）')
  assert.deepEqual(retained.timeline.operations.bodyOriginal, chat.timeline.operations.bodyOriginal, 'retain 不得改 original 基准')
  assert.deepEqual(retained.timeline.checkpoints, [checkpoint], 'retain 必须只留原轮 checkpoint（synthetic 轮不得回填）')
  assert.deepEqual(retained.rollbackSessionCuts, { '55': { 'session-back': 3 } }, 'retain 必须保留原轮后台切点')
  // ⑥ 签名：清干净的原生尾 ⇒ 只签 original 轮/op，锚点是 op 已存锚点。
  const cleanEvents = [
    { seq: 0, type: 'turn/start', data: { turn: 55 } },
    { seq: 1, type: 'user/message', data: { id: 'u55', role: 'user', content: [], source: { kind: 'user' } } },
    { seq: 5, type: 'turn/end', data: { turn: 55, reason: { kind: 'completed' } } },
  ]
  const signed = latestSendTarget(retained, { events: cleanEvents }, retained._storageRevision)
  assert.equal(signed?.kind, 'rollback')
  assert.equal(signed.turn, 55, '必须签 original 轮')
  assert.equal(signed.operationId, 'bodyOriginal', '必须签 original body op')
  assert.deepEqual(signed.nativeAnchor, { turn: 55, input: 11, reply: 22 }, '锚点必须来自 original op 的已存锚点')
  // ⑦ synthetic 残留证据（尚未替换 SQL 尾）时：绝不签 synthetic 轮（无 op/checkpoint ⇒ 不签发，而不是签 58）。
  const staleEvents = cleanEvents.concat([{ seq: 9, type: 'turn/start', data: { turn: 58 } }, { seq: 10, type: 'user/message', data: { id: 'u58', role: 'user', content: [], source: { kind: 'user' } } }])
  assert.equal(latestSendTarget(retained, { events: staleEvents }, retained._storageRevision).turn, 58, '无恢复记录证明为临时轮时按真实最新原生发送处理，不因缺前像禁用')
})
