// S4 具名断言：前台 story 输入的范围选择＋读取（真 store 夹具 + 同库窄读；与作者
//   bounded-history.read 注入同一 readWindow 双跑对照）。
// 夹具机制沿用既有 test/native-activity-query.test.mjs：作者 2.5 真身 helper（copy-json-tree/
//   json-mutation）＋未使用的显示投影以结构化脱离替身满足 DI；作者 bounded-history/scoped-messages/
//   tavern-helper-context 用固定提交 68215e47 的真身，缺失即响亮失败，不 skip。
// 本闸只证明「同一 store 真读源上两实现的返回形状逐字一致（含 holes）＋回退条件一致」，
// 不冒称页面/模型输入验收，也不冒称窄读性能。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { readStoryInput, scannedStoryRows, legacyStoryBody } from '../lib/chat-query-service.js'

const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const AUTHOR68215 = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/', import.meta.url)

// ⚠ 作者 tavern-helper-context.js 的**传递** import（runtime-content-projection → reply-presentation
//   → legacy-template-display-repair）需要 jsdom，而 fixture 树里没有 node_modules。按既有
//   test/upstream-latest-window.test.mjs 的同一机制：只把**该 fixture 树内**解析不到的裸说明符
//   重定向到 tools/sql-test-kit（固定 jsdom 26.1.0），不改作者字节、不影响其它模块解析。
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
const { createBoundedHistory } = await import(new URL('bounded-history.js', AUTHOR68215))
const { lastTavernHelperVariables } = await import(new URL('tavern-helper-context.js', AUTHOR68215))
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const n of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[n] = projUnused
for (const [n, f] of Object.entries(HELPERS)) assert.equal(typeof f, 'function', '作者 helper ' + n + ' 缺失：夹具无法对账')
assert.equal(typeof createScopedMessages, 'function', '作者 createScopedMessages 缺失：无法对照 scoped 形状')
assert.equal(typeof createBoundedHistory, 'function', '作者 createBoundedHistory 缺失：无法对照')
assert.equal(typeof lastTavernHelperVariables, 'function', '作者 lastTavernHelperVariables 缺失：无法对照变量楼判定')

/** 作者 storyContext/hookChatForSession 的两条 enough 谓词（原样，用于双跑对照）。 */
const mvuReplies = rows => rows.filter(row => row?.role === 'assistant' && row.variables?.[Math.max(0, Number(row.swipeId) || 0)]?.stat_data !== undefined).length >= 2
const alwaysEnough = () => true

/** SESSION：宿主注入的三件依赖（真 store 的 readWindow ＋ 作者 lastTavernHelperVariables 判据 ＋
 *  作者 createScopedMessages 协议投影）。三者都必须由宿主注入：查询模块不 import store/作者树。 */
const session = store => ({
  readWindow: store.readWindow,
  hasLastVariables: rows => lastTavernHelperVariables(rows) !== undefined,
  createScopedMessages,
})

