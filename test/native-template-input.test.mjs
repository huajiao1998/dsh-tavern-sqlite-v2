// S4 具名断言：模板链前台取数（真 store 夹具 + 同库读；与作者 template-window-reader.js 同一
//   readWindow 双跑对照）。作者模块用固定提交 68215e47 真身，缺失即响亮失败，不 skip。
// 本闸只证明「同一 store 真读源上：扩窗语义/门槛/historyWindow 计数与作者一致」，不冒称模板页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { readTemplateWindowNative, TEMPLATE_PAGE_SIZE } from '../lib/chat-query-service.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

const testRequire = createRequire(new URL('../../../tools/sql-test-kit/package.json', import.meta.url))
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !context.parentURL?.includes('/release-034-20261008/author-fixture/')
      || specifier.startsWith('.') || specifier.startsWith('node:') || specifier.startsWith('data:')) throw error
    return next(pathToFileURL(testRequire.resolve(specifier)).href, context)
  }
} })

const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const { createScopedMessages } = await import(new URL('scoped-messages.js', AUTHOR68215))
const { createTemplateWindowReader, templateStateFields } = await import(new URL('template-window-reader.js', AUTHOR68215))
for (const [n, f] of Object.entries({ createScopedMessages, createTemplateWindowReader })) assert.equal(typeof f, 'function', '作者模块导出 ' + n + ' 缺失：夹具无法对账')

const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[n] = projUnused

function fixture(t, name) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-template-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS })
  const readers = []
  t.after(() => {
    for (const db of readers) { try { db.close() } catch { /* 已关 */ } }
    try { store.dispose?.() } catch { /* 已释放 */ }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, chatId: name, store, readers }
}
const reader = f => { const db = new DatabaseSync(f.store.rollbackArchivePath(f.chatId), { readOnly: true }); f.readers.push(db); return db }

const chatN = (chatId, total, overrides = {}) => ({
  id: chatId, sessionId: 'session-template-fixture', _storageRevision: 1, updatedAt: 1,
  mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  cardPath: 'cards/x.json', macroState: { userName: '你' }, settleStatus: 'idle',
  timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 7, participants: {}, operations: {} },
  messages: Array.from({ length: total }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', turn: index, text: 'rev' + (index + 1), sourceText: 'rev' + (index + 1) })),
  ...overrides,
})

// issue 必须是**确定性**的：用计数器会把两侧调用的先后来编码进 ticket，deepEqual 就变成在比调用顺序。
const issue = input => ({ ticket: 'T:' + input.chatId + ':' + input.revision, revision: input.revision, messageCount: input.messageCount })
const session = store => ({ readWindow: store.readWindow, issue })
/** 作者口径：同一 readWindow + 计数用的 issue。historyFrom 固定为调用方给的 from 函数。 */
const authorRead = (store, chatId, from) => createTemplateWindowReader({
  links: async () => ({ 'session-template-fixture': chatId }),
  readWindow: store.readWindow,
  access: { issue },
  historyFrom: () => from,
}).call(null, 'session-template-fixture')

test('模板链默认读最近200楼且historyWindow计数与作者一致', async t => {
  const f = fixture(t, 'chat-template-default')
  await f.store.update(f.chatId, () => chatN(f.chatId, 300))
  const db = reader(f)
  const ours = await readTemplateWindowNative(db, { chatId: f.chatId, sessionId: 'session-template-fixture' }, session(f.store))
  const theirs = await authorRead(f.store, f.chatId)
  assert.notEqual(ours, undefined, '必须命中')
  assert.notEqual(theirs, undefined, '作者必须命中（否则对照无意义）')
  assert.deepEqual(ours.historyWindow, theirs.historyWindow, 'historyWindow（含 issue 形状与计数）必须与作者相同')
  assert.equal(ours.historyWindow.from, 100, '默认 limit 200 ⇒ from=100')
  assert.equal(ours.historyWindow.messageCount, 300, '无虚拟用户楼 ⇒ 计数＝messageCount')
  assert.equal(ours.chat.messages.length, 200)
  assert.deepEqual(ours.chat.messages, theirs.chat.messages)
  assert.deepEqual(Object.keys(ours.chat), Object.keys(theirs.chat), '返回 chat 的键集合与键序必须与作者一致')
  assert.equal(isDeepStrictEqual(ours.chat.timeline, theirs.chat.timeline), true, '本链头读与作者同为全键形状（timeline 未窄化）')
  assert.equal(TEMPLATE_PAGE_SIZE, 200, '作者 :21 的窗口上限必须逐字保留')
})

test('模板链historyFrom向更早楼层扩窗且与作者readRecentWindow同形', async t => {
  const f = fixture(t, 'chat-template-extend')
  await f.store.update(f.chatId, () => chatN(f.chatId, 300))
  const db = reader(f)
  const ours = await readTemplateWindowNative(db, { chatId: f.chatId, sessionId: 'session-template-fixture', from: 50 }, session(f.store))
  const theirs = await authorRead(f.store, f.chatId, 50)
  assert.notEqual(ours, undefined)
  assert.notEqual(theirs, undefined)
  assert.deepEqual(ours.historyWindow, theirs.historyWindow, '扩窗后的 historyWindow 必须与作者相同')
  assert.equal(ours.historyWindow.from, 50, 'requestedFrom(50) 早于首窗起点(100) ⇒ 扩到 50（作者实算：limit=min(500,100-50)）')
  assert.equal(ours.chat.messages.length, 250, '扩窗后 50..299 共 250 楼')
  assert.equal(ours.chat.messages[0].turn, 50, '扩窗后首楼＝最终窗口起点')
  assert.deepEqual(ours.chat.messages, theirs.chat.messages, '扩窗后的 messages 必须与作者逐元素相同')
  assert.equal(ours.chat.promptTemplateInput, undefined, '夹具无虚拟用户楼')
})

