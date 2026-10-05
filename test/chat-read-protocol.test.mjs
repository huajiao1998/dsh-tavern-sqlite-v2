// 定向闸：作者 2.4 新读协议（readWindow / readHelperContext / readSettlementBase）的数据库原生实现。
//
// 契约出处（核准下载的真身，2026-10-01）：b/lib/domain/native-conversation-storage.js:144/206/254、
// b/lib/domain/chat-journal-store.js:493-503/595-609、b/lib/domain/chat-persistence.js:325-337。
// 本闸只跑本机临时目录（mkdtemp），不读真实存档、不碰远端、不依赖 tmp/ 下的作者源码：
//   · 主断言用**本文件自带的原创小 fixture**（只覆盖契约用到的字段，不复制作者大模块）；
//   · 若本机恰好有核准下载的真身 scoped-messages.js，则额外用**真件**跑一遍结算基座（缺失即跳过）。
//
// 只用 node 内置：node test/chat-read-protocol.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createChatSqliteStore } from '../chat-sqlite-store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const noop = () => undefined

// 8 项必需 helper：与历史 fixture（store-version / store-legacy-read）同形，
// 这正是"新增协议 helper 不能进 REQUIRED_HELPERS、不得让历史构造失败"的现场证据。
function baseHelpers() {
  const helpers = Object.fromEntries([
    'copyJsonTree', 'diffJson', 'applyJsonChangesShared',
    'projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState',
    'projectChatBackgroundConfig', 'projectSettlementCheckpoint',
  ].map(name => [name, noop]))
  helpers.copyJsonTree = value => value === undefined ? undefined : structuredClone(value)
  helpers.diffJson = () => [{ path: [], op: 'replace' }]
  helpers.applyJsonChangesShared = (value, changes) => {
    const next = structuredClone(value)
    for (const change of changes) {
      assert.equal(change.op, 'set')
      let parent = next
      for (const key of change.path.slice(0, -1)) parent = parent[key]
      parent[change.path.at(-1)] = structuredClone(change.value)
    }
    return next
  }
  return helpers
}

// 原创的 scoped-messages 契约 fixture：只保留被断言的契约（length / 按位懒读 / 成员不可改 / 不可删）。
function fixtureScopedMessages(length, entries = [], readBase) {
  const owned = new Map(entries.map(([id, row]) => [String(id), row]))
  const indexable = key => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length
  return new Proxy([], {
    get(target, key, receiver) {
      if (key === 'length') return length
      if (indexable(key)) return owned.has(key) ? owned.get(key) : (typeof readBase === 'function' ? readBase(Number(key)) : undefined)
      return Reflect.get(target, key, receiver)
    },
    set(target, key, value) {
      if (key === 'length' && value === length) return true
      if (!indexable(key)) throw new Error('Scoped messages cannot change history membership')
      owned.set(key, value)
      return true
    },
    deleteProperty() { throw new Error('Scoped messages cannot delete history') },
  })
}

// 记录调用的协议投影 fixture：证明我们**只调注入的那一份**，并按它的返回值组装（不另造第二套投影）。
function fixtureProjections() {
  const calls = { message: [], context: [] }
  return {
    calls,
    projectTavernHelperMessage(source, messageId) {
      calls.message.push([messageId, source])
      const swipes = Array.isArray(source.swipes) && source.swipes.length > 0 ? source.swipes : [String(source.text ?? '')]
      const role = source.role === 'user' ? 'user' : 'assistant'
      return { message_id: messageId, role, message: swipes[0], swipe_id: 0, swipes, variables: {} }
    },
    projectTavernHelperContext(chat) {
      calls.context.push(chat)
      return { version: 1, chatId: String(chat?.id || ''), stateRevision: Math.max(0, Number(chat?._storageRevision) || 0), messages: [] }
    },
  }
}

async function rejectsCode(run, code) {
  await assert.rejects(run, error => error?.code === code && error.message.includes('revision'))
}