function fixture(t, name) {
  const root = mkdtempSync(path.join(tmpdir(), 'native-story-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS })
  const readers = []
  // 清理必须在一个 after 里按序做：t.after 是**注册序**执行，若单独用 after 关只读句柄会晚于删目录，
  // Windows 上 rmSync 遇占用即 EPERM，会把已通过的断言记成测试失败（本轮实测踩中）。
  t.after(() => {
    for (const db of readers) { try { db.close() } catch { /* 已关 */ } }
    try { store.dispose?.() } catch { /* 已释放 */ }
    rmSync(root, { recursive: true, force: true })
  })
  return { root, chatId: name, store, readers }
}

/** fixture 的真 SQLite 只读句柄（交给 fixture 的清理统一关，不另起 after）。 */
function reader(f, name = f.chatId) {
  const db = new DatabaseSync(f.store.rollbackArchivePath(name), { readOnly: true })
  f.readers.push(db)
  return db
}

const row = (index, role, extra = {}) => ({
  role, turn: index, text: 'rev' + (index + 1), sourceText: 'rev' + (index + 1),
  ...(extra.greeting === undefined ? {} : { greeting: extra.greeting }),
  ...(extra.variables === undefined ? {} : { variables: [extra.variables] }),
})

/**
 * 120 楼夹具（revision 1）：楼层语义
 *   0–29                     greeting/hole（窗口外空洞来源）
 *   30                       带变量的非 helper 楼 ⇒ 存储 worldMessage 指向它
 *   31–105                    全部 greeting=true ⇒ scannedStoryRows 不计（翻页必须继续）
 *   106/112/118               助手正文（两条带 stat_data ⇒ mvuReplies 可满足）
 *   其余 107–119              用户楼
 * 深度 60 ⇒ 窗口内 story 行（106/112/118 + 107–117 中 9 楼）＝12 < 60 ⇒ 必须向前翻页到 0。
 */
function chat120(chatId) {
  const messages = []
  for (let index = 0; index < 120; index++) {
    if (index === 30) { messages.push(row(index, 'assistant', { variables: { stat_data: { hp: 1 }, schema: {} } })); continue }
    const greeting = index >= 31 && index <= 105
    messages.push(row(index, [106, 112, 118].includes(index) ? 'assistant' : 'user', { greeting }))
  }
  return {
    id: chatId, sessionId: 'session-story-fixture', _storageRevision: 1, updatedAt: 1,
    mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    requestMode: 'story', cardName: 'fixture', timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 1, checkpoints: [] },
    messages,
  }
}

/** 200 楼夹具：全部 greeting ⇒ scannedStoryRows 永远为 0，只能靠上限退出。 */
function chat200(chatId) {
  const messages = []
  for (let index = 0; index < 200; index++) messages.push(row(index, 'user', { greeting: true }))
  return {
    id: chatId, sessionId: 'session-story-fixture', _storageRevision: 1, updatedAt: 1,
    mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 1, checkpoints: [] },
    messages,
  }
}

/** 20 楼夹具；档顶有变量楼由调用方加。用于「续页 limit 大于剩余楼层」场景。 */
function chat20(chatId) {
  const messages = []
  for (let index = 0; index < 20; index++) messages.push(row(index, 'user', { greeting: true }))
  return {
    id: chatId, sessionId: 'session-story-fixture', _storageRevision: 1, updatedAt: 1,
    mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 1, checkpoints: [] },
    messages,
  }
}

test('story输入续页limit大于剩余楼层时以作者三条件为准不误判', async t => {
  const f = fixture(t, 'chat-story-input-partial-page')
  const chat = chat20(f.chatId)
  chat.messages[9] = { ...chat.messages[9], variables: [{ stat_data: { hp: 2 } }] }
  await f.store.update(f.chatId, () => chat)
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })
  // 首窗 from=0（20 楼）且深度未满足 ⇒ 仍要翻页；此时 limit(48) > 剩余 from(20)
  // ⇒ 续页段被截到 0 楼，页起点是 0 而不是 from-limit：作者只查 revision 与 page.to。
  const need = { storyRows: 30, lastAssistant: true, lastVariables: true, revision: 1 }

  const ours = await readStoryInput(db, { chatId: f.chatId, need }, session(f.store))
  const theirs = await author.read(f.chatId, undefined, need)
  assert.notEqual(theirs, undefined, '作者必须给出窗口（否则对照无意义）')
  assert.deepEqual(ours, theirs, '续页段被截到档案起点时两实现必须同形')
  assert.equal(ours.from, 0)
  assert.equal(ours.messageCount, 20)
  assert.equal(ours.chat.messages[0].text, 'rev1', '续页取回 0 楼（不得因页起点≠from-limit 误判 undefined）')
  assert.equal(ours.chat.messages[9].variables[0].stat_data.hp, 2, '变量楼在窗口内 ⇒ 不再额外补入')
  assert.equal(ours.chat.messages.length, 20)
})

