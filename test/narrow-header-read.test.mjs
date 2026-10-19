// 第一刀定向叶：窄头部读口（readSlice([]) 去 assemble）。只造合成SQLite档，不连接现场、不调用模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { startAssembleProbe } from '../lib/assemble-probe.js'

const author = new URL('../../../tmp/adapt-65401-pr17/dsh-tavern-65401c0f67465acd3988f65e6c33881c40189dd0/tavern-plugin/lib/domain/', import.meta.url)
const helpers = {
  ...await import(new URL('copy-json-tree.js', author)),
  ...await import(new URL('json-mutation.js', author)),
  ...await import(new URL('chat-session-state.js', author)),
}
const ID = 'chat-narrow-synthetic'
// messages 刻意放在头部键中间：占位键必须留在原 ord 位置，不能被挪到末尾。
const CHAT = {
  id: ID, sessionId: 'session-narrow', _storageRevision: 1, mode: 'story', title: '窄读合成档',
  cardPath: '/card/fixture', updatedAt: 1730000000000, cardName: '合成卡',
  runtimeInputs: { 2: { source: '第二轮输入' } },
  messages: [
    { role: 'user', text: '第一轮输入', turn: 1 },
    { role: 'assistant', text: '第一轮回复', turn: 1, swipeId: 0, swipes: ['第一轮回复'], variables: [{ stat_data: { hp: 3 } }] },
    { role: 'user', text: '第二轮输入', turn: 2 },
    { role: 'assistant', text: '第二轮回复', turn: 2, swipeId: 0, swipes: ['第二轮回复'], variables: [{ stat_data: { hp: 4 } }] },
  ],
  timeline: { schemaVersion: 1, branchId: 'main', revision: 1,
    operations: { 'op-narrow': { kind: 'mvu', status: 'prepared', turn: 2 } },
    checkpoints: [{ turn: 1, payload: '检查点' }], participants: { background: { sessionId: 'session-bg', status: 'active' } } },
  variables: { hp: 4 }, regenRecovery: { phase: 'idle' }, rollbackPending: false,
}

async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-narrow-header-'))
  const stores = []
  const open = () => { const store = createChatSqliteStore({ dataRoot: root, helpers, ...options }); stores.push(store); return store }
  t.after(() => {
    stores.forEach(store => store.dispose())
    const target = path.resolve(root)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('tavern-narrow-header-'))
    rmSync(target, { recursive: true, force: true })
  })
  const initial = open()
  await initial.update(ID, () => structuredClone(CHAT))
  initial.dispose()
  return { root, open, store: open() }
}

test('第一刀：窄头部读口与整档read逐键同构且messages占位留在原ord位置', async t => {
  const { store } = await fixture(t)
  const full = await store.read(ID)
  const narrow = await store.readSlice(ID, [])
  assert.ok(narrow, '空 indices 必须返回窄头部')
  assert.deepEqual(narrow.chat.messages, [], 'messages 必须是空占位数组')
  assert.equal(narrow.messageCount, 4, '楼数必须来自真实楼层行，不是占位长度')
  assert.equal(narrow.denseMessages, true)
  assert.equal(narrow.chat._storageRevision, full._storageRevision)
  assert.equal(narrow.chat.timeline.branchId, 'main')
  assert.equal(narrow.chat.timeline.revision, 1)
  assert.deepEqual(narrow.chat.timeline.operations, { 'op-narrow': { kind: 'mvu', status: 'prepared', turn: 2 } })
  assert.deepEqual(narrow.chat.timeline.participants, { background: { sessionId: 'session-bg', status: 'active' } })
  assert.equal(narrow.chat.runtimeInputs[2].source, '第二轮输入')
  assert.equal(narrow.chat.regenRecovery.phase, 'idle')
  assert.equal(narrow.chat.rollbackPending, false)
  // 键集合与键序都必须与整档一致：缺键会让后续头部写删掉占位行并让 ord 错位。
  assert.deepEqual(Object.keys(narrow.chat), Object.keys(full))
  const index = Object.keys(narrow.chat).indexOf('messages')
  assert.ok(index > 0 && index < Object.keys(narrow.chat).length - 1, 'messages 必须留在原有 ord 位置')
  assert.deepEqual(narrow.chat.timeline, full.timeline)
})

