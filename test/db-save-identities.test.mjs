// DB交换身份改写：只改结构化身份字段，正文/变量/anchor/原生事件数据原样保留。
// 独立于 codec 与 exchange：只消费 lib/db-save-identities.js 的纯函数契约。
// 全部输入为合成对象（dummychat-session），不读真实 archive/profile。
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownedSaveSessions, saveIdentityMap, rewriteSaveMetadata, rewriteSaveTables } from '../lib/db-save-identities.js'

const SOURCE_CHAT = 'chat-dummychat-session-source'
const SOURCE_SESSION = 'session-dummychat-source-1'
const SOURCE_BACKGROUND = 'session-dummychat-background-2'
const TARGET_CHAT = 'chat-dummychat-session-target'
const TARGET_SESSION = 'session-dummychat-target-1'
const TARGET_BACKGROUND = 'session-dummychat-target-2'
const SOURCE_BRANCH = 'branch-dummychat-source'
const TARGET_BRANCH = 'branch-dummychat-target'

/** 合成源档：message.text/sourceText/variables/anchor 里都埋 source 字样，用来看是否被字符串替换。 */
function sourceChat(overrides = {}) {
  const chat = {
    id: SOURCE_CHAT,
    sessionId: SOURCE_SESSION,
    mode: 'story',
    title: 'dummychat-session',
    cardDefinitionSnapshot: { name: 'dummychat-card', sourceChat: SOURCE_CHAT },
    variables: { scene: 'dummychat-session', sourceChat: SOURCE_CHAT, nested: { anchor: SOURCE_SESSION } },
    messages: [
      {
        role: 'assistant',
        turn: 1,
        text: '正文里提到 ' + SOURCE_CHAT + ' 与 ' + SOURCE_SESSION + ' 都不得被改写',
        sourceText: '原生 sourceText 原样保留 ' + SOURCE_CHAT,
        anchor: { id: SOURCE_SESSION, label: 'anchor-' + SOURCE_CHAT },
        variables: { hp: 3, sourceChat: SOURCE_CHAT },
        mvu: { pending: false }
      },
      { role: 'user', turn: 1, text: 'user 正文 ' + SOURCE_SESSION, anchor: SOURCE_SESSION }
    ],
    timeline: {
      branchId: SOURCE_BRANCH,
      participants: { main: { sessionId: SOURCE_SESSION }, side: { sessionId: SOURCE_BACKGROUND } },
      operations: {
        op1: { sessionId: SOURCE_BACKGROUND, status: 'done', tree: { sourceChat: SOURCE_CHAT } }
      },
      checkpoints: [
        {
          turn: 1,
          participants: { main: { sessionId: SOURCE_SESSION, boundary: 1 } },
          sessionCuts: { [SOURCE_BACKGROUND]: 1 }
        }
      ]
    },
    rollbackSessionCuts: { 1: { [SOURCE_SESSION]: 1 }, 2: { [SOURCE_BACKGROUND]: 2 } }
  }
  return Object.assign(chat, overrides)
}

function identity() {
  return {
    chatId: TARGET_CHAT,
    sessionId: TARGET_SESSION,
    branchId: TARGET_BRANCH,
    sessions: new Map([[SOURCE_SESSION, TARGET_SESSION], [SOURCE_BACKGROUND, TARGET_BACKGROUND]])
  }
}

test('DB导入仅改结构身份不替换正文变量anchor', () => {
  const chat = sourceChat()
  const out = rewriteSaveMetadata(chat, chat, identity())

  assert.equal(out.id, SOURCE_CHAT, '通用元数据不猜id语义；Chat头部id由专门表映射改写')
  assert.equal(out.sessionId, TARGET_SESSION, 'sessionId 按映射改写')
  assert.equal(out.timeline.branchId, TARGET_BRANCH, 'branchId 按映射改写')
  assert.equal(out.timeline.participants.main.sessionId, TARGET_SESSION)
  assert.equal(out.timeline.participants.side.sessionId, TARGET_BACKGROUND)
  assert.equal(out.timeline.operations.op1.sessionId, TARGET_BACKGROUND)

  const text = chat.messages[0]
  assert.equal(out.messages[0].text, text.text, 'message.text 原样保留，不做全局替换')
  assert.equal(out.messages[0].sourceText, text.sourceText, 'sourceText 原样保留')
  assert.equal(out.messages[0].anchor.id, SOURCE_SESSION, 'anchor 内部不做身份替换')
  assert.deepEqual(out.messages[0].variables, text.variables, 'message.variables 原样保留')
  assert.equal(out.messages[1].text, chat.messages[1].text)
  assert.equal(out.messages[1].anchor, SOURCE_SESSION)
  assert.deepEqual(out.variables, chat.variables, 'chat.variables 原样保留（含 sourceChat 字样）')
  assert.deepEqual(out.cardDefinitionSnapshot, chat.cardDefinitionSnapshot)
  assert.equal(JSON.stringify(out).includes(SOURCE_CHAT), true, 'source 字样只能出现在正文/变量/anchor 等文本键内')
  assert.notEqual(out.messages[0].text, undefined)
})