test('story输入与作者boundedHistory在同一readWindow下逐字等价含空洞与变量楼', async t => {
  const f = fixture(t, 'chat-story-input-equivalent')
  await f.store.update(f.chatId, () => chat120(f.chatId))
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })
  const need = { storyRows: 60, lastAssistant: true, lastVariables: true, enough: mvuReplies, revision: 1 }

  const ours = await readStoryInput(db, { chatId: f.chatId, sessionId: 'session-story-fixture', need }, session(f.store))
  const theirs = await author.read(f.chatId, 'session-story-fixture', need)

  assert.notEqual(theirs, undefined, '作者 boundedHistory 必须给出窗口（否则对照无意义）')
  assert.deepEqual(ours, theirs, '同一 readWindow 下两实现必须返回同一形状')
  // 逐点复核形状（不只看 deepEqual）。翻页停止点按作者公式实算：首窗 48 楼（72–119）内
  // story 行 12；续页 limit=Math.max(48,48)=48 ⇒ 24–71（story 行 0，累计 12）；再 48 ⇒ 页起点
  // 仍是 0？不：rows=96 ⇒ limit=96 ⇒ 页 0 ⇒ 累计变 60（达到深度）但该页**已经把窗口带到 0**，
  // 而 satisfied() 是在进入循环体前判定的 ⇒ 先在再取一页前判定：rows=96、from=24 时深度
  // scanned(24..119)＝12+4＝16 < 60 ⇒ 再取一页 limit=96 from=0（截断）⇒ rows=120、from=0。
  assert.equal(ours.from, 0, '深度 60 需一路取到 0 楼')
  assert.equal(ours.messageCount, 120)
  assert.equal(ours.revision, 1)
  assert.equal(ours.chat.messages.length, 120, 'scoped 长度＝完整 messageCount')
  assert.equal(Object.hasOwn(ours.chat.messages, 0), true, '翻到 0 楼后 0 楼在窗口内（不是空洞）')
  assert.equal(ours.chat.messages[0].text, 'rev1')
  assert.equal(ours.chat.messages[105].greeting, true, 'greeting 楼照读，只是不计入深度')
  assert.equal(ours.chat.messages[119].text, 'rev120')
  // 变量楼 30：翻到 0 楼后本就在窗口内 ⇒ 不再额外补入（作者 from>0 才补）
  assert.equal(ours.chat.messages[30].text, 'rev31')
  assert.equal(ours.chat.messages[30].variables[0].stat_data.hp, 1)
})

test('story输入在窗口未覆盖档案起点时worldMessage按绝对坐标补入变量楼', async t => {
  const f = fixture(t, 'chat-story-input-window-outside')
  const chat = chat120(f.chatId)
  // 关键：store 的 worldMessage()（同 dbReadSource）取的是**最高号**合格楼（8 与 30 都合格时返回 30，
  // 探针实测），所以要真的走到"窗口外补楼"这一支，必须让窗口外的变量楼是**唯一**合格楼。
  chat.messages[8] = { ...chat.messages[8], variables: [{ stat_data: { hp: 8 } }] }
  delete chat.messages[30].variables
  await f.store.update(f.chatId, () => chat)
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })
  // storyRows 12 在首窗（72–119）内即满足 ⇒ 窗口停在 from=72；唯一变量楼 8 在窗口外 ⇒ 必须按 worldMessage 补一楼
  const need = { storyRows: 12, lastAssistant: true, lastVariables: true, revision: 1 }

  const ours = await readStoryInput(db, { chatId: f.chatId, sessionId: 'session-story-fixture', need }, session(f.store))
  const theirs = await author.read(f.chatId, 'session-story-fixture', need)
  assert.notEqual(theirs, undefined, '作者必须给出窗口')
  assert.deepEqual(ours, theirs, '变量楼补入路径必须与作者同形')
  assert.equal(ours.from, 72)
  assert.equal(ours.chat.messages[8].variables[0].stat_data.hp, 8, '世界索引定位的变量楼按绝对坐标补入')
  assert.equal(ours.chat.messages[7], undefined, '补入楼以下仍是空洞')
  assert.equal(ours.chat.messages[9], undefined, '补入楼以上、窗口以下仍是空洞')
  assert.equal(ours.chat.messages[71], undefined, '窗口起点以下仍是空洞')
  assert.equal(ours.chat.messages[72].text, 'rev73', '窗口首楼按绝对坐标')
  assert.equal(ours.chat.messages.length, 120, 'scoped 长度＝完整 messageCount')
})