test('第一刀：窄头部读口fields白名单/结算检查点/毒键语义与slice一致', async t => {
  const { store } = await fixture(t)
  const full = await store.read(ID)
  const picked = await store.readSlice(ID, [], ['id', 'sessionId', 'timeline.branchId', 'messages', 'messages.0.text', '__proto__', 'constructor.x', 'prototype'])
  // _storageRevision 与 slice 一致：只在 fields 显式点名时才出现（白名单不含它就不出现）。
  assert.deepEqual(Object.keys(picked.chat).sort(), ['id', 'messages', 'sessionId', 'timeline'].sort())
  assert.equal(picked.chat._storageRevision, undefined)
  assert.deepEqual(picked.chat.timeline, { branchId: 'main' }, '点路径白名单只取指定层级')
  assert.deepEqual(picked.chat.messages, [])
  assert.equal(picked.messageCount, 4)
  assert.equal(picked.denseMessages, true)
  const settlement = await store.readSlice(ID, [], 'settlement')
  assert.deepEqual(settlement.chat.timeline.checkpoints, [], '结算读不复制历史回退检查点')
  assert.deepEqual(settlement.chat.timeline.operations, full.timeline.operations)
  assert.deepEqual(settlement.chat.messages, [])
  const opening = await store.readSlice(ID, [], 'opening')
  assert.deepEqual(opening.chat.timeline, full.timeline, 'opening 语义不跳过 timeline')
})

test('第一刀：窄头部读口不毒化读缓存且楼数与稠密判定诚实', async t => {
  const { root, store } = await fixture(t)
  const narrow = await store.readSlice(ID, [])
  assert.deepEqual(narrow.chat.messages, [])
  // 窄对象绝不进读缓存：紧随的完整 read 必须仍拿到真实楼层。
  const after = await store.read(ID)
  assert.equal(after.messages.length, 4)
  assert.equal(after.messages[1].text, '第一轮回复')
  assert.deepEqual(after.messages[1].variables, [{ stat_data: { hp: 3 } }])
  // 同一 revision 复用稠密判定，不等同于把占位数组登记成 dense。
  assert.equal((await store.readSlice(ID, [])).denseMessages, true)
  // 非对象楼层（数组/null/标量）都算不 dense：直接改行内容，不能碰坏 JSON 触发器。
  const db = new DatabaseSync(path.join(root, 'chats', ID, 'archive.db'))
  try {
    db.prepare('UPDATE archive_messages SET message_json = ? WHERE message_index = 2').run('[1,2]')
    db.prepare('UPDATE archive_messages SET message_json = ? WHERE message_index = 3').run('null')
  } finally { db.close() }
  const corrupt = await store.readSlice(ID, [])
  assert.equal(corrupt.denseMessages, false, '数组与 null 都算不 dense')
  assert.equal(corrupt.messageCount, 4)
  assert.deepEqual(corrupt.chat.messages, [])
  // 坏 JSON 楼层：json_valid 前置保证 json_type 不抛错（触发器会挡住正常写，只能先撤触发器再造）。
  const broken = await fixture(t)
  broken.store.dispose()
  const raw = new DatabaseSync(path.join(broken.root, 'chats', ID, 'archive.db'))
  try {
    raw.exec('DROP TRIGGER archive_display_replace')
    raw.prepare('UPDATE archive_messages SET message_json = ? WHERE message_index = 0').run('{')
  } finally { raw.close() }
  const reopened = broken.open()
  const malformed = await reopened.readSlice(ID, [])
  assert.equal(malformed.denseMessages, false, '坏 JSON 不能算 dense，也不能让头部读口抛错')
  assert.equal(malformed.messageCount, 4)
})

test('第一刀：窄头部读口只对空indices生效，legacy与缺档路径一行不改', async t => {
  const { root, store } = await fixture(t)
  // 非空 indices 仍走全量路径并补真实楼层。
  const one = await store.readSlice(ID, [1])
  assert.equal(one.messageCount, 4)
  assert.equal(one.denseMessages, true)
  assert.equal(one.chat.messages.length, 1)
  assert.equal(one.chat.messages[0].text, '第一轮回复')
  assert.equal(await store.readSlice(ID, [9]), undefined, '越界楼切片仍返回 undefined')
  // legacy 原档：窄读口不适用，仍交回 legacyRead（整档语义不变）。
  const legacyId = 'chat-narrow-legacy'
  writeFileSync(path.join(root, 'chats', legacyId + '.json'), JSON.stringify({ ...structuredClone(CHAT), id: legacyId }), 'utf8')
  const legacy = await store.readSlice(legacyId, [])
  // 空 indices 一律返回空 messages（这是 slice 契约）；legacy 走原路径，头部仍是原档内容。
  assert.equal(legacy.chat.id, legacyId)
  assert.equal(legacy.messageCount, 4, 'legacy 楼数仍来自原档真实楼层')
  assert.equal(legacy.chat.title, '窄读合成档')
  assert.deepEqual(legacy.chat.messages, [])
  // 缺档不伪造。
  assert.equal(await store.readSlice('chat-narrow-absent', []), undefined)
  assert.equal(await store.read('chat-narrow-absent'), undefined)
})

