// 新计算链 assemble 基线（方案 §施工顺序 第 2 项：“冻结新计算调用链后，复用已实现的 assemble 探针，
// 在对应授权/夹具下取得新链基线”）。
//
// 上游计算已改为唯一服务端执行（34b3158）：worker 子进程经 IPC 向 parent HTTP routes 请求数据，
// parent 再调本 store 的读口。本文件把这些 route → store 读口的映射**从上游源码逐一核实**后，
// 在合成夹具上用 assemble 探针量出每条读口的 assemble 归因，作为新链基线。
//
// 覆盖范围与边界（重要，别当成现场数据）：
//   · 只测 store 层，不起 worker、不发 IPC、不连现场、不调用模型；
//   · “调用频率”按映射到的读口逐个体量与序列量，**不包含真实卡脚本决定的调用次数**；
//   · 不含真实耗时。真实回合基线须另获目标档/运行实例/有界窗口授权。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { startAssembleProbe } from '../lib/assemble-probe.js'
import { activeSendCapture } from '../lib/send-acceptance.js'

const author = new URL('../../../tmp/adapt-65401-pr17/dsh-tavern-65401c0f67465acd3988f65e6c33881c40189dd0/tavern-plugin/lib/domain/', import.meta.url)
const helpers = {
  ...await import(new URL('copy-json-tree.js', author)),
  ...await import(new URL('json-mutation.js', author)),
  ...await import(new URL('chat-session-state.js', author)),
}
// 协议投影用脱离替身（同 chat-read-protocol.test.mjs 先例）：作者真身 tavern-helper-context.js
// 传递依赖 jsdom，工作区未装，无法直接 import。
helpers.projectTavernHelperMessage = (source, messageId) => {
  const swipes = Array.isArray(source.swipes) && source.swipes.length > 0 ? source.swipes : [String(source.text ?? '')]
  return { message_id: messageId, role: source.role === 'user' ? 'user' : 'assistant', message: swipes[0], swipe_id: 0, swipes, variables: {} }
}
helpers.projectTavernHelperContext = chat => ({ version: 1, chatId: String(chat?.id || ''), stateRevision: Math.max(0, Number(chat?._storageRevision) || 0), messages: [] })
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[name] = value => value
helpers.createScopedMessages = (length, entries = [], readBase) => {
  const owned = new Map(entries)
  return new Proxy(owned, {
    get(target, key) {
      if (key === 'length') return length
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index >= length) return target[key]
      if (!owned.has(key)) owned.set(key, readBase(index))
      return owned.get(key)
    },
    set(target, key, value) { owned.set(key, value); return true },
    deleteProperty() { throw new Error('Scoped messages cannot delete history') },
  })
}

const ID = 'chat-chain-baseline'
const SESSION = 'session-chain'
const FLOORS = 60
const MESSAGES = Array.from({ length: FLOORS }, (_, index) => index % 2 === 0
  ? { role: 'user', text: '输入' + index, turn: index / 2 + 1 }
  : { role: 'assistant', text: '回复' + index, turn: (index - 1) / 2 + 1, swipeId: 0, swipes: ['回复' + index], variables: [{ stat_data: { hp: index } }] })
const CHAT = () => ({ id: ID, sessionId: SESSION, _storageRevision: 1, mode: 'story', title: '新链基线档',
  backgroundConfigVersion: 1, conversationFeaturesVersion: 1,
  messages: MESSAGES.map(message => ({ ...message })),
  timeline: { schemaVersion: 1, branchId: 'main', revision: 1,
    operations: { op1: { kind: 'mvu', status: 'prepared', turn: 30 } },
    checkpoints: Array.from({ length: 30 }, (_, index) => ({ turn: index + 1, payload: 'x'.repeat(200) })),
    participants: { background: { sessionId: 'session-bg', status: 'active' } } },
  variables: { hp: 59 } })

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-chain-baseline-'))
  const stores = []
  const open = () => { const store = createChatSqliteStore({ dataRoot: root, helpers }); stores.push(store); return store }
  t.after(() => {
    stores.forEach(store => store.dispose())
    const target = path.resolve(root)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('tavern-chain-baseline-'))
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  const initial = open()
  await initial.update(ID, () => CHAT())
  initial.dispose()
  return { root, open }
}
const start = store => startAssembleProbe(store, { chatId: ID, durationMs: 60_000, maxCalls: 1000 })
/** 冷/热缓存下单调一个读口，返回本次**新增**的 assemble 数与新增归因键（累计值做差，不是快照全集）。 */
const measure = async (store, probe, fn) => {
  const before = probe.snapshot()
  await fn()
  const after = probe.snapshot()
  const reasons = []
  for (const [key, value] of Object.entries(after.byReason)) {
    const previous = before.byReason[key]?.calls || 0
    if (value.calls > previous) reasons.push(key)
  }
  return { added: after.calls - before.calls, reasons }
}

