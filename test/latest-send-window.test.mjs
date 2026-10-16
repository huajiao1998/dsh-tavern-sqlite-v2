// 窄窗口真实摘要 × latestSendTarget（独占新文件，2 叶）——**先写叶，门禁等主通知 cp fallback 落地**。
// 用真实 SQL chat store + 真实 readOpeningWindow/readActivitySummary + 真实（raw）queryFailureCleanup：
//   queryFailureCleanup 已不筛操作状态（lib/chat-query-service.js:57），最新 body 被账本裁剪时由同轮 checkpoint 接手
//   （:60-67，此时不带 operationId）；同轮 checkpoint 不再被拒。
// 夹具沿 test/send-acceptance.test.mjs 的真实 store + 临时 DSH_HOME/profile 清单 + 自建 sessions.json（无真实数据）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { queryFailureCleanup } from '../lib/chat-query-service.js'
import { latestSendTarget } from '../lib/latest-send.js'
import { invalidateLinkMap } from '../lib/tavern-chat-state.js'

const HOME_BEFORE = process.env.DSH_HOME
const baseline = (messageCount, hp) => ({ version: 1, messageCount, fields: { variables: { hp } }, participants: {} })

function helpers() {
  const api = { copyJsonTree: value => value === undefined ? undefined : structuredClone(value), applyJsonChangesShared: value => value }
  for (const key of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) api[key] = value => value
  api.diffJson = (old, next) => {
    const changes = []
    for (const key of new Set([...Object.keys(old), ...Object.keys(next)])) if (key !== 'messages' && JSON.stringify(old[key]) !== JSON.stringify(next[key])) changes.push({ op: 'set', path: [key], value: next[key] })
    if (next.messages.length < old.messages.length) changes.push({ op: 'splice', path: ['messages'], index: next.messages.length, deleteCount: old.messages.length - next.messages.length, items: [] })
    else for (let i = 0; i < next.messages.length; i += 1) if (JSON.stringify(old.messages[i]) !== JSON.stringify(next.messages[i])) changes.push({ op: 'set', path: ['messages', i], value: next.messages[i] })
    return changes
  }
  return api
}

// 真实 store + 真实窄窗口/摘要读取 + raw queryFailureCleanup（在同一个 archive 库上按 store 的调用序复算）。
async function fixture(chat) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-latest-window-'))
  const home = path.join(root, 'dsh-home'), dataRoot = path.join(root, 'tavern-data')
  mkdirSync(path.join(home, 'profiles', 'tavern'), { recursive: true })
  writeFileSync(path.join(home, 'profiles', 'tavern', 'package.json'), JSON.stringify({ dshTavern: { dataRoot } }), 'utf8')
  mkdirSync(dataRoot, { recursive: true })
  writeFileSync(path.join(dataRoot, 'sessions.json'), JSON.stringify({ [chat.sessionId]: chat.id }), 'utf8')
  process.env.DSH_HOME = home
  invalidateLinkMap()
  const store = createChatSqliteStore({ dataRoot, helpers: helpers() })
  await store.update(chat.id, () => chat)
  const rawSummary = () => {
    const db = new DatabaseSync(store.rollbackArchivePath(chat.id))
    try {
      const summary = store.readActivitySummary({ chatId: chat.id, sessionId: chat.sessionId })   // 真实摘要（含 revision/timeline）
      return { summary, failureCleanup: queryFailureCleanup(db, { revision: summary.revision, timeline: summary.timeline }) }
    } finally { db.close() }
  }
  // 真部分窗：夹具正文不足 limit 时 from===0，必须显式 requirePartial:false（否则 store :1498 直接 null）。
  const windowOf = (options = {}) => store.readOpeningWindow(chat.id, { sessionId: chat.sessionId, requirePartial: false, ...options })
  const cleanup = async () => {
    store.dispose()
    if (HOME_BEFORE === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = HOME_BEFORE
    invalidateLinkMap()
    rmSync(root, { recursive: true, force: true })
  }
  return { store, rawSummary, windowOf, cleanup }
}
// 与 session-window-projector 同法：把窄摘要以**非枚举**字段挂到 chat 上（视图接缝的 narrow 路径正是读它）。
function withNarrow(chat, failureCleanup) {
  Object.defineProperty(chat, 'failureCleanup', { value: failureCleanup, enumerable: false, configurable: true, writable: true })
  return chat
}
const eventsOf = (...turns) => turns.flatMap((turn, index) => [
  { seq: index * 3, type: 'turn/start', data: { turn } },
  { seq: index * 3 + 1, type: 'user/message', data: { id: 'u' + turn, role: 'user', content: [], source: { kind: 'user' } } },
])

