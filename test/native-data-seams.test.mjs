// 新增独占具名断言（S1/S2 装配侧）：标准接缝装卸新桥 storage-native-data.js 并恢复作者字节。
// 夹具改用本地真实作者 source fixture（helper 有限复制 maintenanceTargets + 作者包身份），不再读随包旧 gz catalog。
// 不读真实档/远端/禁令对象；不提交；合成数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { applyNativeDataTransform, isNativeDataApplied } from '../deploy/native-data-transform.mjs'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { AUTHOR_VERSION } from '../lib/standard-host.js'
import { activeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'
import { disposeNativeDataPrepare, nativeDataMetrics, nativeDataSeamSource } from './support/native-data-prepare.mjs'

// 与 A 闸同机制的真实 helper（作者 2.5 真身 copy/diff/apply ＋ 5 显示投影脱离替身）
const AUTHOR25 = '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin/lib/domain/'
const { copyJsonTree } = await import(new URL(AUTHOR25 + 'copy-json-tree.js', import.meta.url))
const { diffJson, applyJsonChangesShared } = await import(new URL(AUTHOR25 + 'json-mutation.js', import.meta.url))
const projUnused = v => (v === undefined ? undefined : structuredClone(v))
const HELPERS = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) HELPERS[name] = projUnused

const RECORD = COMMENT_SEAMS_RECORD
const BRIDGE = 'tavern-plugin/lib/domain/storage-native-data.js'
const INDEX = 'tavern-plugin/lib/index.js'

/** 本次实际执行到的共享准备消费者数（只选一条时指标按实际计，不虚报"两用例都跑了"）。 */
let casesRan = 0

/** 真实作者 source fixture → 独立 tmp（helper 只复制 maintenanceTargets + 作者包；缺失即响亮失败，不 skip）。
 *  只给**第 1 条装卸用例**用（保持自身独立、不参与共享准备）。 */
function fixture(t) {
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  t.after(tree.cleanup)                                              // 只删 helper 自己的 mkdtemp 目录
  return { appDir: tree.appDir, original: tree.original }
}

// 原正向结果迁至 standard-positive.test.mjs；其余场景保留独立现场。


/** 真实 store 夹具：沿用既有 A 闸机制（8 个真实/脱离 helper ＋ 自有 tmp；与原装卸夹具互不影响）。 */
function createStoreFixture(t, chatId = 'chat-consumer-fixture') {
  const root = mkdtempSync(path.join(tmpdir(), 'native-data-consumer-'))
  mkdirSync(path.join(root, 'chats'), { recursive: true })
  const store = createChatSqliteStore({ dataRoot: root, legacyData: undefined, helpers: HELPERS })
  t.after(() => { try { store.dispose?.() } catch { /* 已释放 */ } ; rmSync(root, { recursive: true, force: true }) })
  return { root, chatId, store }
}

/** 按真实整行函数声明截取（保留 async；到下一处行首 "  }" 结束，B harness 方法）。 */
function sliceFunction(text, name) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^\s*(?:async\s+)?function\s+/.test(line) && line.includes(' ' + name + '('))
  assert.ok(start >= 0, '源码中缺函数：' + name)
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '  }') return lines.slice(start, i + 1).join('\n')
  }
  throw new Error('函数体未闭合：' + name)
}

