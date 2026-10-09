// S5 单楼写入接缝具名断言（**只写不跑**，待主批准后逐条 gate）：
//   两条真实消费点的窄写口换成插件原生出口——
//   · A 追加一楼：作者 turn-orchestration.js:597 `if (await store.patchChat(before.id, revision, changes, metadata)) return result`
//     → `store.appendMessages(before.id, before._storageRevision, { items, headerSets }, metadata)`（items＝完整尾 splice 的 items 保序原样；
//       headerSets＝头字段 sets 保序原样）；falsy ⇒ 原样续跑 3 次 attempt（原体），耗尽 null ⇒ finalize 落 updateChat 整档。
//   · B 单楼回写：作者 background-task-coordinator.js:256-257 → `store.setMessageFloor(chatId, before._storageRevision, messageId, { changes: 映射后changes }, metadata)`；
//     falsy ⇒ 不 return ⇒ 原体 `updateChat(chatId, chat => mutate(chat, messageId), metadata)` 兜底；apply/timeline CAS/serialize 语义原样。
// 范围：仅这两处（deploy/native-data-transform.mjs 的 S5 段）；不动 index.js 的 native-data 转换、不动候选/结算/模板/story 链。
// 事实依据（本轮只读核对）：两 domain 模块都经工厂拿注入 store（turn-orchestration.js:219/221、background-task-coordinator.js:24/25），
//   文件内**无** `chatJournalStore` 绑定 ⇒ 接缝调 `store.<method>`；宿主需在 index.js:3400-3414 / :2478-2479 的 adapter 字面量补方法。
// 不读真实档/远端/禁令对象；合成数据；只清自建 mkdtemp。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyNativeMessageTransform, isNativeMessageApplied, MESSAGE_ANCHORS, MESSAGE_FILES, MESSAGE_MARKER,
  MESSAGE_REQUIRED_BLOCKS, APPEND_MESSAGES_CALL, SET_MESSAGE_FLOOR_CALL,
  applyNativeMessageHostTransform, isNativeMessageHostApplied, MESSAGE_HOST_MARKER, MESSAGE_HOST_ANCHORS, MESSAGE_HOST_BLOCKS,
} from '../deploy/native-data-transform.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'
import { applyStandardSeams, uninstallStandardSeams, maintenanceTargets } from '../deploy/standard-seams.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR_ROOT = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/', import.meta.url)
const authorFile = relative => readFileSync(new URL(relative.replace(/^tavern-plugin\//, ''), AUTHOR_ROOT), 'utf8')

// 真 store 夹具的 8 个作者 helper（缺一即响亮失败，不 skip）
const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[name] = projUnused
for (const [name, fn] of Object.entries(HELPERS)) assert.equal(typeof fn, 'function', '作者 helper ' + name + ' 缺失：夹具无法对账')

function storeFixture(t, { chatId, label }) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-message-store-' + label + '-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS })
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  return { root, chatId, store }
}

const CHAT_ID = 'chat-message-host'
const SESSION_ID = 'session-message-host'
const CHAT = {
  id: CHAT_ID, sessionId: SESSION_ID, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  _storageRevision: 4, updatedAt: 1, cardPath: 'cards/host-card.json', settleStatus: 'pending',
  timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 4, participants: {}, operations: {} },
  messages: [
    { role: 'user', text: 'u0', turn: 1 },
    { role: 'assistant', text: 'a1', turn: 1, mvu: { pending: true } }
  ]
}

/** 取带标记的生成块（标记行 + 到终止行为止），去掉注释行。 */
function markedBlock(source, marker, terminator) {
  const lines = source.split('\n')
  const start = lines.findIndex(line => line.includes(marker))
  assert.ok(start >= 0, '生成物缺 S5 标记：' + marker)
  const end = lines.findIndex((line, index) => index > start && line.trimEnd().endsWith(terminator))
  assert.ok(end > start, '生成物缺该块终止行：' + terminator)
  return lines.slice(start, end + 1).filter(line => !line.trimStart().startsWith('//')).join('\n')
}

/** A 段：块内 `return result` 即"真值早退"；否则返回 { fellThrough:true }（＝作者会续跑 attempt）。 */
function runAppendBlock({ source, store, before, revision, changes, metadata, result }) {
  const block = markedBlock(source, MESSAGE_MARKER.appendMessages, '})()) return result')
  const fn = new Function('store', 'before', 'revision', 'changes', 'metadata', 'result',
    'return (async function () {\n' + block + '\nreturn { fellThrough: true }\n})()')
  return fn(store, before, revision, changes, metadata, result)
}

/** B 段：返回 { saved }（作者紧接着 `if (saved) return`；falsy ⇒ 原体 updateChat 兜底）。 */
function runFloorBlock({ source, store, chatId, before, messageId, changes, metadata }) {
  const block = markedBlock(source, MESSAGE_MARKER.setMessageFloor, '})) }, metadata)')
  const fn = new Function('store', 'chatId', 'before', 'messageId', 'changes', 'metadata',
    'return (async function () {\n' + block + '\nreturn { saved }\n})()')
  return fn(store, chatId, before, messageId, changes, metadata)
}

const exitRecorder = () => {
  const calls = []
  return { calls, record(name, ...args) { calls.push({ name, args }) } }
}