// 新链读口映射（从上游源码核实，2026-10-15）：
//   getSession → sessionViews.response → registry.resolveState → chatPersistence.readSessionState(scoped)
//             → sessionViews.response → registry.resolve  → chatForSession → chatPersistence.read（整档）
//   getTavernHelperContext → adapter.context → resolveHelperContext → chatPersistence.readHelperContext()
//   getTavernHelperContext(openingWindow) → readOpeningWindow → chatPersistence.readWindow(requirePartial)
//   hydrateTavernHelperMessages → chatPersistence.readHelperContext({from,to,revision})
//   getFullPromptTemplateState → resolveTemplateWindow → chatPersistence.readWindow()
//                               → resolveChatMetadataSlice → chatPersistence.readSlice([], fields)
test('新链基线：只读路径逐读口 assemble 归因（窄读口全零，仅整档 read 一次）', async t => {
  const { open } = await fixture(t)
  const store = open()
  const probe = start(store)
  try {
    const rows = [
      ['readSlice([]) ← resolveChatMetadataSlice', () => store.readSlice(ID, [])],
      ['readSlice([],fields) ← 模板字段', () => store.readSlice(ID, [], ['mode', 'sessionId', '_storageRevision'])],
      ['readHelperContext() ← resolveHelperContext', () => store.readHelperContext(ID)],
      ['readHelperContext(range) ← hydrateTavernHelperMessages', () => store.readHelperContext(ID, { from: 0, to: 9 })],
      ['readWindow ← resolveTemplateWindow', () => store.readWindow(ID, { limit: 48 })],
      ['readWindow(requirePartial) ← readOpeningWindow', () => store.readWindow(ID, { limit: 48, requirePartial: true })],
      ['readSessionState(scoped) ← getSession.readState', () => store.readSessionState(ID, { scoped: true })],
      ['read() ← getSession.readFullChat', () => store.read(ID)],
    ]
    const measured = []
    for (const [label, call] of rows) measured.push([label, await measure(store, probe, call)])
    // 前 7 条是新链的窄读口：一条都不许 assemble。
    for (const [label, result] of measured.slice(0, 7)) {
      assert.equal(result.added, 0, label + '：新链窄读口不得 assemble（归因=' + JSON.stringify(result.reasons) + '）')
    }
    // 唯一整档读：getSession 视图缓存未命中时才走的 readFullChat。
    const [fullLabel, full] = measured.at(-1)
    assert.equal(full.added, 1, fullLabel + '：整档 read 应恰好 assemble 一次')
    assert.deepEqual(full.reasons, ['read'])
    assert.equal(probe.snapshot().messageRows, FLOORS, '整档 read 取回全部楼层行')
  } finally { probe.stop() }
})

test('新链基线：getSession 忠实序列重复轮次 assemble 恒为 1 且全来自 readFullChat', async t => {
  const { open } = await fixture(t)
  const store = open()
  const probe = start(store)
  try {
    // 忠实顺序：先 readState（窄），视图缓存未命中才 readFullChat（整档）；随后是 worker 面向的其余读口。
    const round = async () => {
      await store.readSessionState(ID, { scoped: true })
      await store.read(ID)
      await store.readHelperContext(ID)
      await store.readHelperContext(ID, { from: 0, to: 9 })
      await store.readWindow(ID, { limit: 48 })
      await store.readSlice(ID, [])
    }
    await round()
    const first = probe.snapshot()
    assert.equal(first.calls, 1, '首轮只应有一次 assemble（来自 readFullChat）')
    assert.deepEqual(Object.keys(first.byReason), ['read'])
    for (let index = 0; index < 3; index++) {
      await round()
      const snapshot = probe.snapshot()
      assert.equal(snapshot.calls, 1, '第' + (index + 2) + '轮后 assemble 必须仍是 1（读缓存已温热）')
      assert.equal(snapshot.messageRows, FLOORS)
    }
    // readSessionState 不温热整档读缓存：它自己零 assemble，其后的 read() 仍会 assemble 一次。
    const fresh = open()
    const freshProbe = start(fresh)
    try {
      await fresh.readSessionState(ID, { scoped: true })
      assert.equal(freshProbe.snapshot().calls, 0, 'readSessionState 走投影窄读，零 assemble')
      await fresh.read(ID)
      assert.equal(freshProbe.snapshot().calls, 1, '投影窄读不温热整档读缓存，read() 仍 assemble 一次')
    } finally { freshProbe.stop() }
  } finally { probe.stop() }
})

