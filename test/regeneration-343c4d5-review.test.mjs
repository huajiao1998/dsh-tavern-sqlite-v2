// 343c4d5审查三项缺陷的回归输入；真实作者/Session/合成SQLite，不改产品、不连接现场。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './regeneration-rollback-integration.test.mjs'
import { planRegenerationEvents } from '../lib/regeneration-events.js'

const modelSource = { kind: 'model', provider: 'fixture-provider', model: 'fixture-model' }
const message = (id, text, source = { kind: 'user' }) => ({ id, role: 'user', content: [{ type: 'text', text }], source })
const assistant = (turn, step, text, content = [{ type: 'text', text }]) => ({ turn, step, message: { id: text, role: 'assistant', content, source: modelSource }, stream: [] })
const close = (session, turn, step) => { session.append('step/end', { turn, step }); session.append('turn/end', { turn, reason: { kind: 'completed' } }) }
const reassemble = (Session, session, plan) => Session.fromRestore(session.id, session.snapshotEvents().slice(0, plan.keep).concat(plan.events.map((event, index) => ({ ...event, seq: plan.keep + index, time: 1 }))), session.header, 0, 'detached')

// 原版planRegenerationSurface会把旧正文与新尝试之间的外来上下文留在原位。
test('审查343c4d5：旧正文后且尝试前的普通上下文不能被物理采用删除', async () => {
  const f = await fixture({ physical: true })
  try {
    const old = f.session.snapshotEvents().findLast(event => event.type === 'assistant/message' && event.data.turn === 53)
    const notice = f.session.append('user/message', message('independent-context', '应保留的普通上下文', { kind: 'plugin', plugin: 'external-context' }), { surfaceOp: 'append' })
    await f.sessions.flush(f.session)
    const eventStart = f.session.seq
    await f.commitTurn(54, '审查新正文', { kind: 'plugin', plugin: 'dsh-tavern-regen' })
    // 原共享夹具仍用10月11日作者；这里直接核对本产品已适配的a390af17作者。
    const { planRegenerationSurface } = await import(new URL('../../../tmp/upstream-a390af17-adapt-20261016/author-fixture/src/dsh-tavern-a390af170cfe5ed3e9213a2801cbcce321e2008b/tavern-plugin/lib/domain/rollback-surface.js', import.meta.url))
    const events = f.session.snapshotEvents()
    const author = planRegenerationSurface({ events, nodes: f.session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
    assert.equal([author, ...author.cleanups].some(run => run.shadowedSeqs.includes(notice.seq)), false, '实际作者留住普通上下文')
    const plan = planRegenerationEvents({ events, oldTurn: 53, syntheticTurn: 54, eventStart, oldAssistantSeq: old.seq, chatId: 'chat-regen-rollback-fixture', nodes: f.session.surface.nodes, replacement: author })
    const output = plan.events.map((event, index) => ({ ...event, seq: plan.keep + index, time: 1 }))
    await f.persistencePort.replaceRegeneratedTail(f.session.header, plan.keep, events.slice(plan.keep), output)
    const stored = f.mainDb.readAll().events
    assert.ok(stored.some(event => event.data?.id === notice.data.id), '采用已经完成，但原先普通上下文不应静默丢失')
  } finally { await f.cleanup() }
})

// 真宿主同一路由/同系列不逐步重复request/header；首轮工具尝试被采用后不应成为下次不动的前缀。
test('审查343c4d5：无新请求头的连续重生成不能累积前次尝试工具输出', async () => {
  const f = await fixture({ physical: true })
  try {
    let s = f.Session.create('session-review-multistep')
    s.append('request/header', { header: { config: modelSource }, reason: 'initial' })
    s.append('request/context', { provider: modelSource.provider, model: modelSource.model })
    s.append('turn/start', { turn: 53 }); s.append('step/start', { turn: 53, step: 1 })
    s.append('user/message', message('original-input', '原输入'), { surfaceOp: 'append' })
    let old = s.append('assistant/message', assistant(53, 1, '最初正文'), { surfaceOp: 'append' }); close(s, 53, 1)
    let eventStart = s.seq
    s.append('turn/start', { turn: 54 }); s.append('step/start', { turn: 54, step: 1 })
    s.append('user/message', message('regenerate-input', '原输入', { kind: 'plugin', plugin: 'dsh-tavern-regen' }), { surfaceOp: 'append' })
    s.append('assistant/message', assistant(54, 1, '前次尝试工具调用', [{ type: 'tool-call', toolCallId: 'old-call', toolName: 'read', input: {} }]), { surfaceOp: 'append' })
    s.append('tool/result', { turn: 54, step: 1, message: { id: 'previous-attempt-result', role: 'user', content: [{ type: 'tool-result', toolCallId: 'old-call', content: [{ type: 'text', text: '前次尝试工具结果' }] }], source: { kind: 'tool', callId: 'old-call' } } }, { surfaceOp: 'append' })
    s.append('step/end', { turn: 54, step: 1 }); s.append('step/start', { turn: 54, step: 2 })
    s.append('assistant/message', assistant(54, 2, '第一次新正文'), { surfaceOp: 'append' }); close(s, 54, 2)
    let plan = planRegenerationEvents({ events: s.snapshotEvents(), oldTurn: 53, syntheticTurn: 54, eventStart, oldAssistantSeq: old.seq, chatId: 'chat-review' })
    s = reassemble(f.Session, s, plan)
    assert.equal(s.deriveMessages().some(message => message.id === 'previous-attempt-result'), true, '首次采用确实写回本次工具链')
    old = s.snapshotEvents().findLast(event => event.type === 'assistant/message')
    eventStart = s.seq
    s.append('turn/start', { turn: 54 }); s.append('step/start', { turn: 54, step: 1 })
    s.append('user/message', message('regenerate-input-2', '原输入', { kind: 'plugin', plugin: 'dsh-tavern-regen' }), { surfaceOp: 'append' })
    s.append('assistant/message', assistant(54, 1, '第二次新正文'), { surfaceOp: 'append' }); close(s, 54, 1)
    plan = planRegenerationEvents({ events: s.snapshotEvents(), oldTurn: 53, syntheticTurn: 54, eventStart, oldAssistantSeq: old.seq, chatId: 'chat-review', previousRange: plan.attemptRange })
    const cold = reassemble(f.Session, s, plan)
    assert.equal(cold.deriveMessages().some(message => message.id === 'previous-attempt-result'), false, '第二次重生成不应把前次尝试工具输出永久纳入保留前缀')
  } finally { await f.cleanup() }
})

// request/context按路由变化写入；新生成沿用刚切换的路由时不会重复该事件。
test('审查343c4d5：采用不能把刚切换的请求上下文回退到上一模型', async () => {
  const f = await fixture({ physical: true })
  try {
    const s = f.Session.create('session-review-request-context')
    const originalContext = { provider: 'fixture-provider', model: 'before-switch', contextWindow: 8192 }
    const currentContext = { provider: 'fixture-provider', model: 'fixture-model', contextWindow: 32768 }
    s.append('request/header', { header: { config: originalContext }, reason: 'initial' }); s.append('request/context', originalContext)
    s.append('turn/start', { turn: 53 }); s.append('step/start', { turn: 53, step: 1 })
    s.append('user/message', message('original-input', '原输入'), { surfaceOp: 'append' })
    s.append('request/header', { header: { config: modelSource }, reason: 'change' }); s.append('request/context', currentContext)
    const old = s.append('assistant/message', assistant(53, 1, '旧正文'), { surfaceOp: 'append' }); close(s, 53, 1)
    const eventStart = s.seq
    s.append('turn/start', { turn: 54 }); s.append('step/start', { turn: 54, step: 1 })
    s.append('user/message', message('regenerate-input', '原输入', { kind: 'plugin', plugin: 'dsh-tavern-regen' }), { surfaceOp: 'append' })
    s.append('request/header', { header: { config: modelSource }, reason: 'series' })
    s.append('assistant/message', assistant(54, 1, '新正文'), { surfaceOp: 'append' }); close(s, 54, 1)
    assert.deepEqual(s.requestContext(), currentContext)
    const plan = planRegenerationEvents({ events: s.snapshotEvents(), oldTurn: 53, syntheticTurn: 54, eventStart, oldAssistantSeq: old.seq, chatId: 'chat-review' })
    const cold = reassemble(f.Session, s, plan)
    assert.deepEqual(cold.requestContext(), currentContext, '真实请求仍使用当前模型，持久化上下文不能倒退')
  } finally { await f.cleanup() }
})