test('S5追加一楼items与headerSets保序透传且不直连patchChat', async t => {
  const source = applyNativeMessageTransform(authorFile('lib/domain/turn-orchestration.js'), 'appendMessages')
  const spy = exitRecorder()
  const metadata = { source: 'foreground.commit', operationId: 'op-body-1' }
  const appendedFloors = [{ role: 'user', text: '本轮输入', turn: 9 }, { role: 'assistant', text: '本轮正文', turn: 9 }]
  const changes = [
    { op: 'set', path: ['settleStatus'], value: 'pending' },
    { op: 'set', path: ['settleError'], value: null },
    { op: 'set', path: ['promptTemplateInput'], value: undefined },
    { op: 'splice', path: ['messages'], index: 2, deleteCount: 0, items: appendedFloors }
  ]
  const store = {
    appendMessages(...args) { spy.record('appendMessages', ...args); return { _storageRevision: 5 } },
    patchChat() { throw new Error('S5 接缝不得直连 store.patchChat') },
    updateChat() { throw new Error('S5 接缝不得直连 store.updateChat') }
  }
  const before = { id: CHAT_ID, _storageRevision: 4 }
  const result = await runAppendBlock({ source, store, before, revision: 4, changes, metadata, result: { saved: true } })
  assert.deepEqual(result, { saved: true }, '出口返回真值 ⇒ 原样早退 result（控制流不变）')
  assert.equal(spy.calls.length, 1, '必须恰一次调用原生出口')
  const [call] = spy.calls
  assert.equal(call.name, 'appendMessages')
  assert.equal(call.args[0], CHAT_ID, '第一参＝before.id')
  assert.equal(call.args[1], 4, '第二参＝before._storageRevision（CAS pin；不是局部 revision 变量）')
  assert.deepEqual(call.args[2].items, appendedFloors, 'items 必须是 splice 的 items 原样（同一引用、保序）')
  // 头写集＝**普通对象**（store normalizeHeaderSets 只收顶层普通对象）：顶层 set 保序落键，undefined 值＝删除语义
  assert.deepEqual(call.args[2].headerSets, { settleStatus: 'pending', settleError: null, promptTemplateInput: undefined }, 'headerSets 必须是顶层普通对象（含 undefined 值项）')
  assert.equal(Array.isArray(call.args[2].headerSets), false, 'headerSets 不得是数组（store 直接拒数组）')
  assert.deepEqual(Object.keys(call.args[2].headerSets), ['settleStatus', 'settleError', 'promptTemplateInput'], '顶层键必须保序')
  assert.equal(Object.keys(call.args[2]).sort().join(','), 'headerSets,items', '载荷只含 {items,headerSets}')
  assert.equal(call.args[3], metadata, 'metadata 必须原样透传（同一对象引用）')
  // 无 splice（纯头字段提交）时 items 为空数组，仍走同一出口
  spy.calls.length = 0
  await runAppendBlock({ source, store, before, revision: 4, changes: [changes[0]], metadata, result: {} })
  assert.deepEqual(spy.calls[0].args[2], { items: [], headerSets: { settleStatus: 'pending' } }, '纯头字段提交 ⇒ items=[]、headerSets 对象')
  // 顶层 delete ⇒ undefined（store 视为删除该头键）
  spy.calls.length = 0
  await runAppendBlock({ source, store, before, revision: 4, changes: [{ op: 'delete', path: ['settleError'] }], metadata, result: {} })
  assert.deepEqual(Object.keys(spy.calls[0].args[2].headerSets), ['settleError'], 'delete 必须落键')
  assert.equal(spy.calls[0].args[2].headerSets.settleError, undefined, 'delete ⇒ undefined（store 删除语义）')
  // 不可表示项必须**响亮拒**（不 patchChat 兜底、不静默丢写集）
  const callsBeforeRejects = spy.calls.length
  for (const [label, bad] of [
    ['深层路径', [{ op: 'set', path: ['timeline', 'operations', 'op-1'], value: { kind: 'body' } }]],
    ['保留键 timeline', [{ op: 'set', path: ['timeline'], value: {} }]],
    ['保留键 messages', [{ op: 'set', path: ['messages'], value: [] }]],
    ['命令自管键', [{ op: 'set', path: ['_storageRevision'], value: 9 }]],
    ['非法键', [{ op: 'set', path: ['__proto__'], value: {} }]],
    ['重复顶层键', [{ op: 'set', path: ['settleStatus'], value: 'a' }, { op: 'set', path: ['settleStatus'], value: 'b' }]],
    ['非 messages 的 splice', [{ op: 'splice', path: ['timeline', 'checkpoints'], index: 0, deleteCount: 0, items: [{}] }]],
    ['未知操作', [{ op: 'move', path: ['settleStatus'], value: 'x' }]],
  ]) {
    await assert.rejects(() => runAppendBlock({ source, store, before, revision: 4, changes: bad, metadata, result: {} }),
      /追加命令不接受/, label + ' 必须响亮拒（不得 patchChat 兜底）')
  }
  assert.equal(spy.calls.length, callsBeforeRejects, '被拒项不得触达出口（合法提交计数不变）')
  void t
})