test('模板链虚拟用户楼使对外计数加一', async t => {
  const f = fixture(t, 'chat-template-virtual')
  await f.store.update(f.chatId, () => chatN(f.chatId, 300, { promptTemplateInput: { message: { role: 'user', content: '草稿' } } }))
  const db = reader(f)
  const ours = await readTemplateWindowNative(db, { chatId: f.chatId, sessionId: 'session-template-fixture' }, session(f.store))
  const theirs = await authorRead(f.store, f.chatId)
  assert.equal(ours.historyWindow.messageCount, 301, 'promptTemplateInput.message ⇒ 对外计数 +1')
  assert.deepEqual(ours.historyWindow, theirs.historyWindow)
  assert.deepEqual(ours.chat.messages, theirs.chat.messages, '虚拟楼不得进入 messages（只在计数上加一）')
})

test('模板链窗口覆盖整档或门槛不符时显式返回undefined', async t => {
  // 短档：limit 200 覆盖整档 ⇒ requirePartial 语义下作者得 null ⇒ undefined
  const short = fixture(t, 'chat-template-short')
  await short.store.update(short.chatId, () => chatN(short.chatId, 40))
  const dbShort = reader(short)
  assert.equal(await readTemplateWindowNative(dbShort, { chatId: short.chatId, sessionId: 'session-template-fixture' }, session(short.store)), undefined,
    '窗口覆盖整档 ⇒ undefined（不截断）')
  assert.equal(await authorRead(short.store, short.chatId), undefined, '作者同条件同样 undefined')

  // sessionId 不符
  const f = fixture(t, 'chat-template-gate')
  await f.store.update(f.chatId, () => chatN(f.chatId, 300))
  const db = reader(f)
  assert.equal(await readTemplateWindowNative(db, { chatId: f.chatId, sessionId: 'other-session' }, session(f.store)), undefined, 'sessionId 不符 ⇒ undefined')
  assert.equal(await createTemplateWindowReader({ links: async () => ({ 'session-template-fixture': f.chatId }), readWindow: f.store.readWindow, access: { issue }, historyFrom: () => undefined }).call(null, 'other-session'), undefined, '作者同条件同样 undefined')

  // 两个版本门槛
  const f2 = fixture(t, 'chat-template-version')
  await f2.store.update(f2.chatId, () => chatN(f2.chatId, 300, { conversationFeaturesVersion: 2 }))
  const db2 = reader(f2)
  assert.equal(await readTemplateWindowNative(db2, { chatId: f2.chatId, sessionId: 'session-template-fixture' }, session(f2.store)), undefined,
    'conversationFeaturesVersion≠1 ⇒ undefined')
  assert.equal(await authorRead(f2.store, f2.chatId), undefined, '作者同条件同样 undefined')

  // 无档
  // 无档：不需要为不存在的档开只读句柄（用假句柄证明不触碰库）
  const f3 = fixture(t, 'chat-template-nowindow')
  const fakeHandle = { prepare: () => { throw new Error('无档路径不应触碰 SQLite 句柄') } }
  assert.equal(await readTemplateWindowNative(fakeHandle, { chatId: f3.chatId, sessionId: 'session-template-fixture' }, session(f3.store)), undefined, '无档 ⇒ undefined')
})

test('模板链扩窗遇revision变动时中止返回undefined', async t => {
  const f = fixture(t, 'chat-template-revision')
  await f.store.update(f.chatId, () => chatN(f.chatId, 300))
  const db = reader(f)
  const first = await f.store.readWindow(f.chatId, { limit: 200 })
  let calls = 0
  const racing = { ...session(f.store), readWindow: async (chatId, options) => {
    calls += 1
    if (calls === 1) return f.store.readWindow(chatId, options)
    return { ...first, chat: { ...first.chat, _storageRevision: 2 }, from: 60, revision: 2 }
  } }
  assert.equal(await readTemplateWindowNative(db, { chatId: f.chatId, sessionId: 'session-template-fixture', from: 5 }, racing), undefined,
    '续页 revision 与首窗不符 ⇒ 中止（不拼旧头新页）')
  assert.equal(calls, 2, '必须在扩窗续页处中止')
})

test('模板链注入面缺失时响亮失败且消费方字段表不含timeline', async t => {
  const f = fixture(t, 'chat-template-helpers')
  await f.store.update(f.chatId, () => chatN(f.chatId, 300))
  const db = reader(f)
  await assert.rejects(() => readTemplateWindowNative(db, { chatId: f.chatId, sessionId: 's' }, { issue }), /缺少注入 helper readWindow/)
  await assert.rejects(() => readTemplateWindowNative(db, { chatId: f.chatId, sessionId: 's' }, { readWindow: f.store.readWindow }), /缺少注入 helper issue/)
  await assert.rejects(() => readTemplateWindowNative({}, { chatId: f.chatId, sessionId: 's' }, session(f.store)), /需要真实 SQLite 句柄/)
  await assert.rejects(() => readTemplateWindowNative(db, { chatId: '', sessionId: 's' }, session(f.store)), /缺少 chatId/)
  assert.equal(templateStateFields.includes('timeline'), false,
    '作者 templateStateFields 不含 timeline ⇒ 本链头读的 timeline 是白付的组装（已如实记录为未窄化，见代码注释）')
})
