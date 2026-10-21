// 188截图新增输入：真实作者首步变量变化与增量快照；仅合成SQLite，不连接现场。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { applyRegenerationInputTransform } from '../deploy/regeneration-input-transform.mjs'
import { applyStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'
import { fixture } from './regeneration-rollback-integration.test.mjs'
import { SqliteSessionDb } from '../store.js'
import { planRegenerationEvents } from '../lib/regeneration-events.js'

const AUTHOR = new URL('../../../tmp/adapt-dsh-021rc2-20261018/stable/tavern-plugin/lib/', import.meta.url)
const { createForegroundFrameSessionAdapter } = await import(new URL('domain/foreground-frame-session-adapter.js', AUTHOR))
const { retireForegroundFrames } = await import(new URL('domain/foreground-frame-retirement.js', AUTHOR))
const { appendVariableChanges } = await import(new URL('hooks/request.js', AUTHOR))
const { planRegenerationSurface, regenerationProjection, applyRegenerationProjection } = await import(new URL('domain/rollback-surface.js', AUTHOR))
const model = { kind: 'model', provider: 'review-provider', model: 'review-model' }
const chat = { id: 'chat-review-7ecd445', mode: 'story', mvu: { enabled: true }, messages: [
  { role: 'assistant', variables: [{ stat_data: { hp: 10 } }] },
  { role: 'assistant', variables: [{ stat_data: { hp: 11 } }] }
] }
function start(session, turn, regeneration = false, appendChanges = appendVariableChanges, currentChat = chat) {
  const eventStart = session.seq
  session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 })
  session.append('user/message', { id: 'input-' + session.seq, role: 'user', content: [{ type: 'text', text: '玩家输入' }],
    source: regeneration ? { kind: 'plugin', plugin: 'dsh-tavern-regen' } : { kind: 'user' } }, { surfaceOp: 'append' })
  retireForegroundFrames(session, { keepTurn: turn })
  const frame = { kind: 'foreground', frameId: 'frame-' + session.seq, chatId: chat.id, turn, operationId: 'operation-' + session.seq, branchId: 'review-branch', basedOnRevision: 1,
    source: { card: { systemPromptText: '卡片指令' } }, contributions: [
      { slot: 'activeWorldbook', text: '持续有效世界书', source: {} }, { slot: 'playerInput', text: '本次框架', source: {} }
    ] }
  const decision = createForegroundFrameSessionAdapter().append({ session, frame, messages: [], historyMessages: [], step: 1 })
  const withChanges = appendChanges({ chat: { ...currentChat, ...(regeneration ? { regenInProgress: true, regenRecovery: { turn: 53, eventStart } } : {}) }, payload: { agent: { session }, step: 1 }, decision: { kind: 'enter', messages: decision.messages } })
  for (const message of withChanges.messages) session.append('user/message', message, { surfaceOp: 'append' })
}
function finish(session, turn) {
  const reply = session.append('assistant/message', { turn, step: 1, message: { id: 'reply-' + session.seq, role: 'assistant',
    content: [{ type: 'text', text: '本次正文' }], source: model }, stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return reply
}
async function wiredHooks(root, source = readFileSync(new URL('hooks/request.js', AUTHOR), 'utf8')) {
  const wired = applyRegenerationInputTransform(source)
  assert.equal(applyRegenerationInputTransform(wired), wired, '生产入口重复施缝不叠加')
  const modulePath = path.join(root, 'request-wired.mjs')
  writeFileSync(modulePath, wired.replace(/from '(.+?)'/g, (all, spec) => spec.startsWith('.') ? 'from ' + JSON.stringify(new URL(spec, new URL('hooks/request.js', AUTHOR)).href) : all), 'utf8')
  return import(pathToFileURL(modulePath))
}
function adopt(Session, session, db, old, eventStart, previousRange) {
  const events = session.snapshotEvents(), replacement = planRegenerationSurface({ events, nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
  const plan = planRegenerationEvents({ events, nodes: session.surface.nodes, replacement, previousRange, oldTurn: 53, syntheticTurn: 54, eventStart, oldAssistantSeq: old.seq, chatId: chat.id })
  if (db.readMeta() === undefined) db.materialize(session.header, 0, events)
  else db.appendBatch(events.slice(db.cursor()), db.cursor())
  const output = plan.events.map((event, index) => ({ ...event, seq: plan.keep + index, time: event.time ?? 1 }))
  db.replaceRegeneratedTail(plan.keep, events.slice(plan.keep), output)
  const stored = db.readAll().events
  assert.deepEqual(stored, events.slice(0, plan.keep).concat(output), '真实SQL纯尾采用必须等于计划，不只比派生消息')
  return { session: Session.fromRestore(session.id, stored, session.header, 0, 'detached'), range: plan.attemptRange }
}
function counts(session) {
  const counts = {}
  for (const message of session.deriveMessages()) if (message.source?.plugin === 'dsh-tavern') {
    const form = message.source.form
    counts[form] = (counts[form] || 0) + 1
  }
  return counts
}

test('审查7ecd445：每次首步变量变化不能随快照保留而在同轮累计', async t => {
  const f = await fixture({ physical: true }), db = new SqliteSessionDb(path.join(f.root, 'review-variable-context.db'))
  try {
    const { appendVariableChanges: appendWiredChanges } = await wiredHooks(f.root)
    const original = f.Session.create('session-author-variable-context')
    let adopted = f.Session.create('session-sqlite-variable-context'), previousRange
    start(original, 53); let originalReply = finish(original, 53)
    start(adopted, 53); let adoptedReply = finish(adopted, 53)
    const originalCounts = [], physicalCounts = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const originalStart = original.seq, turn = 54 + attempt
      start(original, turn, true); const reply = finish(original, turn)
      const replacement = planRegenerationSurface({ events: original.snapshotEvents(), nodes: original.surface.nodes, oldAssistantSeq: originalReply.seq, eventStart: originalStart })
      applyRegenerationProjection(original, regenerationProjection(replacement, { ...reply.data, turn: 53 }, 'author-' + attempt))
      originalReply = original.surface.nodes.map(seq => original.eventAt(seq)).findLast(event => event.type === 'assistant/message')
      originalCounts.push(counts(original))

      const eventStart = adopted.seq
      start(adopted, 54, true, appendWiredChanges); finish(adopted, 54)
      const result = adopt(f.Session, adopted, db, adoptedReply, eventStart, previousRange)
      adopted = result.session
      previousRange = result.range
      assert.equal(db.readAll().events.filter(event => event.data?.source?.form === 'variable-changes').length, 1, 'SQL原事件也只剩本次变量输入，不留旧输入或空墓碑')
      adoptedReply = adopted.surface.nodes.map(seq => adopted.eventAt(seq)).findLast(event => event.type === 'assistant/message')
      physicalCounts.push(counts(adopted))
    }
    t.diagnostic(JSON.stringify({ originalCounts, physicalCounts }))
    assert.deepEqual(originalCounts.map(value => value['variable-changes']), [1, 1, 1], '原作者真实消息面替换本次尝试，原轮变量输入不会随重生成递增')
    assert.deepEqual(physicalCounts.map(value => value['variable-changes']), [1, 1, 1], 'SQLite采用不能把历次首步变量变化都当成持续快照')
  } finally { db.close(); await f.cleanup() }
})

test('重生成变量注入：当前无变化撤旧输入，前轮历史及独立通知不动', async () => {
  const f = await fixture({ physical: true }), db = new SqliteSessionDb(path.join(f.root, 'review-empty-variable-context.db'))
  try {
    const { appendVariableChanges: appendWiredChanges } = await wiredHooks(f.root)
    const session = f.Session.create('session-variable-scope')
    start(session, 52); finish(session, 52)
    const previous = session.snapshotEvents().find(event => event.data?.source?.form === 'variable-changes')
    start(session, 53); const old = finish(session, 53)
    const originalVariable = session.snapshotEvents().findLast(event => event.data?.source?.form === 'variable-changes')
    session.append('user/message', { ...originalVariable.data, id: 'already-accumulated-variable' }, { surfaceOp: 'append' })
    const notices = [
      { id: 'model-switch', role: 'user', content: [{ type: 'text', text: '独立模型切换' }], source: { kind: 'plugin', plugin: 'model-selection', form: 'notice' } },
      { id: 'foreign-variable-context', role: 'user', content: [{ type: 'text', text: '其它生产者同名form仍独立' }], source: { kind: 'plugin', plugin: 'independent-context', form: 'variable-changes' } }
    ]
    for (const message of notices) session.append('user/message', message, { surfaceOp: 'append' })
    const eventStart = session.seq, unchanged = { ...chat, messages: chat.messages.map(() => ({ role: 'assistant', variables: [{ stat_data: { hp: 10 } }] })) }
    start(session, 54, true, appendWiredChanges, unchanged); finish(session, 54)
    const result = adopt(f.Session, session, db, old, eventStart), stored = db.readAll().events
    assert.deepEqual(stored.find(event => event.seq === previous.seq), previous, '前一真实轮的变量输入原位不变')
    assert.deepEqual(stored.filter(event => event.data?.source?.plugin === 'dsh-tavern' && event.data.source.form === 'variable-changes'), [previous], '当前无变化时，原轮多条旧输入及空退役全部物理删除')
    for (const message of notices) assert.deepEqual(result.session.deriveMessages().find(value => value.id === message.id), message, '独立通知不因相邻位置或同名form误删')
  } finally { db.close(); await f.cleanup() }
})

test('重生成变量注入：标准接缝进入真实首步注册并可现场撤除', async () => {
  const f = await fixture({ physical: true }), tree = prepareCommentAuthorTree()
  assert.ok(tree, '需要既有真实作者源码，不以跳过冒充通过')
  try {
    const rel = 'tavern-plugin/lib/hooks/request.js', target = path.join(tree.appDir, rel)
    const original = tree.original.get(rel)
    applyStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
    const installed = activeSource(readFileSync(target, 'utf8'), rel)
    const { registerRequestHooks } = await wiredHooks(tree.appDir, installed), handlers = new Map()
    const session = f.Session.create('session-registered-variable-hook')
    start(session, 53); finish(session, 53)
    const old = session.snapshotEvents().find(event => event.data?.source?.form === 'variable-changes'), eventStart = session.seq
    session.append('turn/start', { turn: 54 }); session.append('step/start', { turn: 54, step: 1 })
    const currentChat = { ...chat, regenInProgress: true, regenRecovery: { turn: 53, eventStart } }
    registerRequestHooks({ ctx: { on: (name, run) => handlers.set(name, run) }, backgroundAgentRunner: { owns: () => false },
      cardMemory: { appendRecall: async ({ decision }) => decision }, chatForSession: async () => currentChat,
      foregroundStrategies: { prepareStep: async () => ({ kind: 'enter', messages: [] }) }, persistClearedBodyEdits: async () => {},
      requestCoordinates: new Map(), requestIdForMessages: () => 'request', sessionStore: { flush: async () => {} }, tavernRetryLimiter: { handle: () => {} } })
    const decision = await handlers.get('agent/pre-step')({ agent: { session }, step: 1, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
    assert.equal(session.surface.nodes.includes(old.seq), false, '真实pre-step注册路径必须执行旧变量退役')
    assert.equal(decision.messages.filter(message => message.source.form === 'variable-changes').length, 1)
    assert.ok(installed.includes('// [dsh-tavern-regeneration-variable-input:v1]'), '标准入口必须实际接入生产者')
    assert.equal(applyRegenerationInputTransform(installed), installed, '已安装入口重复变换零新增')
    assert.ok(installed.includes('const withChanges = appendVariableChanges({ chat, payload, decision: prepared })'), '真实注册的pre-step仍调用同一个已修生产者')
    uninstallStandardSeams({ appDir: tree.appDir, assertStopped: () => true })
    assert.equal(readFileSync(target, 'utf8'), original, '卸载只撤现场区块，作者原文完整保留')
  } finally { tree.cleanup(); await f.cleanup() }
})
