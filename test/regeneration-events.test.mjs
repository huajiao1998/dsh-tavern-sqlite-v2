// 计划器纯单元：引用映射（含真实 startSeq/endSeq 与多 step 工具链）与异档/后继输入零计划。
import test from 'node:test'
import assert from 'node:assert/strict'
import { planRegenerationEvents } from '../lib/regeneration-events.js'

const CHAT = 'chat-plan'
const ev = (seq, type, data, surfaceOp, sourceEventSeqs) => ({ seq, type, time: 1, data, ...(surfaceOp ? { surfaceOp } : {}), ...(sourceEventSeqs ? { sourceEventSeqs } : {}) })
const user = () => ev(1, 'user/message', { id: 'u53', role: 'user', content: [{ type: 'text', text: '原输入' }], source: { kind: 'user' } })
const oldAssistant = () => ev(2, 'assistant/message', { turn: 53, step: 1, message: { id: 'a53', role: 'assistant', content: [{ type: 'text', text: '旧正文' }], source: { kind: 'model', provider: 'p', model: 'm' } } })
const head = turn => ev(0, 'turn/start', { turn })
const base = () => [head(53), user(), oldAssistant()]
const tail = (start = 8) => [ev(start, 'turn/end', { turn: 54, reason: { kind: 'completed' } }), ev(start + 1, 'session/end-seed', {})]
const opts = () => ({ oldTurn: 53, syntheticTurn: 54, eventStart: 3, oldAssistantSeq: 2, chatId: CHAT })

test('重生成计划：多 step 工具链引用映射，replace 用真实 startSeq/endSeq 且 turn 归原轮', () => {
  const events = [...base(),
    ev(3, 'turn/start', { turn: 54 }),
    ev(4, 'step/start', { turn: 54, step: 1 }),
    ev(5, 'tool/call', { turn: 54, name: 'read', args: {} }),
    ev(6, 'tool/result', { turn: 54, ok: true }, undefined, [5]),
    ev(7, 'assistant/message', { turn: 54, step: 1, message: { id: 'a54', role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [{ chunk: 1 }] }, { op: 'replace', startSeq: 4, endSeq: 5 }, [4, 5]),
    ...tail(8)]
  const plan = planRegenerationEvents({ events, ...opts() })
  assert.equal(plan.keep, 2, '前缀固定到原 user 之后')
  assert.deepEqual(plan.events.map(e => e.type), ['step/start', 'tool/call', 'tool/result', 'assistant/message', 'turn/end'])
  assert.deepEqual(plan.events.map(e => e.data.turn), [53, 53, 53, 53, 53], '所有输出 turn 必须归原轮')
  assert.deepEqual(plan.events[2].sourceEventSeqs, [3], '工具引用必须映射到 keep + 重放下标')
  assert.deepEqual(plan.events[3].sourceEventSeqs, [2, 3])
  assert.deepEqual(plan.events[3].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 3 }, 'replace 区间按 startSeq/endSeq 严格映射')
  assert.deepEqual(plan.events[3].data.stream, [{ chunk: 1 }], 'stream 等字段不得删除')
  assert.equal(plan.events[4].data.reason.kind, 'completed', '收尾保留真实 reason')
  assert.equal(plan.originalTail.some(e => e.seq === 2), true, 'originalTail 供本次恢复')
})

