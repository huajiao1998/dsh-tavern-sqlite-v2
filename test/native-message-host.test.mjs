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
  MESSAGE_REQUIRED_BLOCKS, APPEND_MESSAGES_CALL, SET_MESSAGE_FLOOR_CALL
} from '../deploy/native-data-transform.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { loadAuthorCleanImages } from '../deploy/maintenance/residual-uninstall.mjs'
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
  assert.deepEqual(call.args[2].headerSets, [changes[0], changes[1], changes[2]], 'headerSets 必须是非 splice 项原样保序（含 undefined 值项）')
  assert.equal(Object.keys(call.args[2]).sort().join(','), 'headerSets,items', '载荷只含 {items,headerSets}')
  assert.equal(call.args[3], metadata, 'metadata 必须原样透传（同一对象引用）')
  // 无 splice（纯头字段提交）时 items 为空数组，仍走同一出口
  spy.calls.length = 0
  await runAppendBlock({ source, store, before, revision: 4, changes: [changes[0]], metadata, result: {} })
  assert.deepEqual(spy.calls[0].args[2], { items: [], headerSets: [changes[0]] }, '纯头字段提交 ⇒ items=[]、headerSets 原样')
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
  // 夹具＝**磁盘上的完整作者树**（真实安装形态：tavern-plugin/{lib,src,packages,prompts,…} 全量，无 node_modules），
  // 复制到自有 tmp 后跑**真实 applyStandardSeams**。注：随包作者目录（author-clean-images.json.gz，56 文件）
  // **不含** domain/background-task-coordinator.js，而 standard-seams.mjs:225/:371 以 text(appDir,…)=readFileSync 读它
  // ⇒ 目录派生夹具上会 ENOENT（已单独回报，属装配侧缺口，不在本断言内锁定）。
  const TARGET_COMMIT = '68215e47516637e00c75d2b4bba3192679559425'
  const RECORD_FILE = '.tavern-standard-seams.json'
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
    const mustBeManaged = rel === DOMAIN_FILES.turnOrchestration
    assert.equal(maintenanceTargets.includes(rel), mustBeManaged, rel + (mustBeManaged ? ' 必须进 TARGETS' : ' 不进 TARGETS：随包恢复资产没有它的官方字节'))
  }
  assert.equal(applyStandardSeams({ appDir, authorVersion: AUTHOR_VERSION }).changed, true, '真实施缝必须产生变更')
  for (const [key, rel] of Object.entries(DOMAIN_FILES)) {
    const seamed = readFileSync(fileOf(rel), 'utf8')
    assert.equal(isNativeMessageApplied(seamed, NAME_OF[key]), true, '装配后 ' + rel + ' 必须已应用 S5 转换')
    assert.equal(seamed.split(MESSAGE_ANCHORS[NAME_OF[key]]).length - 1, 0, rel + ' 旧调用行残留必须为 0')
    assert.equal(seamed.split(MESSAGE_MARKER[NAME_OF[key]]).length - 1, 1, rel + ' S5 标记恰一处')
  }
  const record = JSON.parse(readFileSync(path.join(appDir, RECORD_FILE), 'utf8'))
  for (const rel of Object.values(DOMAIN_FILES)) {
    assert.ok(record.after && Object.hasOwn(record.after, rel), '标准记录 after 必须含实际施缝文件 ' + rel)
    assert.ok(record.before && Object.hasOwn(record.before, rel), '标准记录 before 必须含实际施缝文件 ' + rel)
  }
  // 卸载：逐字节回原、标记不残留、记录清理
  assert.equal(uninstallStandardSeams({ appDir }).changed, true, '卸载必须产生变更')
  for (const [key, rel] of Object.entries(DOMAIN_FILES)) {
    assert.deepEqual(readFileSync(fileOf(rel)), before[key], rel + ' 卸载后必须逐字节回原')
    assert.equal(isNativeMessageApplied(readFileSync(fileOf(rel), 'utf8'), NAME_OF[key]), false, rel + ' 卸载后不得残留 S5 标记')
  }
  assert.equal(existsSync(path.join(appDir, RECORD_FILE)), false, '卸载后不得残留标准记录')
  assert.equal(TARGET_COMMIT, '68215e47516637e00c75d2b4bba3192679559425', '夹具提交固定为作者代')
  void t
})