test('S5追加一楼falsy回退与CAS冲突不抛且出口缺失响亮', async t => {
  const source = applyNativeMessageTransform(authorFile('lib/domain/turn-orchestration.js'), 'appendMessages')
  const before = { id: CHAT_ID, _storageRevision: 4 }
  const changes = [{ op: 'splice', path: ['messages'], index: 2, deleteCount: 0, items: [{ role: 'assistant', text: 'x' }] }]
  // 出口返回 falsy（CAS 冲突）：不抛、不早退 ⇒ 作者原样续跑 attempt 循环
  for (const falsy of [undefined, false, null, 0]) {
    const store = { appendMessages: async () => falsy, patchChat() { throw new Error('不得直连 patchChat') } }
    const result = await runAppendBlock({ source, store, before, revision: 4, changes, metadata: {}, result: { saved: true } })
    assert.deepEqual(result, { fellThrough: true }, 'falsy ⇒ 不早退（等于 CAS 冲突时作者续跑下一次 attempt）')
  }
  // 出口抛错必须上抛（不吞、不静默转整档）
  const broken = { appendMessages: async () => { throw new Error('夹具：出口显式失败') }, patchChat() { throw new Error('不得直连 patchChat') } }
  await assert.rejects(
    () => runAppendBlock({ source, store: broken, before, revision: 4, changes, metadata: {}, result: {} }),
    /夹具：出口显式失败/, '出口抛错必须上抛')
  // 出口缺失 ⇒ 装配/调用期响亮抛错（不静默走整档 patch）
  const missing = { patchChat() { throw new Error('不得直连 patchChat') } }
  await assert.rejects(
    () => runAppendBlock({ source, store: missing, before, revision: 4, changes, metadata: {}, result: {} }),
    /宿主接线缺失：store\.appendMessages 未装配/, '出口缺失必须响亮抛错')
  // 作者原体的重试/回退阶梯不得被改动
  assert.equal(source.includes('for (let attempt = 0; attempt < 3; attempt++)'), true, '3 次 attempt 循环必须原样保留')
  assert.equal(source.includes('if (messages.length) changes.push({ op: \'splice\', path: [\'messages\'], index: count, deleteCount: 0, items: messages })'), true, 'splice 形态构造原样保留')
  assert.equal(source.split(APPEND_MESSAGES_CALL).length - 1, 0, '旧调用行必须已被替换（无残留）')
  void t
})

test('S5单楼回写深叶子映射透传且不直连patchChat', async t => {
  const source = applyNativeMessageTransform(authorFile('lib/domain/background-task-coordinator.js'), 'setMessageFloor')
  const spy = exitRecorder()
  const metadata = { source: 'background.settlement.checkpoint', operationId: 'op-bg-1' }
  const messageId = 1
  // 作者窄分支的 changes 形状：目标楼被当作第 0 楼 ⇒ path=['messages',0,<深叶子…>]
  const changes = [
    { op: 'set', path: ['messages', 0, 'mvu', 'pendingSubmission', 'variables'], value: { hp: 3 } },
    { op: 'set', path: ['messages', 0, 'mvu', 'delivery'], value: { version: 1, taskId: 'task-1' } }
  ]
  const store = {
    setMessageFloor(...args) { spy.record('setMessageFloor', ...args); return true },
    patchChat() { throw new Error('S5 接缝不得直连 store.patchChat') },
    updateChat() { throw new Error('S5 接缝不得直连 store.updateChat（falsy 兜底在作者原体）') }
  }
  const before = { _storageRevision: 7 }
  const result = await runFloorBlock({ source, store, chatId: CHAT_ID, before, messageId, changes, metadata })
  assert.deepEqual(result, { saved: true }, '出口返回真值 ⇒ saved 为真（作者随后 `if (saved) return`）')
  assert.equal(spy.calls.length, 1, '必须恰一次调用原生出口')
  const [call] = spy.calls
  assert.equal(call.name, 'setMessageFloor')
  assert.equal(call.args[0], CHAT_ID, '第一参＝chatId')
  assert.equal(call.args[1], 7, '第二参＝before._storageRevision（CAS pin）')
  assert.equal(call.args[2], messageId, '第三参＝messageId（目标楼）')
  const mapped = call.args[3].changes
  assert.deepEqual(mapped, [
    { op: 'set', path: ['messages', messageId, 'mvu', 'pendingSubmission', 'variables'], value: { hp: 3 } },
    { op: 'set', path: ['messages', messageId, 'mvu', 'delivery'], value: { version: 1, taskId: 'task-1' } }
  ], 'changes 必须把第 0 楼前缀重映射为 messages/messageId/深叶子（保序、值原样）')
  assert.equal(call.args[4], metadata, 'metadata 必须原样透传（同一对象引用）')
  assert.deepEqual(Object.keys(call.args[3]), ['changes'], '载荷只含 {changes}')
  void t
})

test('S5单楼回写falsy落作者updateChat兜底且出口缺失响亮', async t => {
  const source = applyNativeMessageTransform(authorFile('lib/domain/background-task-coordinator.js'), 'setMessageFloor')
  const before = { _storageRevision: 7 }
  const changes = [{ op: 'set', path: ['messages', 0, 'mvuBaseline'], value: { swipeId: 0 } }]
  for (const falsy of [undefined, false, null]) {
    const store = { setMessageFloor: async () => falsy, patchChat() { throw new Error('不得直连 patchChat') } }
    const result = await runFloorBlock({ source, store, chatId: CHAT_ID, before, messageId: 1, changes, metadata: {} })
    assert.deepEqual(result, { saved: falsy }, 'falsy ⇒ saved 为原样假值（不抛）')
    assert.equal(Boolean(result.saved), false, 'falsy ⇒ 作者 `if (saved) return` 不 return ⇒ 落 updateChat 兜底')
  }
  const broken = { setMessageFloor: async () => { throw new Error('夹具：出口显式失败') }, patchChat() { throw new Error('不得直连 patchChat') } }
  await assert.rejects(
    () => runFloorBlock({ source, store: broken, chatId: CHAT_ID, before, messageId: 1, changes, metadata: {} }),
    /夹具：出口显式失败/, '出口抛错必须上抛')
  const missing = { patchChat() { throw new Error('不得直连 patchChat') } }
  await assert.rejects(
    () => runFloorBlock({ source, store: missing, chatId: CHAT_ID, before, messageId: 1, changes, metadata: {} }),
    /宿主接线缺失：store\.setMessageFloor 未装配/, '出口缺失必须响亮抛错')
  // 作者原体兜底与 CAS/serialize 语义不得被改动
  assert.equal(source.includes('const saved = await store.updateChat(chatId, chat => mutate(chat, messageId), metadata)'), true, 'updateChat 兜底行必须原样保留')
  assert.equal(source.includes("if (operation?.status !== 'running' || state.branchId !== begun.value.basedOn.branchId"), true, 'timeline CAS guard 原样保留')
  assert.equal(source.includes('return serialize(chatId, async () => {'), true, 'serialize 串行语义原样保留')
  assert.equal(source.split(SET_MESSAGE_FLOOR_CALL).length - 1, 0, '旧调用块必须已被替换（无残留）')
  void t
})