test('第一刀：readSlice空indices入口的assemble归零，完整读与patch仍各自组装', async t => {
  const { store } = await fixture(t)
  const probe = startAssembleProbe(store, { chatId: ID, durationMs: 30_000, maxCalls: 100 })
  try {
    for (let index = 0; index < 5; index++) {
      const selected = await store.readSlice(ID, [])
      assert.equal(selected.chat._storageRevision, index + 1)
      const saved = await store.patch(ID, index + 1, [
        { op: 'set', path: ['title'], value: '保存-' + index },
        { op: 'set', path: ['_storageRevision'], value: index + 2 },
      ])
      assert.equal(saved.title, '保存-' + index)
      assert.deepEqual(saved.messages, [], 'patch 仍返回头部加空 messages，不是完整档')
    }
    // 5 次窄读 + 5 次头部-only patch：两者都不 assemble（第一刀窄读 + 第二刀 patch 快路径）。
    // 本叶原按“patch 首次仍需完整态”断言 calls===1——那是第二刀之前的旧事实；
    // 第二刀把头部-only 写改走窄读口后该基线即已过期，本次按现状修正，不是第三刀的回归。
    assert.equal(probe.snapshot().calls, 0)
    assert.deepEqual(Object.keys(probe.snapshot().byReason), [])
    assert.equal(probe.snapshot().messageRows, 0)
    const chat = await store.read(ID)
    assert.equal(chat._storageRevision, 6)
    assert.equal(chat.messages.length, 4)
    assert.equal(chat.title, '保存-4')
  } finally { probe.stop() }
})

// 楼数权威来源（第三刀遗留项的核实结论）：窄路径的楼数来自 narrowHeaderRows 的 COUNT(*)，
// 整档路径来自 assembleRows 的 messages.length（new Array(rows.length) 后按下标赋值，JS 会自动
// 扩展 length）。曾据"同源"推断窄化会丢掉交叉验证——实测证伪：两种来源对全部可构造的
// 楼表异常形态判定完全一致，第三刀没有削弱消息表写后自检。
test('楼数来源：窄路径 COUNT 与整档 assemble 长度在各种楼表形态下自检判定等价', async t => {
  const { root, store } = await fixture(t)
  const dbPath = path.join(root, 'chats', ID, 'archive.db')
  const withDb = read => { const db = new DatabaseSync(dbPath); try { return read(db) } finally { db.close() } }
  const setFloors = indices => withDb(db => {
    db.exec('DELETE FROM archive_messages')
    const put = db.prepare('INSERT INTO archive_messages VALUES (?,?)')
    for (const index of indices) put.run(index, JSON.stringify({ role: 'assistant', turn: index, text: '第' + index + '楼' }))
  })
  const revision = () => withDb(db => Number(db.prepare('SELECT revision FROM archive_head WHERE id=1').get().revision))
  // 整档路径（update）先被 assertCompleteMessages 拦（messages 带洞 ⇒ 更早的防线）；
  // 头部-only 路径（patch 快路径）不读 messages，只能靠写后自检。两条路径都必须在坏形态上失败。
  for (const [label, indices, shouldReject] of [
    ['正常 [0,1,2,3]', [0, 1, 2, 3], false],
    ['缺 1 楼 [0,2,3]', [0, 2, 3], true],
    ['缺 0 楼 [1,2,3]', [1, 2, 3], true],
    ['跳号 [0,1,5]', [0, 1, 5], true],
    ['空表 []', [], false],
    ['单楼 [0]', [0], false],
  ]) {
    setFloors(indices)
    const before = revision()
    let headOnlyError = null
    try {
      await store.patch(ID, before, [
        { op: 'set', path: ['title'], value: '形态-' + label },
        { op: 'set', path: ['_storageRevision'], value: before + 1 }])
    } catch (error) { headOnlyError = error }
    let fullError = null
    try {
      await store.update(ID, chat => { chat.title = '整档-' + label; chat._storageRevision = chat._storageRevision + 1; return chat })
    } catch (error) { fullError = error }
    if (shouldReject) {
      assert.ok(headOnlyError, label + '：头部-only 写必须被自检拒绝（楼数来源不掩盖空洞）')
      assert.match(String(headOnlyError?.message || ''), /自检失败/, label + '：拒绝原因必须是写后自检')
      assert.ok(fullError, label + '：整档写必须被拒绝')
      assert.equal(revision(), before, label + '：两条路径失败都必须零写')
    } else {
      assert.equal(headOnlyError, null, label + '：正常形态头部-only 写必须放行')
      assert.equal(fullError, null, label + '：正常形态整档写必须放行')
      assert.equal(revision(), before + 2, label + '：两条路径成功各推进一次 revision')
    }
  }
})