test('story输入在档内没有任何变量楼时worldMessage为null且不补楼', async t => {
  const f = fixture(t, 'chat-story-input-no-world')
  const chat = chat120(f.chatId)
  delete chat.messages[30].variables
  await f.store.update(f.chatId, () => chat)
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })
  const need = { storyRows: 12, lastAssistant: true, lastVariables: true, revision: 1 }

  const ours = await readStoryInput(db, { chatId: f.chatId, sessionId: 'session-story-fixture', need }, session(f.store))
  const theirs = await author.read(f.chatId, 'session-story-fixture', need)
  assert.equal(await f.store.readWindow(f.chatId, { limit: 1, includeCheckpoints: true }).then(w => w.worldMessage), null,
    '无变量楼时 store 世界索引必须为 null（跳过补楼，不是 undefined 的"不支持"）')
  assert.notEqual(theirs, undefined, '世界楼为 null 时作者仍给出窗口')
  assert.deepEqual(ours, theirs, 'null 世界的跳过行为必须与作者一致')
  assert.equal(ours.from, 72)
  assert.equal(ours.chat.messages[30], undefined, '无变量楼 ⇒ 不补任何窗口外楼层')
  assert.equal(ours.chat.messages[71], undefined)
  assert.equal(ours.chat.messages[72].text, 'rev73')
  assert.equal(ours.chat.messages.length, 120, 'scoped 长度＝完整 messageCount')
})

test('story输入在enough不满足时翻页到上限返回undefined且与作者一致', async t => {
  const f = fixture(t, 'chat-story-input-maxrows')
  await f.store.update(f.chatId, () => chat200(f.chatId))
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow, pageSize: 32, maxRows: 48 })
  const need = { storyRows: 1, enough: alwaysEnough, revision: 1 }

  assert.equal(await readStoryInput(db, { chatId: f.chatId, need, pageSize: 32, maxRows: 48 }, session(f.store)), undefined,
    '全部 greeting ⇒ 扫描深度永不满足 ⇒ 到 48 楼上限返回 undefined，不做静默降级')
  assert.equal(await author.read(f.chatId, undefined, need), undefined, '作者同输入同样返回 undefined')
  // 上限确实生效（没生效就会一路读完 200 楼）：同一档、把上限放到 4000 才返回窗口
  const relaxed = await readStoryInput(db, { chatId: f.chatId, need, pageSize: 32, maxRows: 4000 }, session(f.store))
  assert.notEqual(relaxed, undefined, '把上限放宽后必须能读完（证明上一行的 undefined 来自上限）')
  assert.equal(relaxed.from, 0)
  assert.equal(relaxed.messageCount, 200)
})

test('story输入在翻页期间revision推进时中止返回undefined', async t => {
  const f = fixture(t, 'chat-story-input-revision')
  await f.store.update(f.chatId, () => chat120(f.chatId))
  const db = reader(f)
  const need = { storyRows: 60, lastAssistant: true, revision: 1 }
  const firstPage = await f.store.readWindow(f.chatId, { limit: 48, includeCheckpoints: true })
  assert.equal(firstPage.revision, 1)

  // ① 续页读到 head 已推进（写发生在两次窗口读之间）：不得把旧 header 与新页拼起来
  let calls = 0
  const advanced = { ...session(f.store), readWindow: async (chatId, options) => {
    calls += 1
    if (calls === 1) return f.store.readWindow(chatId, options)
    return { chat: { ...firstPage.chat, _storageRevision: 2 }, messageCount: 120, from: 24, to: 71, revision: 2 }
  } }
  assert.equal(await readStoryInput(db, { chatId: f.chatId, need }, advanced), undefined,
    '续页 revision 与首窗不符 ⇒ 中止返回 undefined')
  assert.equal(calls, 2, '必须在续页读处中止（不是首窗）')

  // ② 首窗就 pin 不上（读发生在写之后）：同当前头不符 ⇒ undefined，不返回旧快照
  await f.store.update(f.chatId, stored => ({ ...stored, _storageRevision: 2 }))
  assert.equal(await readStoryInput(db, { chatId: f.chatId, need }, session(f.store)), undefined, 'pin 与当前头不符 ⇒ undefined')
  assert.equal(await createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow }).read(f.chatId, undefined, need), undefined,
    '作者同条件同样 undefined（分流一致）')

  // ③ 身份不符：与作者同一 readWindow 下的结果一致
  const fresh = { ...need, revision: 2 }
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })
  assert.equal(await author.read(f.chatId, 'other-session', fresh), undefined)
  assert.equal(await readStoryInput(db, { chatId: f.chatId, sessionId: 'other-session', need: fresh }, session(f.store)), undefined)
})