/** 只写不跑：query consumer 两链（readOpeningWindow / sessionActivity 走同一真 store，不含 view — scope query consumer）。 */
test('S1 S2同真store查询消费者走SQL快路径', async t => {
  const f = createStoreFixture(t)
  const chatId = f.chatId
  const sessionId = 'session-consumer-fixture'
  const chat = {
    id: chatId, sessionId, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    _storageRevision: 1, updatedAt: 1,
    timeline: {
      schemaVersion: 1, branchId: 'branch-main', revision: 3, participants: {},
      operations: { 'op-agent-running': { id: 'op-agent-running', kind: 'agent', role: 'background', status: 'running', turn: 7, createdAt: 30, background: { phase: 'running', role: 'background', updatedAt: 31 } } }
    },
    messages: Array.from({ length: 90 }, (_v, index) => ({ role: 'index' && index % 2 === 0 ? 'user' : 'assistant', text: 'msg-' + index, turn: Math.floor(index / 2) + 1 }))
  }
  await f.store.update(chatId, () => chat)
  const stored = await f.store.read(chatId)                    // 真 store 读（不是 readChat）
  // source＝与下一用例**共享一次**真实施缝准备（support/native-data-prepare.mjs：懒单例 + 缓存命中）；
  // 真实施缝仍由 applyStandardSeams 完成（不自行调 transform、不猜 depsExpression），真 store 仍本用例独立。
  casesRan += 1
  const transformed = nativeDataSeamSource()
  assert.equal(isNativeDataApplied(transformed), true, '共享准备的 ACTIVE 投影必须已应用 native-data 转换')
  const api = new Function(
    'readSessionMap', 'str', 'chatJournalStore', 'HELPER_MESSAGE_COLD_WINDOW', 'readRecentWindow',
    'chatPersistence', 'taskStateReader',
    'return { readOpeningWindow: ' + sliceFunction(transformed, 'readOpeningWindow') + ',\n' +
    ' sessionActivity: ' + sliceFunction(transformed, 'sessionActivity') + ' }'
  )(
    async () => ({ [sessionId]: chatId }), String, f.store, 24,
    () => { throw new Error('query consumer 链不应回落 readRecentWindow') },
    { readWindow: () => { throw new Error('不得回落 chatPersistence.readWindow') } },
    { forSession: async () => { throw new Error('sessionActivity 不得依赖 taskStateReader') } }
  )
  // ① readOpeningWindow：默认历史起点由快路径给出；显式历史 from 原样保留（同真 store）
  const def = await api.readOpeningWindow(sessionId)
  assert.equal(def.from, 66, '默认 from 应为 66（limit 24 时的冷窗起点）')
  assert.equal(def.to, 89)
  const hist = await api.readOpeningWindow(sessionId, 30)
  assert.equal(hist.from, 30, '显式历史 from 必须原样保留')
  // ② sessionActivity：走 SQL 快路径（throwing taskReader 未被调用）⇒ 原状态 running
  const activity = await api.sessionActivity(sessionId)
  assert.equal(activity.phase, 'running')
  assert.equal(activity.busy, true)
  assert.equal(activity.operationId, 'op-agent-running')
  // ③ 不存在档：null（不是 throws）
  assert.equal(f.store.readActivitySummary({ chatId: 'no-such-chat' }), null)
  assert.equal(stored.messages.length, 90)
})