test('S5单楼写入真库revision作CASpin且falsy不写库', async t => {
  const tSource = applyNativeMessageTransform(authorFile('lib/domain/turn-orchestration.js'), 'appendMessages')
  const fSource = applyNativeMessageTransform(authorFile('lib/domain/background-task-coordinator.js'), 'setMessageFloor')
  const real = storeFixture(t, { chatId: CHAT_ID, label: 'db' })
  await real.store.update(real.chatId, () => CHAT)
  const stored = await real.store.read(real.chatId)
  assert.equal(Number.isSafeInteger(stored._storageRevision), true, '前置：真库给出可核 _storageRevision')
  // A：真库 revision 作 CAS pin 传给出口；falsy ⇒ 真库 revision 不变（本块不自作写入）
  const appendSpy = exitRecorder()
  const appendStore = { appendMessages(...args) { appendSpy.record('appendMessages', ...args); return undefined } }
  const appendResult = await runAppendBlock({
    source: tSource, store: appendStore, before: stored, revision: stored._storageRevision,
    changes: [{ op: 'splice', path: ['messages'], index: stored.messages.length, deleteCount: 0, items: [{ role: 'assistant', text: '新楼' }] }],
    metadata: { source: 'foreground.commit' }, result: { saved: true }
  })
  assert.deepEqual(appendResult, { fellThrough: true }, '真库 pin 下 falsy ⇒ 仍是续跑语义')
  assert.equal(appendSpy.calls[0].args[1], stored._storageRevision, 'A 出口收到的 CAS pin 必须等于真库 revision')
  assert.equal(appendSpy.calls[0].args[2].items.length, 1)
  const afterA = await real.store.read(real.chatId)
  assert.equal(afterA._storageRevision, stored._storageRevision, 'falsy 路径不得改动真库 revision（写入由出口/作者兜底负责）')
  // B：真库 revision 作 pin；falsy ⇒ 真库仍不变
  const floorSpy = exitRecorder()
  const floorStore = { setMessageFloor(...args) { floorSpy.record('setMessageFloor', ...args); return undefined } }
  const floorResult = await runFloorBlock({
    source: fSource, store: floorStore, chatId: CHAT_ID, before: stored, messageId: 1,
    changes: [{ op: 'set', path: ['messages', 0, 'mvu', 'pendingSubmission'], value: { variables: { hp: 5 } } }],
    metadata: { source: 'background.settlement.checkpoint' }
  })
  assert.equal(Boolean(floorResult.saved), false, '真库 pin 下 falsy ⇒ saved 为假')
  assert.equal(floorSpy.calls[0].args[1], stored._storageRevision, 'B 出口收到的 CAS pin 必须等于真库 revision')
  const afterB = await real.store.read(real.chatId)
  assert.equal(afterB._storageRevision, stored._storageRevision, 'falsy 路径不得改动真库 revision')
  assert.equal(afterB.messages.length, stored.messages.length, 'falsy 路径不得改动真库楼层数')
  void t
})

test('S5单楼写入转换幂等半应用拒与锚点唯一', async t => {
  for (const [file, name] of Object.entries(MESSAGE_FILES)) {
    const source = authorFile(file)
    assert.equal(source.split(MESSAGE_ANCHORS[name]).length - 1, 1, name + ' 锚点在作者原文恰一处（唯一整块）')
    const once = applyNativeMessageTransform(source, name)
    assert.equal(isNativeMessageApplied(once, name), true)
    assert.equal(applyNativeMessageTransform(once, name), once, name + ' 已应用 ⇒ 逐字节幂等')
    assert.equal(once.split(MESSAGE_MARKER[name]).length - 1, 1, name + ' 标记恰一处')
    // 半应用：标记出现两次 ⇒ 拒
    assert.throws(() => applyNativeMessageTransform(once + '\n' + MESSAGE_MARKER[name] + '\n', name), /标记数异常（半应用/, name + ' 半应用必须拒')
    // 缺块：把必需块改成不可能匹配的形式（模拟生成物被外部改动）⇒ isNativeMessageApplied 必须抛（不伪绿）
    const brokenBlocks = Object.keys(MESSAGE_REQUIRED_BLOCKS[name])[0]
    assert.throws(() => isNativeMessageApplied(once.replace(MESSAGE_REQUIRED_BLOCKS[name][brokenBlocks], '/* 被外部删除 */'), name), /生成物缺块/, name + ' 缺块必须响亮失败')
    // 锚点不唯一 ⇒ 拒（人为复制一份调用行）
    assert.throws(() => applyNativeMessageTransform(source + '\n' + MESSAGE_ANCHORS[name] + '\n', name), /锚点不唯一/, name + ' 锚点不唯一必须拒')
    // 未知目标 ⇒ 拒
    assert.throws(() => applyNativeMessageTransform(source, 'unknownTarget'), /未知目标/)
  }
  void t
})