test('story输入在版本不符时显式返回undefined且深度判据逐字等价', async t => {
  const f = fixture(t, 'chat-story-input-not-applicable')
  await f.store.update(f.chatId, () => ({ ...chat120(f.chatId), backgroundConfigVersion: 2 }))
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })
  const need = { storyRows: 1, revision: 1 }

  assert.equal(await readStoryInput(db, { chatId: f.chatId, need }, session(f.store)), undefined, 'backgroundConfigVersion≠1 ⇒ undefined')
  assert.equal(await author.read(f.chatId, undefined, need), undefined, '作者同条件同样 undefined（分流一致）')
  assert.equal(await readStoryInput(db, { chatId: f.chatId, need, sessionId: 'other-session' }, session(f.store)), undefined, 'sessionId 不符 ⇒ undefined')
  // legacyStory 判据本身（作者 bounded-history.js:4-5）：body 已前台完成 ⇒ 只能走完整读
  const legacy = { ...chat120(f.chatId), timeline: { operations: { op: { kind: 'body', status: 'foreground-completed' } } } }
  assert.equal(legacyStoryBody(legacy), true, 'legacyStory 判据必须与作者同源语义')
  assert.equal(legacyStoryBody(chat120(f.chatId)), false)
  // 扫描判据本身（作者逐字等价）
  assert.equal(scannedStoryRows([{ role: 'user', greeting: true }, { role: 'assistant' }], 2), false, 'greeting 不计入深度')
  assert.equal(scannedStoryRows([{ role: 'user', greeting: true }, { role: 'assistant' }], 1), true)
})

test('story输入深度默认0与负深度与作者同判', async t => {
  const f = fixture(t, 'chat-story-input-depth')
  await f.store.update(f.chatId, () => chat120(f.chatId))
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })

  // storyRows 缺省＝0（作者解构默认）⇒ 首窗内即满足，单页返回；作者同
  const missingDepth = { revision: 1 }
  const oursDefault = await readStoryInput(db, { chatId: f.chatId, need: missingDepth }, session(f.store))
  const theirsDefault = await author.read(f.chatId, undefined, missingDepth)
  assert.deepEqual(oursDefault, theirsDefault, '深度缺省时两实现必须同形')
  assert.equal(oursDefault.from, 72, '深度 0 ⇒ 不翻页')

  // 负深度 ⇒ 不是合法扫描深度：两边都必须 undefined，不得当 0 用
  const negative = { revision: 1, storyRows: -1 }
  assert.equal(await readStoryInput(db, { chatId: f.chatId, need: negative }, session(f.store)), undefined, '负深度 ⇒ undefined')
  assert.equal(await author.read(f.chatId, undefined, negative), undefined, '作者负深度同样 undefined')
})

test('story输入具名include楼与作者同读同一revision补入', async t => {
  const f = fixture(t, 'chat-story-input-include')
  await f.store.update(f.chatId, () => chat120(f.chatId))
  const db = reader(f)
  const author = createBoundedHistory({ links: async () => ({}), readWindow: f.store.readWindow })
  const need = { storyRows: 60, lastAssistant: true, lastVariables: true, include: [10, 10, 0, 119] }

  const ours = await readStoryInput(db, { chatId: f.chatId, need }, session(f.store))
  const theirs = await author.read(f.chatId, undefined, need)
  assert.notEqual(theirs, undefined)
  assert.deepEqual(ours, theirs, 'include 去重/越界/已覆盖跳过的行为必须与作者一致')
  assert.equal(ours.from, 0)
  assert.equal(ours.chat.messages[10].text, 'rev11', '具名楼按绝对坐标补入')
  assert.equal(ours.chat.messages[0].text, 'rev1')
  assert.equal(ours.chat.messages[119].text, 'rev120', '窗口内具名楼不重复补入')
  // 越界具名楼 ⇒ 整个读取 undefined（作者同）
  const out = { ...need, include: [120] }
  assert.equal(await readStoryInput(db, { chatId: f.chatId, need: out }, session(f.store)), undefined, '越界具名楼必须 undefined')
  assert.equal(await author.read(f.chatId, undefined, out), undefined, '作者越界具名楼同样 undefined')
})

