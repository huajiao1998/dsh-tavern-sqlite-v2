// 2577360审查新增输入：真实作者注入/范围、宿主系统提示投影、Session与合成SQLite；不连接现场。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fixture } from './regeneration-rollback-integration.test.mjs'
import { planRegenerationEvents } from '../lib/regeneration-events.js'
import { SqliteSessionDb } from '../store.js'

const AUTHOR = new URL('../../../tmp/upstream-a390af17-adapt-20261016/author-fixture/src/dsh-tavern-a390af170cfe5ed3e9213a2801cbcce321e2008b/tavern-plugin/lib/domain/', import.meta.url)
const { createForegroundFrameSessionAdapter } = await import(new URL('foreground-frame-session-adapter.js', AUTHOR))
const { retireForegroundFrames } = await import(new URL('foreground-frame-retirement.js', AUTHOR))
const { planRegenerationSurface } = await import(new URL('rollback-surface.js', AUTHOR))
const model = { kind: 'model', provider: 'review-provider', model: 'review-model' }
const input = (id, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text: '原玩家输入' }], source })
function open(session, turn, synthetic = false) {
  session.append('turn/start', { turn }); session.append('step/start', { turn, step: 1 })
  session.append('user/message', input('input-' + session.seq, synthetic ? { kind: 'plugin', plugin: 'dsh-tavern-regen' } : undefined), { surfaceOp: 'append' })
}
function finish(session, turn) {
  const reply = session.append('assistant/message', { turn, step: 1, message: { id: 'reply-' + session.seq, role: 'assistant', content: [{ type: 'text', text: '正文' }], source: model }, stream: [] }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 }); session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return reply
}
function planned(session, old, eventStart, previousRange) {
  const events = session.snapshotEvents(), replacement = planRegenerationSurface({ events, nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
  return planRegenerationEvents({ events, nodes: session.surface.nodes, replacement, previousRange, oldTurn: 53, syntheticTurn: 54, eventStart, oldAssistantSeq: old.seq, chatId: 'chat-review-2577360' })
}
function restore(Session, session, plan, db) {
  const original = session.snapshotEvents()
  if (db.readMeta() === undefined) db.materialize(session.header, 0, original)
  else if (db.cursor() < session.seq) db.appendBatch(original.slice(db.cursor()), db.cursor())
  const output = plan.events.map((event, index) => ({ ...event, seq: plan.keep + index, time: event.time ?? 1 }))
  db.replaceRegeneratedTail(plan.keep, original.slice(plan.keep), output)
  const events = db.readAll().events
  assert.deepEqual(events, original.slice(0, plan.keep).concat(output), '真实SQLite换尾结果与采用计划一致')
  return Session.fromRestore(session.id, structuredClone(events), session.header, 0, 'detached')
}

test('审查2577360：连续重生成沿用未重发的世界书及卡提示快照不能消失', async () => {
  const f = await fixture({ physical: true }), db = new SqliteSessionDb(path.join(f.root, 'review-context.db'))
  try {
    let session = f.Session.create('session-review-delta-context')
    const adapter = createForegroundFrameSessionAdapter()
    const appendFrame = (id, turn) => {
      retireForegroundFrames(session, { keepTurn: turn })
      const frame = { kind: 'foreground', frameId: id, chatId: 'chat-review-2577360', turn, operationId: id, branchId: 'review', basedOnRevision: 1,
        source: { card: { systemPromptText: '卡片持续有效指令' } },
        contributions: [{ slot: 'activeWorldbook', text: '世界书持续有效上下文', source: {} }, { slot: 'playerInput', text: '本次前台框架', source: {} }] }
      const adapted = adapter.append({ session, messages: [], historyMessages: session.deriveMessages(), step: 1, frame })
      for (const message of adapted.messages) session.append('user/message', message, { surfaceOp: 'append' })
      return adapted.messages
    }
    open(session, 53); let old = finish(session, 53)
    let eventStart = session.seq
    open(session, 54, true); const first = appendFrame('first', 54); finish(session, 54)
    assert.ok(first.some(message => message.source.form === 'worldbook-snapshot'))
    assert.ok(first.some(message => message.source.form === 'card-system-prompt-update'))
    let plan = planned(session, old, eventStart)
    session = restore(f.Session, session, plan, db)
    const snapshots = session.deriveMessages().filter(message => ['worldbook-snapshot', 'card-system-prompt-update'].includes(message.source?.form))
    assert.equal(snapshots.length, 2)
    assert.ok(snapshots.every(message => message.source.trace.turn === 53), '首次采用已按原轮重映射，不与临时54轮消息混比')
    for (let n = 0; n < 2; n++) {
      old = session.snapshotEvents().findLast(event => event.type === 'assistant/message')
      eventStart = session.seq
      open(session, 54, true); const next = appendFrame('next-' + n, 54); finish(session, 54)
      assert.equal(next.some(message => ['worldbook-snapshot', 'card-system-prompt-update'].includes(message.source.form)), false, '真实作者沿用旧有效快照，不会重复发送')
      plan = planned(session, old, eventStart, plan.attemptRange)
      session = restore(f.Session, session, plan, db)
      const messages = session.deriveMessages()
      assert.deepEqual(messages.filter(message => ['worldbook-snapshot', 'card-system-prompt-update'].includes(message.source?.form)), snapshots, '采用后仍应有刚才真实请求沿用的两个有效快照，不改内容或身份')
      assert.equal(db.readAll().events.filter(event => event.data?.source?.form === 'foreground-frame').length, 1, '延续快照不能重新带回旧frame或退役墓碑')
    }
  } finally { db.close(); await f.cleanup() }
})

test('审查2577360：系统提示再次替换不能被当作无目标墓碑跳过', async () => {
  const f = await fixture({ physical: true }), db = new SqliteSessionDb(path.join(f.root, 'review-context.db'))
  try {
    const requireHost = createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app', 'package.json'))
    const { createMessage } = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-llm')))
    // 当前Harness已升级消息来源格式；按Session同代rc.2真实构造器产生测试消息。
    const llm = readFileSync(new URL('../../../tmp/plg-threefix-1001/llm.js', import.meta.url), 'utf8')
    const factoryStart = llm.indexOf('function createSystemMessage(')
    const createSystemMessage = new Function('createMessage', llm.slice(factoryStart, llm.indexOf('\n}', factoryStart) + 2) + '\nreturn createSystemMessage;')(createMessage)
    const host = readFileSync(new URL('../../../tmp/projection-baseline-1001/clean-agent-loop.js', import.meta.url), 'utf8')
    const projectionSource = host.slice(host.indexOf('const SOURCE = "@deepseek-ai/dsh-system-prompt";'), host.indexOf('/** Tracks the last retained runtime-context snapshot'))
    const Projection = new Function('createSystemMessage', projectionSource + '\nreturn SystemPromptProjection;')(createSystemMessage)
    let session = f.Session.create('session-review-system-projection')
    const commit = (text, turn) => {
      const commits = new Projection(session).project(text, { inHistory: false, startsSeries: true })
      for (const { message, intent } of commits) session.append('system/message', { turn, step: 1, message }, intent)
      return commits
    }
    commit('最早系统提示', 52)
    open(session, 53); commit('原轮系统提示', 53); let old = finish(session, 53)
    let eventStart = session.seq
    open(session, 54, true); commit('本次新系统提示', 54); finish(session, 54)
    assert.equal(session.deriveMessages().find(message => message.role === 'system').content[0].text, '本次新系统提示')
    let plan = planned(session, old, eventStart)
    session = restore(f.Session, session, plan, db)
    assert.equal(session.deriveMessages().find(message => message.role === 'system').content[0].text, '本次新系统提示', '真实宿主正常系统替换必须采用，不能回到更早提示')
    for (const text of ['本次新系统提示', '']) {
      old = session.snapshotEvents().findLast(event => event.type === 'assistant/message')
      eventStart = session.seq
      open(session, 54, true); const commits = commit(text, 54); finish(session, 54)
      if (text) assert.equal(commits.length, 0, '同值时宿主不重写，仍须沿用上次有效系统提示')
      plan = planned(session, old, eventStart, plan.attemptRange)
      session = restore(f.Session, session, plan, db)
      const system = session.surface.nodes.map(seq => session.eventAt(seq)).filter(event => event.type === 'system/message')
      assert.equal(system.length, 1, '系统消息面保持原来唯一位置，包括主动清空时')
      assert.deepEqual(system[0].data.message.content, text ? [{ type: 'text', text }] : [], '未重发和主动清空都不能恢复早期系统提示')
      assert.equal(session.deriveMessages().filter(message => message.role === 'system').length, text ? 1 : 0, '宿主规则：空系统节点保留占位，但不派生为LLM消息')
    }
  } finally { db.close(); await f.cleanup() }
})