test('DB后台闭包拒绝外部会话及运行任务', () => {
  assert.deepEqual(ownedSaveSessions(sourceChat()).sort(), [SOURCE_SESSION, SOURCE_BACKGROUND].sort(), '闭包=本局自身+参与者/检查点/回退已确认会话')

  const external = sourceChat()
  external.timeline.operations.op2 = { sessionId: 'session-dummychat-external-9', status: 'done' }
  assert.throws(() => ownedSaveSessions(external), /后台操作缺少确切本局会话归属/, '闭包外 trace 不得被纳入')

  const running = sourceChat()
  running.timeline.operations.op1 = { sessionId: SOURCE_BACKGROUND, status: 'running' }
  assert.throws(() => ownedSaveSessions(running), /本局后台任务尚未完成/, '运行中的后台任务不得导出')

  const pending = sourceChat()
  pending.timeline.operations.op1 = { sessionId: SOURCE_BACKGROUND, status: 'pending' }
  assert.throws(() => ownedSaveSessions(pending), /本局后台任务尚未完成/)

  const busy = sourceChat({ settleStatus: 'running' })
  assert.throws(() => ownedSaveSessions(busy), /本局尚未静止/, '未静止档不得导出')
  const mvuPending = sourceChat()
  mvuPending.messages[0].mvu = { pending: true }
  assert.throws(() => ownedSaveSessions(mvuPending), /本局尚未静止/)
})

test('DB回退会话边界键重映射', () => {
  const chat = sourceChat()
  const out = rewriteSaveMetadata(chat, chat, identity())

  assert.deepEqual(out.rollbackSessionCuts, { 1: { [TARGET_SESSION]: 1 }, 2: { [TARGET_BACKGROUND]: 2 } }, '轮次数字键保持，会话键与边界值随身份重映射')
  assert.equal(Object.keys(out.rollbackSessionCuts).includes(SOURCE_SESSION), false, '不得残留源会话键')
  assert.deepEqual(out.timeline.checkpoints[0].sessionCuts, { [TARGET_BACKGROUND]: 1 })
  assert.equal(out.timeline.checkpoints[0].participants.main.sessionId, TARGET_SESSION)

  const unknown = sourceChat()
  unknown.rollbackSessionCuts = { 'not-a-turn': { [SOURCE_SESSION]: 1 } }
  assert.throws(() => rewriteSaveMetadata(unknown, unknown, identity()), /回退会话边界键无效/, '非数字且非闭包会话的键必须拒绝')

  const badBoundary = sourceChat()
  badBoundary.rollbackSessionCuts = { 2: { [SOURCE_SESSION]: -2 } }
  assert.throws(() => rewriteSaveMetadata(badBoundary, badBoundary, identity()), /回退边界无效/, '越界/负数边界必须拒绝')

  const escaped = sourceChat()
  escaped.timeline.operations.op3 = { sessionId: 'session-dummychat-external-9', status: 'done' }
  assert.throws(() => rewriteSaveMetadata(escaped, escaped, identity()), /闭包外会话引用/, '改写阶段再次拒绝闭包外会话引用')
})

test('DB新身份不复用sourceids', () => {
  const chat = sourceChat()
  const ids = ownedSaveSessions(chat)
  const map = saveIdentityMap(chat, ids)
  const sources = new Set(ids)

  assert.match(map.chatId, /^chat-/, '新chatId为独立生成')
  assert.match(map.sessionId, /^session-/, '新sessionId为独立生成')
  assert.equal(sources.has(map.chatId), false)
  assert.equal(sources.has(map.sessionId), false)
  assert.equal(map.sessionId, map.sessions.get(SOURCE_SESSION), '自身会话映射到新主身份')
  const values = [...map.sessions.values()]
  assert.equal(new Set(values).size, values.length, '新会话ID必须两两不同')
  for (const value of values) assert.equal(sources.has(value), false, '任何源ID都不得复用')

  const first = saveIdentityMap(chat, ids)
  assert.notEqual(first.sessionId, map.sessionId, '两次导入不共享身份')
  assert.notEqual(first.chatId, map.chatId)

  const collide = () => 'session-dummychat-collide'
  assert.throws(() => saveIdentityMap(chat, ids, collide), /身份映射冲突/, '生成器重复时必须拒绝而不是复用')

  assert.throws(() => saveIdentityMap({ sessionId: 'session-dummychat-other-3' }, ids), /身份映射冲突/, '自身会话缺失必须拒绝')
  let position = 0
  assert.throws(() => saveIdentityMap(chat, ids, () => ids[position++]), /身份映射冲突/, '生成器复用源ID必须拒绝')
})