test('story输入缺注入helper或非真句柄时响亮失败不静默', async t => {
  const f = fixture(t, 'chat-story-input-helpers')
  await f.store.update(f.chatId, () => chat120(f.chatId))
  const db = reader(f)
  await assert.rejects(() => readStoryInput(db, { chatId: f.chatId, need: {} }, { createScopedMessages }),
    /缺少注入 helper readWindow/, '缺 readWindow 必须响亮失败')
  await assert.rejects(() => readStoryInput(db, { chatId: f.chatId, need: { lastVariables: true, storyRows: 0 } }, { readWindow: f.store.readWindow }),
    /缺少注入 helper createScopedMessages/, '缺 createScopedMessages 必须响亮失败')
  await assert.rejects(() => readStoryInput({}, { chatId: f.chatId }, session(f.store)),
    /需要真实 SQLite 句柄/, '非真句柄必须响亮失败')
  await assert.rejects(() => readStoryInput(db, { chatId: '' }, session(f.store)),
    /缺少 chatId/, '缺 chatId 必须响亮失败')
})

test('story输入同库真句柄经store.readWindow读窗口与store.readWindow同形状', async t => {
  const f = fixture(t, 'chat-story-input-real-window')
  await f.store.update(f.chatId, () => chat120(f.chatId))
  const db = reader(f)
  const need = { storyRows: 12, lastAssistant: true, lastVariables: true }
  const ours = await readStoryInput(db, { chatId: f.chatId, sessionId: 'session-story-fixture', need }, session(f.store))
  assert.notEqual(ours, undefined, 'storyRows 12 在首窗内即可满足 ⇒ 单页返回')
  assert.equal(ours.from, 72, '首窗起点＝messageCount-48')
  assert.equal(ours.messageCount, 120)
  // 同页窗口对照：store.readWindow 的同一页（窗口内坐标与空洞语义必须一致）
  const plainWindow = await f.store.readWindow(f.chatId, { limit: 48, includeCheckpoints: true })
  assert.equal(plainWindow.from, ours.from)
  assert.equal(plainWindow.revision, ours.revision)
  assert.equal(plainWindow.messageCount, ours.messageCount)
  assert.equal(ours.chat.messages[0], undefined, '首窗以下仍是空洞')
  // 两套坐标必须分清（实测）：readStoryInput 用作者 createScopedMessages(messageCount, entries) ⇒ 下标
  // 是**绝对楼号**；store.readWindow 的窗口 messages 是**窗口内相对**下标（0..47）。
  assert.deepEqual(Object.keys(ours.chat.messages), ['30', ...Array.from({ length: 48 }, (_, i) => String(72 + i))],
    'scoped 拥有键＝世界楼 + 窗口的绝对楼号')
  assert.equal(plainWindow.chat.messages.length, 48)
  assert.deepEqual(Object.keys(plainWindow.chat.messages), Array.from({ length: 48 }, (_, i) => String(i)),
    'store.readWindow 的窗口 messages 是窗口内相对下标')
  // 同一楼在两套坐标下同值（末楼 119 ＝ 窗口相对 47）
  assert.deepEqual(ours.chat.messages[119], plainWindow.chat.messages[47], '同一楼在两套坐标下必须同值')
  assert.deepEqual(ours.chat.messages[72], plainWindow.chat.messages[0], '窗口首楼两套坐标对应关系')
  assert.equal(ours.chat.messages[3], undefined, '窗口内相对下标对 scoped 是空洞（坐标不同）')
  assert.equal(ours.chat.messages[75].text, 'rev76', 'scoped 绝对坐标：75 楼')
  assert.equal(plainWindow.chat.messages[3].text, 'rev76', '窗口相对坐标：3 号即 75 楼')
  // chat120 的世界索引实测＝30（该夹具唯一合格变量楼；窗口 72–119 内没有变量楼）
  // ⇒ 最新变量楼补入路径在本夹具被走到：30 楼作为额外一楼补进 scoped，且拥有键恰为 {30} ∪ [72,119]
  assert.equal(await f.store.readWindow(f.chatId, { limit: 1, includeCheckpoints: true }).then(w => w.worldMessage), 30,
    'store 世界索引指向 30 楼（唯一合格变量楼）')
  assert.equal(ours.chat.messages[30].text, 'rev31', '最新变量楼按绝对坐标补入')
  assert.equal(ours.chat.messages[30].variables[0].stat_data.hp, 1, '补入的正是变量楼本身')
  assert.equal(Object.keys(ours.chat.messages).length, 49, '拥有键数＝1 个补入变量楼 + 48 楼窗口（无重复补入）')
})