test('S5装配侧按MESSAGE_FILES对两domain文件施缝且字节可复原', async t => {
  // 夹具＝磁盘上的**真实作者 source 树**（tavern-plugin/{lib,src,packages,prompts,…} 全量，无 node_modules），
  // 复制到自有 tmp 后跑**真实 applyStandardSeams**。真实树含 domain/background-task-coordinator.js ⇒ 它已是受管目标。
  const TARGET_COMMIT = '68215e47516637e00c75d2b4bba3192679559425'
  const RECORD_FILE = COMMENT_SEAMS_RECORD
  const DOMAIN_FILES = { turnOrchestration: 'tavern-plugin/lib/domain/turn-orchestration.js', backgroundCoordinator: 'tavern-plugin/lib/domain/background-task-coordinator.js' }
  const NAME_OF = { turnOrchestration: 'appendMessages', backgroundCoordinator: 'setMessageFloor' }
  const sourceTree = fileURLToPath(AUTHOR_ROOT)
  assert.equal(existsSync(path.join(sourceTree, 'lib', 'domain', 'background-task-coordinator.js')), true, '缺作者树夹具：' + sourceTree)
  const appDir = mkdtempSync(path.join(tmpdir(), 'native-message-seams-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  cpSync(sourceTree, path.join(appDir, 'tavern-plugin'), { recursive: true })
  const fileOf = rel => path.join(appDir, ...rel.split('/'))
  const before = {}
  for (const [key, rel] of Object.entries(DOMAIN_FILES)) {
    before[key] = readFileSync(fileOf(rel))
    assert.equal(isNativeMessageApplied(before[key].toString('utf8'), NAME_OF[key]), false, '前置：作者原字节不应已应用 S5 转换（' + rel + '）')
    assert.equal(MESSAGE_FILES[rel], NAME_OF[key], 'MESSAGE_FILES 必须把该文件映到 ' + NAME_OF[key])
    assert.equal(maintenanceTargets.includes(rel), true, rel + ' 必须进 TARGETS（真实作者树含该文件，已为受管目标）')
  }
  assert.equal(applyStandardSeams({ appDir, authorVersion: AUTHOR_VERSION, assertStopped: () => true }).changed, true, '真实施缝必须产生变更')
  for (const [key, rel] of Object.entries(DOMAIN_FILES)) {
    const seamed = readFileSync(fileOf(rel), 'utf8')
    assert.equal(isNativeMessageApplied(seamed, NAME_OF[key]), true, '装配后 ' + rel + ' 必须已应用 S5 转换')
    // 注释块协议：ORIGINAL 区按 '// ' 逐行保留作者旧调用 ⇒ "旧调用零残留" 只能对 ACTIVE 投影断言；
    // 反过来，S5 标记必须显式活在 ACTIVE 里（不能被块渲染吞成注释外文本）。
    const active = activeSource(seamed, rel)
    assert.equal(active.split(MESSAGE_ANCHORS[NAME_OF[key]]).length - 1, 0, rel + ' ACTIVE 投影里旧调用行残留必须为 0')
    assert.equal(active.split(MESSAGE_MARKER[NAME_OF[key]]).length - 1, 1, rel + ' ACTIVE 投影里 S5 标记必须恰一处')
    assert.equal(seamed.split(MESSAGE_MARKER[NAME_OF[key]]).length - 1, 1, rel + ' 原始文件里 S5 标记恰一处')
  }
  const record = JSON.parse(readFileSync(path.join(appDir, RECORD_FILE), 'utf8'))
  assert.equal(record.format, 1)
  assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
  for (const rel of Object.values(DOMAIN_FILES)) {
    assert.ok(Object.hasOwn(record.files, rel), '注释块记录必须含实际施缝文件 ' + rel)
    assert.ok(record.files[rel].blocks.length > 0, rel + ' 必须有接缝块')
  }
  // 卸载：逐字节回原、标记不残留、记录清理
  assert.equal(uninstallStandardSeams({ appDir, assertStopped: () => true }).changed, true, '卸载必须产生变更')
  for (const [key, rel] of Object.entries(DOMAIN_FILES)) {
    assert.deepEqual(readFileSync(fileOf(rel)), before[key], rel + ' 卸载后必须逐字节回原')
    assert.equal(isNativeMessageApplied(readFileSync(fileOf(rel), 'utf8'), NAME_OF[key]), false, rel + ' 卸载后不得残留 S5 标记')
  }
  assert.equal(existsSync(path.join(appDir, RECORD_FILE)), false, '卸载后不得残留标准记录')
  assert.equal(TARGET_COMMIT, '68215e47516637e00c75d2b4bba3192679559425', '夹具提交固定为作者代')
  void t
})

test('S5装配侧coordinator是真实受管目标且原字节可复原', async t => {
  // 真实作者 source fixture **含** domain/background-task-coordinator.js ⇒ 它现在就是受管目标：
  // 必须落可写注释块、进 record.files，卸载后逐字节回原（不再有"随包资产缺该文件"的旧假设）。
  const RECORD_FILE = COMMENT_SEAMS_RECORD
  const TURN = 'tavern-plugin/lib/domain/turn-orchestration.js'
  const COORDINATOR = 'tavern-plugin/lib/domain/background-task-coordinator.js'
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  t.after(tree.cleanup)                                              // 只删 helper 自己的 mkdtemp 目录
  const fileOf = rel => path.join(tree.appDir, ...rel.split('/'))
  assert.equal(maintenanceTargets.includes(COORDINATOR), true, 'coordinator 必须是受管目标')
  assert.equal(existsSync(fileOf(COORDINATOR)), true, '前置：真实作者树含 background-task-coordinator.js')
  const turnBefore = readFileSync(fileOf(TURN))
  const coordinatorBefore = readFileSync(fileOf(COORDINATOR), 'utf8')
  assert.equal(isNativeMessageApplied(turnBefore.toString('utf8'), 'appendMessages'), false, '前置：作者原字节未施缝')
  // 真实装配
  const result = applyStandardSeams({ appDir: tree.appDir, authorVersion: AUTHOR_VERSION, assertStopped: () => true })
  assert.equal(result.changed, true, '真实源装配必须成功并产生变更')
  for (const [rel, name] of [[TURN, 'appendMessages'], [COORDINATOR, 'setMessageFloor']]) {
    const seamed = readFileSync(fileOf(rel), 'utf8')
    assert.equal(isNativeMessageApplied(seamed, name), true, rel + ' 必须已应用 S5 转换')
    assert.equal(seamed.split(MESSAGE_MARKER[name]).length - 1, 1, rel + ' S5 标记恰一处')
    assert.match(seamed, /\[dsh-tavern-seam:ACTIVE_BEGIN\]/, rel + ' 必须有可写注释块')
  }
  const record = JSON.parse(readFileSync(path.join(tree.appDir, RECORD_FILE), 'utf8'))
  for (const rel of [TURN, COORDINATOR]) {
    assert.ok(Object.hasOwn(record.files, rel), '注释块记录必须含 ' + rel)
    assert.ok(record.files[rel].blocks.length > 0, rel + ' 必须有接缝块')
  }
  // 卸载：两文件逐字节回原、记录清理
  assert.equal(uninstallStandardSeams({ appDir: tree.appDir, assertStopped: () => true }).changed, true, '卸载必须产生变更')
  assert.deepEqual(readFileSync(fileOf(TURN)), turnBefore, TURN + ' 卸载后必须逐字节回原')
  assert.equal(readFileSync(fileOf(COORDINATOR), 'utf8'), coordinatorBefore, COORDINATOR + ' 卸载后必须逐字节回原')
  assert.equal(existsSync(path.join(tree.appDir, RECORD_FILE)), false, '卸载后不得残留标准记录')
  void t
})

// ══════════════════════════════════════════════════════════════════════════════════
// 宿主 DI（S5）：把 index.js 两个 factory 的窄 store 字面量补上 appendMessages/setMessageFloor，
// 接到同一个 chatJournalStore，并按作者 patchChat 的写后契约通知（只吃 result.head，不读整档、不 patch fallback）。
// ══════════════════════════════════════════════════════════════════════════════════
/** 从转换后的 index.js 里切出注入的闭包块并实例化（依赖全用真实/受控对象注入，不假造生产路径）。 */
function hostDiClosures({ source, chatJournalStore, deletedChatIds = new Set(), notifications }) {
  const start = source.indexOf(MESSAGE_HOST_MARKER)
  assert.ok(start >= 0, '宿主 DI 生成物缺标记')
  const tail = source.slice(start).split('\n')
  const floorAt = tail.findIndex(line => line.startsWith('  async function setMessageFloorNarrow'))
  assert.ok(floorAt > 0, '宿主 DI 生成物缺 setMessageFloorNarrow')
  const endAt = tail.findIndex((line, index) => index > floorAt && line === '  }')
  assert.ok(endAt > floorAt, '宿主 DI 生成物缺闭包终止行')
  const block = tail.slice(0, endAt + 1).filter(line => !line.trimStart().startsWith('//')).join('\n')
  const factory = new Function(
    'chatJournalStore', 'deletedChatIds', 'str', 'candidateWorldbookPreparation', 'syncChatSummary', 'coordinationEvents', 'scheduleTemplateSync', 'queueAutoCompaction',
    block + '\nreturn { appendMessagesNarrow, setMessageFloorNarrow, notifyNarrowWrite }')
  return factory(chatJournalStore, deletedChatIds, value => String(value ?? ''), notifications.candidate, notifications.summary, notifications.coordination, notifications.templateSync, notifications.compaction)
}
function notificationRecorder() {
  const calls = []
  return {
    calls,
    candidate: { changed: (...args) => calls.push({ name: 'candidate.changed', args }) },
    summary: async (...args) => { calls.push({ name: 'syncChatSummary', args }) },
    coordination: { publish: (...args) => calls.push({ name: 'coordination.publish', args }) },
    templateSync: (...args) => calls.push({ name: 'scheduleTemplateSync', args }),
    compaction: (...args) => calls.push({ name: 'queueAutoCompaction', args }),
    names: () => calls.map(call => call.name),
  }
}

test('S5宿主DI：真实作者index两factory补窄出口且写后通知等价（真storeCAS/metadata/items）', async t => {
  const source = applyNativeMessageHostTransform(authorFile('lib/index.js'))
  assert.equal(isNativeMessageHostApplied(source), true, '转换后必须可判定为已应用')
  assert.equal(source.includes('setMessageFloor: setMessageFloorNarrow, '), true, 'backgroundTasks 字面量必须补 setMessageFloor')
  assert.equal(source.includes('      appendMessages: appendMessagesNarrow,'), true, 'turnOrchestrator 字面量必须补 appendMessages')
  const real = storeFixture(t, { chatId: CHAT_ID, label: 'host-di' })
  await real.store.update(real.chatId, () => CHAT)
  const stored = await real.store.read(real.chatId)
  const notes = notificationRecorder()
  const closures = hostDiClosures({ source, chatJournalStore: real.store, notifications: notes })
  const metadata = { source: 'foreground.commit', sessionId: SESSION_ID, operationId: 'op-host-1' }
  const appended = [{ role: 'assistant', text: '宿主DI新楼', turn: 9 }]
  // 走**真实 domain 生成块**：作者 A 站点（applyNativeMessageTransform 产物）→ DI 闭包 → 真 SQLite 窄命令。
  const domainSource = applyNativeMessageTransform(authorFile('lib/domain/turn-orchestration.js'), 'appendMessages')
  const changes = [
    { op: 'set', path: ['settleStatus'], value: 'pending' },
    { op: 'set', path: ['promptTemplateInput'], value: undefined },
    { op: 'splice', path: ['messages'], index: stored.messages.length, deleteCount: 0, items: appended }
  ]
  const blockResult = await runAppendBlock({
    source: domainSource,
    store: { appendMessages: (...args) => closures.appendMessagesNarrow(...args), patchChat() { throw new Error('不得直连 patchChat') } },
    before: stored, revision: stored._storageRevision, changes, metadata, result: { saved: true }
  })
  assert.deepEqual(blockResult, { saved: true }, '生成块真值 ⇒ 原样早退 result')
  const after = await real.store.read(real.chatId)
  assert.equal(after.messages.length, stored.messages.length + 1, '真实生成块的 items 必须经真库落库')
  assert.equal(after.messages.at(-1).text, '宿主DI新楼', '落库内容＝生成块提取的 items 原样')
  assert.equal(after.settleStatus, 'pending', '顶层头键必须经窄命令写入真库（对象契约）')
  assert.equal(Object.hasOwn(after, 'promptTemplateInput'), false, 'undefined 头值＝删除语义（真库不该有新键）')
  const result = { changed: true, revision: after._storageRevision, head: null }   // 真库读回的 revision 供断言
  assert.equal(result.revision, stored._storageRevision + 1, 'CAS pin 用真库 revision，成功后 +1')
  // 通知等价：五步链各一次，且拿到的是**窄 head**（无 messages，证明未整档读/未读整档补通知）
  assert.deepEqual(notes.names(), ['candidate.changed', 'syncChatSummary', 'coordination.publish', 'scheduleTemplateSync', 'queueAutoCompaction'], '写后通知顺序与作者 patchChat 一致')
  const head = notes.calls[0].args[0]
  assert.equal(head.sessionId, SESSION_ID, '通知对象必须是窄 head（含 sessionId）')
  assert.equal(head._storageRevision, stored._storageRevision + 1, '窄 head 必须带新 _storageRevision')
  assert.equal(Object.hasOwn(head, 'messages'), false, '窄 head 不得携带整档 messages')
  assert.equal(notes.calls[2].args[0], SESSION_ID, 'publish 只吃 sessionId')
  assert.equal(notes.calls[4].args[0], SESSION_ID, 'queueAutoCompaction 只吃 sessionId')
  assert.equal(notes.calls[3].args[1], metadata, 'scheduleTemplateSync 必须收到同一 metadata 引用')
  // CAS 不符：旧 revision ⇒ undefined 且不再通知（作者 attempt 循环/兜底语义）
  notes.calls.length = 0
  const staleChanges = [{ op: 'set', path: ['settleStatus'], value: 'pending' }, { op: 'splice', path: ['messages'], index: after.messages.length, deleteCount: 0, items: appended }]
  const stale = await runAppendBlock({
    source: domainSource,
    store: { appendMessages: (...args) => closures.appendMessagesNarrow(...args), patchChat() { throw new Error('不得直连 patchChat') } },
    before: { ...after, _storageRevision: stored._storageRevision }, revision: stored._storageRevision, changes: staleChanges, metadata, result: { saved: true }
  })
  assert.deepEqual(stale, { fellThrough: true }, 'CAS 不符（旧 revision）⇒ 生成块 falsy ⇒ 作者续跑 attempt')
  assert.deepEqual(notes.calls, [], 'CAS 不符不得触发写后通知')
  const afterStale = await real.store.read(real.chatId)
  assert.equal(afterStale.messages.length, after.messages.length, 'CAS 不符必须零写')
  // B：setMessageFloorNarrow 走同一 store 与同一通知链；candidate.mailbox. 源按作者契约跳过 summary
  notes.calls.length = 0
  const floor = await closures.setMessageFloorNarrow(real.chatId, afterStale._storageRevision, 0, { changes: [{ op: 'set', path: ['messages', 0, 'mvu', 'pending'], value: false }] }, { source: 'background.settlement.checkpoint', sessionId: SESSION_ID })
  assert.equal(floor?.changed, true, '单楼窄出口必须真写真库')
  assert.deepEqual(notes.names(), ['candidate.changed', 'syncChatSummary', 'coordination.publish', 'scheduleTemplateSync', 'queueAutoCompaction'], '单楼写后通知链一致')
  notes.calls.length = 0
  await closures.setMessageFloorNarrow(real.chatId, floor.revision, 0, { changes: [{ op: 'set', path: ['messages', 0, 'mvu', 'pending'], value: true }] }, { source: 'candidate.mailbox.commit', sessionId: SESSION_ID })
  assert.deepEqual(notes.names(), ['candidate.changed', 'coordination.publish', 'scheduleTemplateSync', 'queueAutoCompaction'], 'candidate.mailbox. 源按作者契约跳过 syncChatSummary')
})

test('S5宿主DI：锚点缺失或重复与半应用拒绝且幂等逐块校验', async t => {
  const raw = authorFile('lib/index.js')
  for (const [name, anchor] of Object.entries(MESSAGE_HOST_ANCHORS)) {
    assert.equal(raw.split(anchor).length - 1, 1, name + ' 锚点在作者原文必须恰一处')
  }
  const once = applyNativeMessageHostTransform(raw)
  assert.equal(applyNativeMessageHostTransform(once), once, '复跑必须幂等（逐块校验后原样返回）')
  assert.equal(once.split(MESSAGE_HOST_MARKER).length - 1, 1, '标记必须恰一处')
  for (const [key, text] of Object.entries(MESSAGE_HOST_BLOCKS)) assert.ok(once.includes(text), '生成物缺块：' + key)
  // 锚点缺失 / 重复 ⇒ 拒
  assert.throws(() => applyNativeMessageHostTransform(raw.replace(MESSAGE_HOST_ANCHORS.orchestrator, '  const turnOrchestrator = createTurnOrchestrator({')), /锚点缺失\/不唯一/)
  assert.throws(() => applyNativeMessageHostTransform(raw.replace(MESSAGE_HOST_ANCHORS.background, MESSAGE_HOST_ANCHORS.background + MESSAGE_HOST_ANCHORS.background)), /锚点缺失\/不唯一/)
  // 半应用（标记在、块缺）⇒ 拒：函数头在但 body/wire/payload/read 被改也必须拒
  assert.throws(() => applyNativeMessageHostTransform(once.replace(MESSAGE_HOST_BLOCKS.floor, 'async function setMessageFloorRemoved(chatId) {')), /缺块/)
  assert.throws(() => applyNativeMessageHostTransform(once.replace('chatJournalStore.appendMessages(chatId, revision, payload, metadata)', 'chatJournalStore.appendMessages(chatId, revision, {}, metadata)')), /缺块/, 'payload 被改必须拒')
  assert.throws(() => applyNativeMessageHostTransform(once.replace('chatJournalStore.setMessageFloor(chatId, revision, index, payload, metadata)', 'chatJournalStore.setMessageFloor(chatId, revision, index, {}, metadata)')), /缺块/, 'read/参数被改必须拒')
  assert.throws(() => applyNativeMessageHostTransform(once.replace('    await notifyNarrowWrite(result.head, metadata)\n', '')), /缺块/, '缺 head 通知必须拒')
  assert.throws(() => applyNativeMessageHostTransform(once.replace(MESSAGE_HOST_BLOCKS.backgroundLiteral, MESSAGE_HOST_ANCHORS.background)), /缺块/, 'DI literal 键缺失必须拒（background）')
  assert.throws(() => applyNativeMessageHostTransform(once.replace(MESSAGE_HOST_BLOCKS.orchestratorLiteral, MESSAGE_HOST_ANCHORS.orchestrator)), /缺块/, 'DI literal 键缺失必须拒（foreground）')
  assert.throws(() => applyNativeMessageHostTransform(once + '\n' + MESSAGE_HOST_MARKER + '\n'), /标记数异常/)
  void t
})

test('S5宿主DI：窄命令无head时响亮拒且不读数整档', async t => {
  const source = applyNativeMessageHostTransform(authorFile('lib/index.js'))
  const notes = notificationRecorder()
  const noHeadStore = { appendMessages: async () => ({ changed: true, revision: 5 }), setMessageFloor: async () => ({ changed: true, revision: 6 }) }
  const closures = hostDiClosures({ source, chatJournalStore: noHeadStore, notifications: notes })
  await assert.rejects(() => closures.appendMessagesNarrow(CHAT_ID, 4, { items: [{ role: 'assistant', text: 'x' }], headerSets: {} }, { source: 'foreground.commit' }),
    /窄写后通知缺少 head 对象/, '出口未返回 head 必须响亮拒（不得退化成整档读补通知）')
  await assert.rejects(() => closures.setMessageFloorNarrow(CHAT_ID, 4, 0, { changes: [] }, { source: 'background.settlement.checkpoint' }),
    /窄写后通知缺少 head 对象/, '单楼出口同样不整档读')
  assert.deepEqual(notes.calls, [], '缺 head 时不得触发任何写后通知')
  await assert.rejects(() => closures.notifyNarrowWrite(undefined, {}), /窄写后通知缺少 head 对象/)
  // 删除态守卫：作者 `deletedChatIds` 语义必须保留
  const guardSource = applyNativeMessageHostTransform(authorFile('lib/index.js'))
  const guarded = hostDiClosures({ source: guardSource, chatJournalStore: noHeadStore, deletedChatIds: new Set([CHAT_ID]), notifications: notes })
  await assert.rejects(() => guarded.appendMessagesNarrow(CHAT_ID, 4, { items: [], headerSets: {} }, {}), /对话已删除/)
  void t
})