test('窄窗口真实摘要：completed body+checkpoint 的 latest 轮 cleanable true 且 latestSendTarget 有 op 签成功', async () => {
  const chat = {
    id: 'chat-latest-window', sessionId: 'session-latest-window', _storageRevision: 1, mode: 'story',
    backgroundConfigVersion: 1, conversationFeaturesVersion: 1,   // store:1500 窗口资格（否则 not-applicable: unsupported-mode）
    messages: [{ role: 'user', text: '第五条输入' }, { role: 'assistant', turn: 5, text: '第五轮正文', swipeId: 0, swipes: ['第五轮正文'], variables: [{ hp: 5 }] }],
    variables: { hp: 5 },
    timeline: {
      schemaVersion: 1, branchId: 'branch-window', revision: 5, participants: {},
      operations: { body5: { kind: 'body', role: 'body', status: 'completed', turn: 5, userText: '第五条输入', businessBefore: baseline(2, 5), nativeAnchor: { turn: 5, input: 2, reply: 3 } } },
      checkpoints: [{ id: 'cp5', turn: 5, userText: '第五条输入', businessBefore: baseline(2, 5) }],
    },
  }
  const f = await fixture(chat)
  try {
    const { summary, failureCleanup } = f.rawSummary()
    assert.ok(Number.isSafeInteger(Number(summary.revision)), '真实摘要必须带 revision（raw queryFailureCleanup 的入参）')
    assert.equal(failureCleanup.cleanable, true, 'completed body + 同轮 checkpoint：窄摘要必须 cleanable（不再按状态白名单）')
    assert.equal(failureCleanup.turn, 5)
    assert.equal(failureCleanup.operationId, 'body5', 'body 与 cp 同轮时必须保留 op 身份')
    // 真实窗口（requirePartial:false，正文不足 limit 时 from===0 不再被 :1498 拒）：
    const win = await f.windowOf()
    assert.equal(win.nativeData, true, '真实窗口必须带 nativeData:true（非 not-applicable：' + JSON.stringify(win && (win.reason || win.kind) || '') + '）')
    assert.equal(win.failureCleanup?.cleanable, true, '窗口必须带回同一摘要（store:1514 → 投影传输）')
    assert.equal(win.failureCleanup.turn, 5)
    assert.equal(win.failureCleanup.operationId, 'body5', 'body 与 cp 同轮时窗口摘要必须保留 op 身份')
    const full = await f.store.read(chat.id)
    // 投影侧真函数同法（session-window-projector.js:270-271）：用**窗口自带**摘要非枚举挂到窗口 chat 上（非 raw query）。
    const narrow = structuredClone(win.chat)
    Object.defineProperty(narrow, 'failureCleanup', { value: win.failureCleanup, enumerable: false, configurable: true, writable: true })
    const narrowTarget = latestSendTarget(narrow, { events: [] }, win.revision)
    assert.equal(narrowTarget?.kind, 'rollback', '窄窗口路径必须签出统一目标')
    assert.equal(narrowTarget.turn, 5)
    assert.equal(narrowTarget.operationId, 'body5', '窄窗口签必须带 op 身份')
    const fullTarget = latestSendTarget(structuredClone(full), { events: eventsOf(5) }, full._storageRevision)
    assert.equal(fullTarget.turn, narrowTarget.turn, '窄/完整轮号必须一致')
    assert.equal(fullTarget.operationId, narrowTarget.operationId, '窄/完整 op 必须一致')
  } finally { await f.cleanup() }
})

test('窄窗口真实摘要：cp-only 最新轮签 kind rollback 无 operationId；最新原生无基准不签也不选旧轮', async () => {
  const chat = {
    id: 'chat-latest-cp', sessionId: 'session-latest-cp', _storageRevision: 1, mode: 'story',
    backgroundConfigVersion: 1, conversationFeaturesVersion: 1,   // store:1500 窗口资格（否则 not-applicable: unsupported-mode）
    messages: [{ role: 'user', text: '第五条输入' }, { role: 'assistant', turn: 5, text: '第五轮正文', swipeId: 0, swipes: ['第五轮正文'], variables: [{ hp: 5 }] }],
    variables: { hp: 5 },
    timeline: {
      schemaVersion: 1, branchId: 'branch-cp', revision: 6, participants: {},
      operations: { body5: { kind: 'body', role: 'body', status: 'completed', turn: 5, userText: '第五条输入', businessBefore: baseline(2, 5) } },
      // 最新轮 6 的 body 已被账本裁剪 ⇒ 只有 checkpoint 带基准（cp-only 路径）。
      checkpoints: [{ id: 'cp5', turn: 5, businessBefore: baseline(2, 5) }, { id: 'cp6', turn: 6, businessBefore: baseline(4, 6) }],
    },
  }
  const f = await fixture(chat)
  try {
    const win = await f.windowOf()
    assert.equal(win.nativeData, true, '真实窗口必须带 nativeData:true（非 not-applicable：' + JSON.stringify(win && (win.reason || win.kind) || '') + '）')
    assert.equal(win.failureCleanup?.turn, 6, 'cp-only 时窗口摘要必须由更大 turn 的 checkpoint 接手')
    assert.equal(win.failureCleanup.cleanable, true)
    assert.equal(win.failureCleanup.operationId, undefined, 'cp-only 窗口摘要不得带 op 身份')
    const full = await f.store.read(chat.id)
    const narrow = structuredClone(win.chat)
    Object.defineProperty(narrow, 'failureCleanup', { value: win.failureCleanup, enumerable: false, configurable: true, writable: true })
    const target = latestSendTarget(narrow, { events: [] }, win.revision)
    assert.equal(target?.kind, 'rollback', 'cp-only 最新轮必须能签出 kind rollback')
    assert.equal(target.turn, 6)
    assert.equal(target.operationId, undefined, 'cp-only 目标不得虚构 op 身份')
    // 最新原生轮（7）没有基准：必须阻签，且不得回落到更早的 6/5。
    const drifted = withNarrow(structuredClone(full), win.failureCleanup)
    assert.equal(latestSendTarget(drifted, { events: eventsOf(5, 7) }, drifted._storageRevision).turn, 7, '最新原生无前像仍可回退，不选旧轮')
  } finally { await f.cleanup() }
})