test('重生成SQL适配：保留原轮上下文并透传新来源与扩展事件，不设白名单', () => {
  const context = (seq, source) => ev(seq, 'user/message', { id: 'context-' + seq, role: 'user', content: [{ type: 'text', text: '正常宿主上下文' }], source }, 'append')
  const events = [head(53), ev(1, 'step/start', { turn: 53, step: 1 }), { ...user(), seq: 2 },
    context(3, { kind: 'plugin', plugin: 'model-selection', form: 'notice' }),
    context(4, { kind: 'new-context-kind', plugin: 'unlisted-plugin', payload: { untouched: true } }),
    ev(5, 'request/header', { header: { marker: '旧请求' } }), { ...oldAssistant(), seq: 6 },
    ev(7, 'step/end', { turn: 53, step: 1 }), ev(8, 'turn/end', { turn: 53, reason: { kind: 'completed' } }),
    ev(9, 'agent/inbox/spliced', { inserted: [{ source: { plugin: 'unlisted-plugin' } }] }), ev(10, 'turn/start', { turn: 54 }),
    ev(11, 'step/start', { turn: 54, step: 1 }),
    context(12, { kind: 'plugin', plugin: 'dsh-tavern-regen' }),
    context(13, { kind: 'new-context-kind', plugin: 'unlisted-plugin', trace: { chatId: CHAT, turn: 54 } }),
    ev(14, 'request/header', { header: { marker: '新请求' } }),
    ev(15, 'control/edit', { turn: 54, value: 1 }, undefined, [13]),
    ev(16, 'assistant/message', { turn: 54, step: 1, message: { id: 'new-body', role: 'assistant', content: [{ type: 'text', text: '新正文' }], source: { kind: 'future-model', turn: 54 } } }, 'append', [11]),
    ev(17, 'step/end', { turn: 54, step: 1 }), ev(18, 'turn/end', { turn: 54, reason: { kind: 'completed' } }),
    { ...context(19, { kind: 'plugin', plugin: 'unlisted-retirement' }), surfaceOp: { op: 'replace', startSeq: 13, endSeq: 13 }, sourceEventSeqs: [13] },
    ev(20, 'extension/tail', { retained: true }), ev(21, 'session/end-seed', {})]
  const snapshot = structuredClone(events), plan = planRegenerationEvents({ events, ...opts(), eventStart: 9, oldAssistantSeq: 6, nodes: [2, 3, 4, 6, 16, 19], replacement: { shadowedSeqs: [6, 12, 13, 16], cleanups: [] } })
  assert.equal(plan.keep, 3, '原玩家输入之后换尾，独立通知按当前消息面搬回')
  assert.deepEqual(events, snapshot, 'SQL计划不修改源事件')
  assert.deepEqual(plan.anchor, { turn: 53, input: 2, reply: 8 })
  assert.deepEqual(plan.events.map(event => event.type), ['user/message', 'user/message', 'user/message', 'request/header', 'control/edit', 'assistant/message', 'step/end', 'turn/end', 'user/message', 'extension/tail'], '独立通知搬回；本次已有请求头，不搬重复旧头')
  assert.deepEqual(plan.events.slice(0,2).map(event=>event.data),events.slice(3,5).map(event=>event.data),'不按通知来源名称分类')
  assert.equal(plan.events[2].data.source.trace.turn, 53)
  assert.deepEqual(plan.events[4].sourceEventSeqs, [5])
  assert.deepEqual(plan.events[5].sourceEventSeqs, [1], '首个临时step接回原步骤')
  assert.equal(plan.events[5].data.message.source.kind, 'future-model', '不枚举来源类型')
  assert.equal(plan.events[5].data.message.source.turn, 53)
  assert.deepEqual(plan.events[8].surfaceOp, { op: 'replace', startSeq: 5, endSeq: 5 })
  assert.equal(plan.events.some(event => event.data?.source?.plugin === 'dsh-tavern-regen'), false)
})

test('重生成SQL边界：异档目标、独立玩家输入与失效引用不误写', () => {
  const foreign = [...base(), ev(3, 'turn/start', { turn: 54 }), ev(4, 'assistant/message', { turn: 54, step: 1, message: { id: 'x', role: 'assistant', content: [{ type: 'text', text: 't' }], source: { kind: 'plugin', plugin: 'other-plugin', trace: { chatId: 'other-chat' } } } }), ...tail(5)]
  assert.throws(() => planRegenerationEvents({ events: foreign, ...opts() }), /其它档/, '异档 trace 必须拒')
  const followUp = [...base(), ev(3, 'user/message', { id: 'u54', role: 'user', content: [{ type: 'text', text: '后继输入' }], source: { kind: 'user' } }), ev(4, 'turn/start', { turn: 54 }), ...tail(5)]
  assert.throws(() => planRegenerationEvents({ events: followUp, ...opts() }), /真实玩家输入/, '后继真实 user 必须拒（eventStart=4）')
  const injectedUser = [...base(), ev(3, 'turn/start', { turn: 54 }), ev(4, 'user/message', { id: 'u54', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }), ev(5, 'assistant/message', { turn: 54, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 't' }], source: { kind: 'model', provider: 'p', model: 'm' } } }), ...tail(6)]
  assert.throws(() => planRegenerationEvents({ events: injectedUser, ...opts() }), /真实玩家输入/, '临时轮内真实 user 必须拒')
  const badRef = [...base(), ev(3, 'turn/start', { turn: 54 }), ev(4, 'tool/result', { turn: 54 }, undefined, [2]), ev(5, 'assistant/message', { turn: 54, step: 1, message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: 't' }], source: { kind: 'model', provider: 'p', model: 'm' } } }), ...tail(6)]
  assert.throws(() => planRegenerationEvents({ events: badRef, ...opts() }), /引用指向被删除的事件/, '指向已删旧输出的引用必须拒')
})