test('S5装配侧目录派生缺文件显式跳过不抛ENOENT', async t => {
  // 目录派生 appDir（loadAuthorCleanImages 复制的随包作者目录，冻结基线 55/56 键）**不含**
  // domain/background-task-coordinator.js：装配必须**成功**（缺文件显式跳过，不 ENOENT、不凭空创建），
  // 而同代的 domain/turn-orchestration.js 仍必须被施缝。
  const TARGET_COMMIT = '68215e47516637e00c75d2b4bba3192679559425'
  const RECORD_FILE = '.tavern-standard-seams.json'
  const TURN = 'tavern-plugin/lib/domain/turn-orchestration.js'
  const COORDINATOR = 'tavern-plugin/lib/domain/background-task-coordinator.js'
  const tree = loadAuthorCleanImages().trees.find(item => item.commit === TARGET_COMMIT)
  assert.ok(tree, '缺随包作者目录：' + TARGET_COMMIT)
  const appDir = mkdtempSync(path.join(tmpdir(), 'native-message-catalog-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = path.join(appDir, ...rel.split('/'))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  const fileOf = rel => path.join(appDir, ...rel.split('/'))
  assert.equal(existsSync(fileOf(COORDINATOR)), false, '前置：目录派生夹具确无 background-task-coordinator.js（冻结基线不含该键）')
  assert.equal(existsSync(fileOf(TURN)), true, '前置：目录派生夹具含 turn-orchestration.js')
  const turnBefore = readFileSync(fileOf(TURN))
  assert.equal(isNativeMessageApplied(turnBefore.toString('utf8'), 'appendMessages'), false, '前置：作者原字节未施缝')
  // 真实装配：不得抛 ENOENT（缺文件显式跳过）
  const result = applyStandardSeams({ appDir, authorVersion: AUTHOR_VERSION })
  assert.equal(result.changed, true, '目录派生夹具的装配必须成功并产生变更')
  const seamed = readFileSync(fileOf(TURN), 'utf8')
  assert.equal(isNativeMessageApplied(seamed, 'appendMessages'), true, 'turn-orchestration.js 必须已应用 S5 转换（缺另一个文件不影响它）')
  assert.equal(seamed.split(MESSAGE_ANCHORS.appendMessages).length - 1, 0, TURN + ' 旧调用行残留必须为 0')
  assert.equal(seamed.split(MESSAGE_MARKER.appendMessages).length - 1, 1, TURN + ' S5 标记恰一处')
  // 缺文件必须"未被创建"（不是空文件、不是被写入）
  assert.equal(existsSync(fileOf(COORDINATOR)), false, '缺文件必须显式跳过：不得凭空创建该文件')
  const record = JSON.parse(readFileSync(path.join(appDir, RECORD_FILE), 'utf8'))
  assert.equal(maintenanceTargets.includes(COORDINATOR), false, '随包恢复资产不含该文件，不得把它加进 TARGETS')
  assert.equal(Object.hasOwn(record.before || {}, COORDINATOR), false, '目录派生树没有该文件，标准记录不得发明前像')
  assert.equal(Object.hasOwn(record.after || {}, COORDINATOR), false, '跳过 ⇒ 无后像（未写入任何内容）')
  assert.ok(Object.hasOwn(record.after || {}, TURN), '已施缝的 turn-orchestration.js 必须在记录 after 内')
  // 卸载：仍逐字节回原且不产生该文件
  assert.equal(uninstallStandardSeams({ appDir }).changed, true, '卸载必须产生变更')
  assert.deepEqual(readFileSync(fileOf(TURN)), turnBefore, TURN + ' 卸载后必须逐字节回原')
  assert.equal(existsSync(fileOf(COORDINATOR)), false, '卸载后仍不得存在该文件')
  void t
})