test('新链基线：写侧头部-only patch 零 assemble，messages 路径走整档且 captureSend 仍零', async t => {
  const { root, open } = await fixture(t)
  // 上游 adapter.updateVariables：type=chat/script 时 path[0]=variables/tavernHelperScriptVariables
  // （头部-only ⇒ 第二刀快路径）；type=message 时 path[0]=messages（整档路径）。
  const store = open()
  const probe = start(store)
  try {
    const chat = await store.read(ID)
    // ① 头部-only patch（对应 type=chat 的变量写入）：零 assemble
    const head = await measure(store, probe, () => store.patch(ID, chat._storageRevision, [
      { op: 'set', path: ['variables'], value: { hp: 60 } },
      { op: 'set', path: ['_storageRevision'], value: chat._storageRevision + 1 },
    ], { source: 'tavern-helper.variables' }))
    assert.equal(head.added, 0, '新链头部-only 变量写不得 assemble（第二刀快路径）')
    assert.deepEqual(head.reasons, [])
    // ② messages 路径 patch（对应 type=message 的变量写入）：头部-only 写按方案明文取舍 forgetState
    //    （不 rememberState 窄对象），读缓存被清 ⇒ 这里要付一次冷 assemble。这是既定代价，不是回归。
    const perMessage = await measure(store, probe, () => store.patch(ID, chat._storageRevision + 1, [
      { op: 'set', path: ['messages', 1, 'variables'], value: [{ stat_data: { hp: 61 } }] },
      { op: 'set', path: ['_storageRevision'], value: chat._storageRevision + 2 },
    ], { source: 'tavern-helper.variables' }))
    assert.equal(perMessage.added, 1, '头部-only 写后读缓存被 forgetState 清掉：messages 路径 patch 付一次冷 assemble（既定代价）')
    assert.deepEqual(perMessage.reasons, ['patch'])
    // ③ 整档 patch 自己 rememberState ⇒ 紧随的第二次 messages 路径 patch 不再 assemble
    const warm = await measure(store, probe, () => store.patch(ID, chat._storageRevision + 2, [
      { op: 'set', path: ['messages', 3, 'variables'], value: [{ stat_data: { hp: 63 } }] },
      { op: 'set', path: ['_storageRevision'], value: chat._storageRevision + 3 },
    ], { source: 'tavern-helper.variables' }))
    assert.equal(warm.added, 0, '整档 patch 记住状态后，同类写不再 assemble')
    assert.deepEqual(warm.reasons, [])
    // ④ 冷缓存下的 messages 路径 patch：同样 assemble 一次（与②同源，证明不是偶发）
    const cold = open()
    const coldProbe = start(cold)
    try {
      const coldResult = await measure(cold, coldProbe, () => cold.patch(ID, chat._storageRevision + 3, [
        { op: 'set', path: ['messages', 1, 'variables'], value: [{ stat_data: { hp: 62 } }] },
        { op: 'set', path: ['_storageRevision'], value: chat._storageRevision + 4 },
      ], { source: 'tavern-helper.variables' }))
      assert.equal(coldResult.added, 1, '冷缓存下 messages 路径 patch 走整档路径，assemble 一次（既有代价）')
      assert.deepEqual(coldResult.reasons, ['patch'])
    } finally { coldProbe.stop() }
    // ⑤ captureSend（发送接受关键路径）在同样温热条件下仍零 assemble（第三刀）
    const capture = activeSendCapture(root)
    assert.ok(capture, 'store 必须已注册发送前像写口')
    const send = await measure(store, probe, () => capture(ID, { sessionId: SESSION, type: 'turn/start', turn: 31, seq: 10, events: [] }))
    assert.equal(send.added, 0, '发送接受不得 assemble（第三刀）')
    assert.deepEqual(send.reasons, [])
  } finally { probe.stop() }
})