const row = (text, extra = {}) => ({ role: 'assistant', text, swipeId: 0, swipes: [text], variables: [], ...extra })
const MESSAGES = [
  { role: 'user', text: '你好', turn: 0 },
  row('第一轮', { turn: 1 }),
  row('第二轮', { turn: 2, variables: [{ stat_data: { hp: 3 }, schema: {} }] }),
  row('第三轮', { turn: 3 }),
  { role: 'user', text: '继续', turn: 0 },
]
const CHAT = {
  id: 'chat-window-fixture',
  sessionId: 'session-window-fixture',
  _storageRevision: 1,
  backgroundConfigVersion: 1,
  conversationFeaturesVersion: 1,
  mode: 'story',
  title: '窗口闸',
  timeline: { branchId: 'main', revision: 4, checkpoints: [{ id: 'cp1' }], operations: {} },
  messages: MESSAGES,
}

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-chat-read-protocol-'))
const chatsRoot = path.join(root, 'chats')
mkdirSync(chatsRoot, { recursive: true })
const stores = []
try {
  const chatId = CHAT.id
  const legacyId = 'chat-legacy-window'
  const bare = createChatSqliteStore({ dataRoot: root, helpers: baseHelpers(), legacyData: undefined })
  const projections = fixtureProjections()
  const full = createChatSqliteStore({
    dataRoot: root,
    helpers: { ...baseHelpers(), ...projections, createScopedMessages: fixtureScopedMessages },
    legacyData: undefined,
  })
  stores.push(bare, full)

  for (const name of ['readWindow', 'readHelperContext', 'readSettlementBase']) {
    assert.equal(typeof bare[name], 'function', '返回面必须提供 ' + name)
  }

  const created = await full.update(chatId, current => {
    assert.equal(current, undefined)
    return structuredClone(CHAT)
  })
  assert.equal(created._storageRevision, 1)

  // ---------- 1) readWindow：分页坐标 / revision / 检查点 ----------
  const page = await full.readWindow(chatId, { limit: 2, before: 3 })
  assert.equal(page.messageCount, 5)
  assert.equal(page.from, 1)
  assert.equal(page.to, 2)
  assert.equal(page.revision, 1)
  assert.deepEqual(page.chat.messages, MESSAGES.slice(1, 3), '窗口只含这一页，且是脱离副本')
  assert.deepEqual(page.chat.timeline.checkpoints, [], '默认 fields=settlement：不复制历史回退检查点')
  assert.equal(page.chat._storageRevision, 1)

  const withCheckpoints = await full.readWindow(chatId, { limit: 1, includeCheckpoints: true })
  assert.deepEqual(withCheckpoints.chat.timeline.checkpoints, [{ id: 'cp1' }], 'includeCheckpoints:true 保留检查点')
  assert.equal(withCheckpoints.from, 4)
  assert.equal(withCheckpoints.to, 4)

  const whole = await full.readWindow(chatId)
  assert.equal(whole.from, 0)
  assert.equal(whole.to, 4)
  assert.equal(whole.chat.messages.length, 5, '未省略历史时给完整页')

  assert.equal(await full.readWindow(chatId, { limit: 48, requirePartial: true }), null, '没有省略历史 ⇒ requirePartial 回 null')
  assert.notEqual(await full.readWindow(chatId, { limit: 2, before: 3, requirePartial: true }), null)

  page.chat.messages[0].text = '被改'
  assert.equal((await full.read(chatId)).messages[1].text, '第一轮', '窗口不得逃逸可写缓存对象')

  // ---------- 2) 参数与 revision 语义（对齐真身 native:144-158 / headAtRevision:92-101）----------
  for (const limit of [0, 501, 1.5, '2']) {
    await assert.rejects(() => full.readWindow(chatId, { limit }), /Invalid history window limit/)
  }
  for (const before of [-1, 6, 1.5]) {
    await assert.rejects(() => full.readWindow(chatId, { limit: 2, before }), /Invalid history window cursor/)
  }
  const empty = await full.readWindow(chatId, { limit: 2, before: 0 })
  assert.deepEqual(empty.chat.messages, [])
  assert.equal(empty.to, -1)

  assert.equal(await full.readWindow('chat-absent', { limit: 2 }), null, '无档回 null（不是抛）')
  const pinned = await full.readWindow(chatId, { limit: 2, revision: 1 })
  assert.equal(pinned.revision, 1, '当前态 revision 合法')
  assert.deepEqual(pinned.chat.messages, MESSAGES.slice(3, 5))
  for (const revision of [0, 'x', 2, 99]) await rejectsCode(() => full.readWindow(chatId, { limit: 2, revision }), 'DSH_TAVERN_REVISION_NOT_FOUND')

  // ---------- 3) readHelperContext：全量 / 切片两态 ----------
  const helperAll = await full.readHelperContext(chatId)
  assert.equal(helperAll.from, 0)
  assert.equal(helperAll.to, 4)
  assert.equal(helperAll.chat.messages, undefined, '真身 native 无 range 也回 header（messages 在 context 里）')
  assert.equal(helperAll.chat._storageRevision, 1)
  assert.equal(helperAll.context.chatId, chatId)
  assert.equal(helperAll.context.messages.length, 5)
  assert.deepEqual(helperAll.context.turnMessageIds, { 1: 1, 2: 2, 3: 3 }, 'turnMessageIds 只收 assistant 且 turn>0 的最后一层')
  assert.equal(projections.calls.message.length, 5, '逐楼调注入的 projectTavernHelperMessage')
  assert.equal(projections.calls.message[1][0], 1)
  assert.equal(projections.calls.message[1][1].text, '第一轮', '交给注入投影的是原楼层（含投影所需字段）')

  const helperRange = await full.readHelperContext(chatId, { from: 1, to: 2 })
  assert.deepEqual(Object.keys(helperRange.chat).sort(), ['_storageRevision', 'backgroundConfigVersion', 'conversationFeaturesVersion', 'id', 'sessionId'].sort())
  assert.equal(helperRange.from, 1)
  assert.equal(helperRange.to, 2)
  assert.deepEqual(helperRange.context.messages.map(row => row.message_id), [1, 2])
  assert.deepEqual(helperRange.context.turnMessageIds, { 1: 1, 2: 2 }, '切片态的 turnMessageIds 只覆盖本区间（与真身一致）')

  const clamped = await full.readHelperContext(chatId, { from: 3, to: 'x' })
  assert.equal(clamped.from, 3)
  assert.equal(clamped.to, 4, 'to 非整数 ⇒ 回 messageCount-1')
  assert.deepEqual((await full.readHelperContext(chatId, { from: 0, to: 99 })).to, 4)
  await rejectsCode(() => full.readHelperContext(chatId, { from: 0, to: 2, revision: 2 }), 'DSH_TAVERN_REVISION_NOT_FOUND')
  assert.equal(await full.readHelperContext('chat-absent'), undefined, '无档回 undefined')

  // ---------- 4) readSettlementBase：懒读 facade / ensure / previousMvu ----------
  const base = await full.readSettlementBase(chatId)
  assert.equal(base.messageCount, 5)
  assert.equal(base.denseMessages, true)
  assert.equal(base.chat._storageRevision, 1)
  assert.deepEqual(base.chat.timeline.checkpoints, [])
  assert.equal(base.chat.messages.length, 5)
  const firstRead = base.chat.messages[2]
  assert.equal(firstRead.text, '第二轮')
  assert.equal(base.chat.messages[2], firstRead, '同一楼层只脱离一次（逐楼记忆）')
  firstRead.text = '被改'
  assert.equal((await full.read(chatId)).messages[2].text, '第二轮', '结算基座不得逃逸可写行')
  assert.throws(() => { base.chat.messages.push({ role: 'user' }) }, /Scoped messages cannot change history membership/)

  await base.ensure([0, 4])
  await base.ensure()
  for (const index of [[5], [-1], [1.5]]) {
    await assert.rejects(() => base.ensure(index), /消息楼层不存在/)
  }

  assert.equal(await base.previousMvu(3), 2, '往回找上一条带 MVU 快照的楼')
  assert.equal(await base.previousMvu(2), -1)
  assert.equal(await base.previousMvu(0), -1)
  assert.equal(await base.previousMvu(99), 2)
  assert.equal(await base.previousMvu('x'), -1)
  assert.equal(await full.readSettlementBase('chat-absent'), undefined, '无档回 undefined')

  // ---------- 5) 原件（未迁移）档走同形内存读源，且不碰原件 ----------
  const legacyChat = { ...structuredClone(CHAT), id: legacyId, sessionId: 'session-legacy-window' }
  const legacyFile = path.join(chatsRoot, legacyId + '.json')
  writeFileSync(legacyFile, JSON.stringify(legacyChat), 'utf8')
  const legacyBytes = readFileSync(legacyFile)
  const legacyPage = await full.readWindow(legacyId, { limit: 2, before: 3 })
  assert.equal(legacyPage.from, 1)
  assert.equal(legacyPage.to, 2)
  assert.deepEqual(legacyPage.chat.messages, MESSAGES.slice(1, 3), '原件窗口与原档内容一致')
  assert.equal((await full.version(legacyId)).startsWith('legacy:'), true)
  const legacyBase = await full.readSettlementBase(legacyId)
  assert.equal(legacyBase.messageCount, 5)
  assert.equal(await legacyBase.previousMvu(3), 2)
  assert.equal((await full.readHelperContext(legacyId, { from: 0, to: 1 })).context.messages.length, 2)
  assert.deepEqual(readFileSync(legacyFile), legacyBytes, '只读路径不得改写原件字节')

  // ---------- 6) 协议 helper 缺注入 ⇒ 调用期响亮失败（不静默、不用第二份投影兜底）----------
  assert.equal((await bare.readWindow(chatId, { limit: 2 })).from, 3, 'readWindow 不需要额外 DI')
  await assert.rejects(() => bare.readHelperContext(chatId), /需要注入 helper projectTavernHelperMessage/)
  await assert.rejects(() => bare.readSettlementBase(chatId), /需要注入 helper createScopedMessages/)

  // ---------- 7) 可选：本机有真身 scoped-messages.js 就用真件再跑一遍（缺即跳过）----------
  const realScoped = path.resolve(HERE, '../../../tmp/plg-standard-1001-code/b/lib/domain/scoped-messages.js')
  if (existsSync(realScoped)) {
    const { createScopedMessages } = await import(pathToFileURL(realScoped).href)
    const realStore = createChatSqliteStore({
      dataRoot: root,
      helpers: { ...baseHelpers(), ...fixtureProjections(), createScopedMessages },
      legacyData: undefined,
    })
    stores.push(realStore)
    const realBase = await realStore.readSettlementBase(chatId)
    assert.equal(realBase.chat.messages.length, 5)
    assert.equal(realBase.chat.messages[3].text, '第三轮')
    assert.equal(await realBase.previousMvu(3), 2)
    assert.throws(() => { realBase.chat.messages.push({}) }, /Scoped messages cannot change history membership/)
    console.log('chat-read-protocol: 真身 scoped-messages.js 交叉验证通过')
  } else {
    console.log('chat-read-protocol: 未发现本机真身 scoped-messages.js，跳过交叉验证（发布环境不依赖 tmp/）')
  }

  console.log('chat-read-protocol: 窗口/Helper 上下文/结算基座断言全部通过')
} finally {
  for (const instance of stores) {
    try { await instance.remove(CHAT.id) } catch { /* 未建库或已删 */ }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