/** 只写不跑：第 3 链 projectOpeningWindow（scope＝形状分发＋guard，不装全宿主/page 业务）。 */
test('S1 S2同真store窗口消费者形状分发与guard', async t => {
  const f = createStoreFixture(t)
  const chatId = f.chatId
  const sessionId = 'session-window-fixture'
  const chat = {
    id: chatId, sessionId, mode: 'story', backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
    _storageRevision: 1, updatedAt: 1,
    timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 3, participants: {}, operations: {} },
    messages: Array.from({ length: 90 }, (_v, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', text: 'msg-' + index, turn: Math.floor(index / 2) + 1 }))
  }
  await f.store.update(chatId, () => chat)
  // 与上一用例共享同一份准备（第二次必然命中缓存；真 store/窗口状态本用例独立）
  casesRan += 1
  const transformed = nativeDataSeamSource()
  const viewCalls = [], fallbackCalls = [], cardCalls = []
  let projectorMode = 'native'
  let projectCalls = 0, staleAdvances = 0, openingReads = 0
  // f.store 只读（不可打补丁）：经委派包装计数——fastPath 重投影时在 chatJournalStore 上重读窗口。
  const countingStore = {
    readOpeningWindow: (...args) => { openingReads += 1; return f.store.readOpeningWindow(...args) },
    readActivitySummary: (...args) => f.store.readActivitySummary(...args),
  }
  const capsProjector = {
    // 真契约：project 收**单个输入对象** { chat, window, activity, card, options, resourceKey }，判据是 input.window.nativeData
    project: async (input) => {
      assert.ok(input && typeof input === 'object', 'project 必须收到单个输入对象（真 fastPath 契约）')
      const win = input.window
      assert.equal(win && win.nativeData, true, 'project 必须由 nativeData window 触发')
      assert.equal(input.chat && input.chat.id, chatId, 'project 必须带同一 store 的真 chat')
      projectCalls += 1
      if (projectorMode === 'not-applicable') return { kind: 'not-applicable', reason: 'legacy-body' }
      if (projectorMode === 'throw') throw new Error('view 不得在 nativeData 分支被调用')
      // 竞态模拟（issue #6）：project await 期间真 store 推进 revision——过期由 fastPath 内置
      // readActivitySummary（读最新＋比较 revision）检出并触发重投影，不再由本 stub 抛错。
      if ((projectorMode === 'stale-once' && staleAdvances === 0) || projectorMode === 'stale-forever') {
        staleAdvances += 1
        await f.store.update(chatId, current => ({ ...current, _storageRevision: Number(current._storageRevision || 1) + 1 }))
      }
      return { kind: 'value', view: { chatId }, options: input.options }
    },
    finishOpeningWindow: result => result,   // 真投影器为同步函数（fastPath 里 `….finishOpeningWindow(…).view` 无 await）
  }
  const api = new Function(
    'helperHistoryAccess', 'readSessionMap', 'str', 'chatJournalStore', 'HELPER_MESSAGE_COLD_WINDOW',
    'readRecentWindow', 'chatPersistence', 'sessionWindowProjector', 'createSessionWindowProjector', 'view', 'readChatCard',
    'return { projectOpeningWindow: ' + sliceFunction(transformed, 'projectOpeningWindow') + ' }'
  )(
    { count: async () => 0 },
    async () => ({ [sessionId]: chatId }),
    String, countingStore, 24,
    async () => { fallbackCalls.push('readRecentWindow'); return { from: 0, to: 89, messageCount: 90, chat: { messages: [] } } },
    { readWindow: () => { throw new Error('不得回落 chatPersistence.readWindow') } },
    capsProjector,                     // 占位：注入体内部会自己构造，遮掉不影响
    () => capsProjector,               // 真工厂：让注入体构造出的就是本 stub
    async () => { viewCalls.push('view'); return { chat: { messages: [] } } },
    async () => ({ id: 'card-fixture', name: 'fixture-card', __mark: cardCalls.push('readChatCard') })
  )
  // 真签名：第一参是 window 对象（chat/from/to/messageCount/revision 可选 nativeData）；revision 取 store 当前真值
  const pinnedRevision = f.store.readActivitySummary({ chatId }).revision
  const stored = await f.store.read(chatId)
  const nativeWindow = () => ({ chat: stored, from: 0, to: 89, messageCount: 90, revision: pinnedRevision, nativeData: true, card: { id: 'card-fixture' } })
  // ① nativeData window ⇒ 走 projector，不调 view；成功时返回 finishOpeningWindow(...).view（非 {kind} 包装）
  const projected = await api.projectOpeningWindow(nativeWindow())
  assert.deepEqual(projected, { chatId }, 'fastPath 成功应返回 finishOpeningWindow(...).view')
  assert.equal(viewCalls.length, 0, 'nativeData 分支不得调用 view')
  assert.equal(fallbackCalls.length, 0, 'nativeData 分支不得回落 readRecentWindow')
  // ② 单次写入竞态（issue #6）：guard 检出过期 ⇒ 立即重投影一次即成（零退避），返回新 revision 的 view
  projectorMode = 'stale-once'
  const projectBeforeRace = projectCalls, readsBeforeRace = openingReads
  const raceStart = Date.now()
  const raced = await api.projectOpeningWindow(nativeWindow())
  assert.deepEqual(raced, { chatId }, '单次竞态重投影后必须返回 finishOpeningWindow(...).view')
  assert.equal(projectCalls - projectBeforeRace, 2, '恰好一次立即重投影（初始+1，无退避）')
  assert.equal(openingReads - readsBeforeRace, 1, '重试必须按最新 revision 重读窗口')
  assert.equal(Date.now() - raceStart < 90, true, '首次重试不得等待（单次写入竞态零退避即成）')
  assert.equal(viewCalls.length, 0, '竞态处理不得回落到 view')
  assert.equal(fallbackCalls.length, 0, '竞态处理不得回落 readRecentWindow')
  // ③ 连续写入竞态：初始+3 次重投影均被追上 ⇒ 响亮报错（含次数）；第 2/3 次重试前各退避 ≥100ms
  projectorMode = 'stale-forever'
  const projectBeforeForever = projectCalls, readsBeforeForever = openingReads
  const foreverStart = Date.now()
  await assert.rejects(async () => api.projectOpeningWindow(nativeWindow()), /连续过期.*4 次投影/, '连续竞态用尽重试必须响亮报错')
  assert.equal(projectCalls - projectBeforeForever, 4, '初始+3 次重投影后仍被追上才报错（有界，不循环）')
  assert.equal(openingReads - readsBeforeForever, 3, '每次重投影前都按最新 revision 重读窗口')
  assert.equal(Date.now() - foreverStart >= 200, true, '第 2/3 次重试前各退避 ≥100ms（两次合计 ≥200ms）')
  assert.equal(viewCalls.length, 0, '重试耗尽也不得回落到 view')
  assert.equal(fallbackCalls.length, 0, '重试耗尽也不得回落 readRecentWindow')
  projectorMode = 'native'
  // ④ not-applicable ⇒ 落到作者**原体**继续执行（readChatCard＋view 被走到），不返回 projector view
  projectorMode = 'not-applicable'
  const cardCallsBefore = cardCalls.length
  await api.projectOpeningWindow({ chat: stored, from: 0, to: 89, messageCount: 90, revision: pinnedRevision, nativeData: true })
  assert.equal(cardCalls.length > cardCallsBefore, true, 'not-applicable 必须落作者原体（readChatCard 被调用）')
  assert.equal(viewCalls.length > 0, true, 'not-applicable 走作者原体（view 被调用）')
  // ⑤ 无 nativeData／普通 window 走作者原体（view 可被调用 ⇒ 原路径未被吞）
  projectorMode = 'native'
  const viewCallsBefore = viewCalls.length
  await api.projectOpeningWindow({ chat: stored, from: 0, to: 89, messageCount: 90, revision: pinnedRevision })
  assert.equal(viewCalls.length > viewCallsBefore, true, '普通窗口必须仍走作者原路径（view 可被调用）')
})

// 共享准备收口：两消费者同 process 共享一次准备 ⇒ preparations 1、第二个命中缓存、cleanup 一次；
// 只跑其中一条时按实际执行数核（不虚报、也不掩盖）。
test.after(() => {
  const disposed = disposeNativeDataPrepare()
  assert.equal(nativeDataMetrics.preparations, casesRan > 0 ? 1 : 0, '共享准备次数必须等于"是否有消费者"（两消费者共同只准备 1 次）')
  assert.equal(nativeDataMetrics.cacheHits, Math.max(0, casesRan - 1), '第二个消费者必须命中缓存（未跑第二条则为 0）')
  assert.equal(nativeDataMetrics.cleanups, nativeDataMetrics.preparations, '每次准备恰一次 cleanup')
  assert.equal(disposed, casesRan > 0, '有消费者时必须真的 dispose 掉共享目录')
})