test('DB头字段表只改写结构化身份行', () => {
  const chat = sourceChat()
  const id = identity()
  const tables = {
    archive_head_fields: [
      { key: 'id', ord: 0, kind: 0, value_json: JSON.stringify(chat.id) },
      { key: 'sessionId', ord: 1, kind: 0, value_json: JSON.stringify(chat.sessionId) },
      { key: 'cardPath', ord: 2, kind: 0, value_json: JSON.stringify('/source/机器/dummychat/card.json') },
      { key: 'title', ord: 3, kind: 0, value_json: JSON.stringify(chat.title) },
      { key: 'rollbackSessionCuts', ord: 4, kind: 0, value_json: JSON.stringify(chat.rollbackSessionCuts) },
      { key: 'messages', ord: 5, kind: 1, value_json: null }
    ],
    archive_messages: [{ message_index: 0, message_json: JSON.stringify(chat.messages[0]) }],
    archive_timeline_nodes: [{ node_key: '@meta', ord: -1, value_json: JSON.stringify({ branchId: SOURCE_BRANCH, participants: chat.timeline.participants }) }],
    sessions: [{ id: SOURCE_SESSION, header_json: JSON.stringify({ id: SOURCE_SESSION, parentSession: SOURCE_SESSION, sessionId: SOURCE_SESSION }) }],
    events: [{ seq: 0, type: 'message/assistant', time: 1, data_json: JSON.stringify({ text: '原生事件正文 ' + SOURCE_CHAT, sourceText: SOURCE_CHAT }), extra_json: null }],
    meta: [{ key: 'schema_version', value: '1' }]
  }
  const out = rewriteSaveTables(tables, chat, id, { cardPath: '/new/root/resources/card.json', cwd: '/new/root/resources' })

  const field = key => JSON.parse(out.archive_head_fields.find(row => row.key === key).value_json)
  assert.equal(field('id'), TARGET_CHAT)
  assert.equal(field('sessionId'), TARGET_SESSION)
  assert.equal(field('cardPath'), '/new/root/resources/card.json', '卡路径按新目标改写')
  assert.equal(field('title'), chat.title)
  assert.deepEqual(field('rollbackSessionCuts'), { 1: { [TARGET_SESSION]: 1 }, 2: { [TARGET_BACKGROUND]: 2 } })
  assert.equal(out.archive_head_fields.find(row => row.key === 'messages').value_json, null, 'messages占位行保持NULL')

  const message = JSON.parse(out.archive_messages[0].message_json)
  assert.equal(message.text, chat.messages[0].text)
  assert.equal(message.sourceText, chat.messages[0].sourceText)
  assert.deepEqual(message.anchor, chat.messages[0].anchor)

  const meta = JSON.parse(out.archive_timeline_nodes[0].value_json)
  assert.equal(meta.branchId, TARGET_BRANCH)
  assert.equal(meta.participants.main.sessionId, TARGET_SESSION)

  const header = JSON.parse(out.sessions[0].header_json)
  assert.equal(out.sessions[0].id, TARGET_SESSION)
  assert.equal(header.id, TARGET_SESSION)
  assert.equal(header.parentSession, TARGET_SESSION, '父会话身份随闭包重映射')
  assert.equal(header.cwd, '/new/root/resources')

  assert.deepEqual(out.events, tables.events, '原生事件表不得参与任何字符串替换')
  assert.equal(JSON.parse(out.events[0].data_json).text, '原生事件正文 ' + SOURCE_CHAT)
  assert.deepEqual(out.meta, [{ key: 'schema_version', value: '1' }])
  assert.equal(JSON.stringify(out.archive_messages[0]).includes(TARGET_CHAT), false, '正文里不得出现新身份字样')

  const outside = { ...tables, sessions: [{ id: 'session-dummychat-outside-7', header_json: '{}' }] }
  assert.throws(() => rewriteSaveTables(outside, chat, id), /DB会话不在导入闭包/)
})
