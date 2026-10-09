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

/** 真实作者 source fixture → 独立 tmp（helper 只复制 maintenanceTargets + 作者包；缺失即响亮失败，不 skip）。 */
function fixture(t) {
  const tree = prepareCommentAuthorTree()
  assert.ok(tree, '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture')
  t.after(tree.cleanup)                                              // 只删 helper 自己的 mkdtemp 目录
  return { appDir: tree.appDir, original: tree.original }
}

test('S1 S2标准装卸保持同store能力桥并恢复作者字节', t => {
  const f = fixture(t)
  const indexPath = path.join(f.appDir, ...INDEX.split('/'))
  const indexBefore = readFileSync(indexPath)
  assert.equal(existsSync(path.join(f.appDir, ...BRIDGE.split('/'))), false, '装配前不应存在该桥（作者树无此文件）')

  // ① 装配：桥写入、记录归属（owned-new + 注释块）、check ready（前置：装配前原字节未应用转换）
  assert.equal(isNativeDataApplied(indexBefore.toString('utf8')), false, '前置（装配前原字节）：尚未应用 native-data 转换')
  assert.equal(applyStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION, assertStopped: () => true }).changed, true)
  const bridgePath = path.join(f.appDir, ...BRIDGE.split('/'))
  assert.equal(existsSync(bridgePath), true, '装配后桥必须存在')
  const bridgeAfter = readFileSync(bridgePath)
  // 桥是 projector 工厂入口（不是"同 store 摘要"本身）：同 store 的实际证明在 index 的 store 调用
  assert.match(bridgeAfter.toString('utf8'), /storagePackage\('session-window-projector'\)/, '桥必须接同一 store 能力包（session-window-projector）')
  assert.match(bridgeAfter.toString('utf8'), /createSessionWindowProjector/, '桥必须暴露 S2 窗口投影工厂')
  assert.match(bridgeAfter.toString('utf8'), /createActivitySummaryBridge/, '桥必须暴露 S1 活动摘要工厂')
  // 作者 index 上的 native-data 转换：装配后读**实际** index，必须已应用且真实调用同一 store
  const indexSeamed = readFileSync(indexPath, 'utf8')
  assert.equal(isNativeDataApplied(indexSeamed), true, '装配后实际 index 必须已应用 native-data 转换')
  assert.match(indexSeamed, /chatJournalStore\.readActivitySummary/, 'index 必须真实调用同一 store 的 readActivitySummary')
  assert.match(indexSeamed, /chatJournalStore\.readOpeningWindow/, 'index 必须真实调用同一 store 的 readOpeningWindow')
  assert.match(indexSeamed, /storage-native-data\.js/, 'index 必须 import 新桥（projector 工厂）')
  const record = JSON.parse(readFileSync(path.join(f.appDir, RECORD), 'utf8'))
  assert.equal(record.format, 1)
  assert.equal(record.owner, 'dsh-tavern-sqlite-v2')
  assert.ok(Object.hasOwn(record.owned, BRIDGE), 'owned-new 归属必须记新桥：' + BRIDGE)
  assert.equal(record.owned[BRIDGE].mode, 'owned-new')
  // 新契约：owned 记录只留 metadata 四键（不存 body）；实现字节从现场 owned-file 块的 ACTIVE 投影读。
  assert.deepEqual(Object.keys(record.owned[BRIDGE]).sort(), ['format', 'mode', 'owner', 'rel'], 'owned 记录只留 metadata 四键')
  assert.equal(Object.hasOwn(record.owned[BRIDGE], 'body'), false, 'owned 记录不得保存 body 历史')
  assert.match(activeSource(readFileSync(bridgePath, 'utf8'), BRIDGE), /storagePackage\('session-window-projector'\)/, 'ACTIVE 投影必须承载真实自有实现')
  assert.ok(Object.hasOwn(record.files, INDEX), '作者 index 必须记成注释块文件')
  assert.ok(record.files[INDEX].blocks.length > 0, 'index 必须至少一个接缝块')
  assert.equal(checkStandardSeams({ appDir: f.appDir, authorVersion: AUTHOR_VERSION }).ready, true, '装配后应 ready')

  // ② 卸载：桥移除、记录清理、作者 index 逐字节回原（不残留旧全 timeline 形态）
  assert.equal(uninstallStandardSeams({ appDir: f.appDir, assertStopped: () => true }).changed, true)
  assert.equal(existsSync(bridgePath), false, '卸载后桥必须移除')
  assert.equal(existsSync(path.join(f.appDir, RECORD)), false, '卸载后不应残留标准记录')
  assert.deepEqual(readFileSync(indexPath), indexBefore, '作者 lib/index.js 必须逐字节恢复')
  const indexAfter = readFileSync(indexPath, 'utf8')
  assert.equal(/session-window-projector|createActivitySummaryBridge/.test(indexAfter), false, '卸载后 index 不得残留新桥引用')
})

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
  // source＝独立装配后的作者 index（由 applyStandardSeams 真正施缝，不自行调 transform、不猜 depsExpression）
  const seam = fixture(t)
  assert.equal(applyStandardSeams({ appDir: seam.appDir, authorVersion: AUTHOR_VERSION, assertStopped: () => true }).changed, true)
  const seamed = readFileSync(path.join(seam.appDir, ...INDEX.split('/')), 'utf8')
  assert.equal(isNativeDataApplied(seamed), true, '装配后 source 必须已应用 native-data 转换')
  // 切缝副本只取 ACTIVE 投影：ORIGINAL 区是注释掉的作者原文，整段切片会撞锚点/重复声明。
  const transformed = activeSource(seamed, INDEX)
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
  const seam = fixture(t)
  assert.equal(applyStandardSeams({ appDir: seam.appDir, authorVersion: AUTHOR_VERSION, assertStopped: () => true }).changed, true)
  const seamed = readFileSync(path.join(seam.appDir, ...INDEX.split('/')), 'utf8')
  // 切缝副本只取 ACTIVE 投影（ORIGINAL 是注释掉的作者原文，直接切片会撞锚点/重复声明）。
  const transformed = activeSource(seamed, INDEX)
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
