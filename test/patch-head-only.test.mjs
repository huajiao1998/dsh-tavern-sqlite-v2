// 第二刀定向叶：patch 头部-only 快路径。只造合成SQLite档，不连接现场、不调用模型。
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
const ID = 'chat-headonly-synthetic'
// messages 放在头部键中间：占位键必须留在原 ord 位置，不能被挪到末尾。
const CHAT = {
  id: ID, sessionId: 'session-headonly', _storageRevision: 1, mode: 'story', title: '原标题',
  cardPath: '/card/fixture', cardName: '合成卡', updatedAt: 1730000000000,
  runtimeInputs: { 2: { source: '第二轮输入' } },
  messages: [
    { role: 'user', text: '第一轮输入', turn: 1 },
    { role: 'assistant', text: '第一轮回复', turn: 1, swipeId: 0, swipes: ['第一轮回复'], variables: [{ stat_data: { hp: 3 } }] },
    { role: 'user', text: '第二轮输入', turn: 2 },
    { role: 'assistant', text: '第二轮回复', turn: 2, swipeId: 0, swipes: ['第二轮回复'], variables: [{ stat_data: { hp: 4 } }] },
  ],
  timeline: { schemaVersion: 1, branchId: 'main', revision: 1,
    operations: { 'op-body': { kind: 'body', status: 'foreground-completed', turn: 2,
      businessBefore: { version: 1, fields: { variables: { hp: 3 } }, messageCount: 2, participants: {}, operationIds: [], operationStates: {}, operationPreimages: {} } } },
    checkpoints: [{ turn: 2, businessBefore: { version: 1, fields: { variables: { hp: 3 } }, messageCount: 2, participants: {}, operationIds: [], operationStates: {}, operationPreimages: {} } }],
    participants: { background: { sessionId: 'session-bg', status: 'active' } } },
  variables: { hp: 4 }, regenRecovery: { phase: 'idle' }, rollbackPending: false,
}
const NOW = 1730000000000
async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-headonly-'))
  const stores = []
  const open = () => { const store = createChatSqliteStore({ dataRoot: root, helpers, now: () => NOW }); stores.push(store); return store }
  t.after(() => {
    stores.forEach(store => store.dispose())
    const target = path.resolve(root)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('tavern-headonly-'))
    rmSync(target, { recursive: true, force: true })
  })
  const initial = open()
  await initial.update(ID, () => structuredClone(CHAT))
  initial.dispose()
  return { root, open, store: open() }
}
/** 两份库的结构快照：头部键序+值、楼层行、timeline 子行。刻意不含 archive_head（updated_at 时序无关）。 */
function structure(root, id = ID) {
  const db = new DatabaseSync(path.join(root, 'chats', id, 'archive.db'))
  try {
    return {
      fields: db.prepare('SELECT key, ord, kind, value_json FROM archive_head_fields ORDER BY ord').all(),
      messages: db.prepare('SELECT message_index, message_json FROM archive_messages ORDER BY message_index').all(),
      timeline: db.prepare('SELECT node_key, ord, value_json FROM archive_timeline_nodes ORDER BY node_key, ord').all(),
    }
  } finally { db.close() }
}
const ordPairs = snapshot => snapshot.fields.map(row => [row.key, row.ord])

test('第二刀：头部-only 与整档路径产出的库结构逐行一致，messages占位与ord不变', async t => {
  const fast = await fixture(t)
  const before = structure(fast.root)
  const headChanges = [
    { op: 'set', path: ['title'], value: '只改标题' },
    { op: 'set', path: ['_storageRevision'], value: 2 },
    { op: 'set', path: ['runtimeInputs', '2', 'source'], value: '新输入' },
    { op: 'delete', path: ['cardName'] },
  ]
  const saved = await fast.store.patch(ID, 1, headChanges, { source: 'tavern.header' })
  assert.equal(saved.title, '只改标题')
  assert.equal(saved._storageRevision, 2)
  assert.deepEqual(saved.messages, [], '返回仍是完整头部加空 messages，不是完整档')
  assert.equal(saved.cardName, undefined, '被删键不得出现在返回里')
  const afterFast = structure(fast.root)
  // 同一组头部改动走整档 update 作对照：库结构必须逐行一致（证明快路径没有少写/错写）。
  const slow = await fixture(t)
  await slow.store.update(ID, chat => {
    chat.title = '只改标题'
    chat._storageRevision = 2
    chat.runtimeInputs[2].source = '新输入'
    delete chat.cardName
    return chat
  })
  const afterSlow = structure(slow.root)
  assert.deepEqual(afterFast.fields, afterSlow.fields, '头部键序+值必须逐行一致')
  assert.deepEqual(afterFast.messages, afterSlow.messages, '楼层行必须一行未动')
  assert.deepEqual(afterFast.timeline, afterSlow.timeline, 'timeline 子行必须一致')
  const messagesRow = afterFast.fields.find(row => row.key === 'messages')
  assert.equal(messagesRow.kind, 1, 'messages 必须是 kind=1 占位行')
  assert.equal(messagesRow.value_json, null)
  // 只增删头部键会按 Object.keys 重排 ord（两条路径同样如此，已由上面的逐行一致证明）；
  // 纯 set 改动则必须让 (key, ord) 集合一字不动——这正是 LLM 前缀缓存依赖的属性序。
  const setsOnly = await fixture(t)
  const beforeSets = structure(setsOnly.root)
  await setsOnly.store.patch(ID, 1, [
    { op: 'set', path: ['title'], value: '只改标题' },
    { op: 'set', path: ['_storageRevision'], value: 2 },
  ])
  const afterSets = structure(setsOnly.root)
  assert.deepEqual(ordPairs(afterSets), ordPairs(beforeSets), '纯 set 的头部-only 写不得改动任何 (key, ord)')
  assert.ok(ordPairs(afterSets).some(([key]) => key === 'messages'), 'messages 占位行必须仍在')
  // 只有被改的两个键的值变了，其余头部行（含 messages/timeline 占位）原样不动。
  const changedKeys = afterSets.fields
    .filter((row, index) => row.value_json !== beforeSets.fields[index].value_json)
    .map(row => row.key).sort()
  assert.deepEqual(changedKeys, ['_storageRevision', 'title'], '不得顺带改写其它头部行')
})

test('第二刀：快路径不整档assemble，且不把整档放回读缓存', async t => {
  const { store } = await fixture(t)
  const probe = startAssembleProbe(store, { chatId: ID, durationMs: 30_000, maxCalls: 100 })
  try {
    for (let index = 0; index < 5; index++) {
      const saved = await store.patch(ID, index + 1, [
        { op: 'set', path: ['title'], value: '保存-' + index },
        { op: 'set', path: ['_storageRevision'], value: index + 2 },
      ])
      assert.equal(saved.title, '保存-' + index)
      assert.deepEqual(saved.messages, [])
    }
    assert.equal(probe.snapshot().calls, 0, '头部-only 写不得 assemble')
    assert.equal(probe.snapshot().byReason.patch, undefined)
    // 不毒化读缓存：紧跟的完整 read 仍拿到真实完整楼层。
    const chat = await store.read(ID)
    assert.equal(chat._storageRevision, 6)
    assert.equal(chat.messages.length, 4)
    assert.equal(chat.messages[1].text, '第一轮回复')
    assert.deepEqual(chat.messages[1].variables, [{ stat_data: { hp: 3 } }])
    assert.equal(chat.title, '保存-4')
  } finally { probe.stop() }
})

test('第二刀：timeline子行与回退前像同事务落库，护栏与CAS一字不减', async t => {
  const { root, store } = await fixture(t)
  const before = structure(root)
  const saved = await store.patch(ID, 1, [
    { op: 'set', path: ['title'], value: '带前像' },
    { op: 'set', path: ['_storageRevision'], value: 2 },
  ], { source: 'settlement.complete', rollbackOwner: { chatId: ID, sessionId: 'session-headonly', branchId: 'main', operationId: 'op-body', turn: 2 } })
  assert.equal(saved.title, '带前像')
  const after = structure(root)
  assert.notDeepEqual(after.timeline, before.timeline, 'timeline 子行必须被改写')
  assert.equal(after.fields.find(row => row.key === 'timeline').value_json, null, 'timeline 仍是子行占位')
  // 回退前像累计写进同一 body 节点（recordRollbackBusinessWrites 保留调用）。
  // 注意：operations:<id> 行的 value_json 就是 operation 对象本身，不是 map。
  const body = JSON.parse(after.timeline.find(row => row.node_key === 'operations:op-body').value_json)
  assert.equal(body.businessBefore.version, 1)
  assert.deepEqual(body.businessBefore.fields, { variables: { hp: 3 } })
  assert.equal(body.businessBefore.messageCount, 2, '前像楼数仍来自首次 capture，未被占位数组改写')
  // CAS：revision 不连续必须回 undefined 且零写。
  const frozen = structure(root)
  assert.equal(await store.patch(ID, 99, [{ op: 'set', path: ['title'], value: '不该落库' }, { op: 'set', path: ['_storageRevision'], value: 100 }]), undefined)
  assert.deepEqual(structure(root), frozen, 'CAS 拒绝后库结构一行不变')
  // assertCurrent 失败必须响亮抛出且零写。
  await assert.rejects(() => store.patch(ID, 2, [{ op: 'set', path: ['title'], value: 'x' }, { op: 'set', path: ['_storageRevision'], value: 3 }], { assertCurrent: () => { throw new Error('identity-changed') } }), /identity-changed/)
  assert.deepEqual(structure(root), frozen, 'assertCurrent 失败后库结构一行不变')
  // 楼层越界护栏在整档路径同样生效（写集判定不含 messages ⇒ 走整档路径 ⇒ 同一份归一化校验）。
  await assert.rejects(() => store.patch(ID, 2, [{ op: 'set', path: ['messages', 9], value: { role: 'user', text: 'x' } }]), /楼层/)
  assert.deepEqual(structure(root), frozen, '越界被拒后库结构一行不变')
  // 空洞楼（path 长度 2 但值不是合法消息）由 assertPatchMessages 拒绝。
  await assert.rejects(() => store.patch(ID, 2, [{ op: 'set', path: ['messages', 1], value: '不是对象' }]), /空洞|messages/)
})

test('第二刀：非头部-only 写集一行不改，仍走整档路径', async t => {
  const { store } = await fixture(t)
  // 空 changes：保持原 no-op 语义。
  const noop = await store.patch(ID, 1, [])
  assert.equal(noop._storageRevision, 1)
  assert.deepEqual(noop.messages, [])
  assert.equal((await store.readRevision(ID, 1))._storageRevision, 1)
  // 根级改动（path.length === 0）不是头部-only：必须走整档路径，
  // 因此 assertPatchMessages 会要求 value 带完整普通 messages 数组（快路径根本不会做这项校验）。
  const root = structuredClone(CHAT)
  root.title = '根级替换'
  root._storageRevision = 2
  const replaced = await store.patch(ID, 1, [{ op: 'set', path: [], value: root }])
  assert.equal(replaced.title, '根级替换')
  assert.equal(replaced._storageRevision, 2)
  assert.equal((await store.read(ID)).messages.length, 4, '根级替换走整档路径，楼层必须原样保留')
  assert.equal((await store.read(ID)).messages[3].text, '第二轮回复')
  // 整组 messages 替换（path = ['messages']）不是头部-only：走整档路径并真正重写楼层。
  const whole = (await store.read(ID)).messages
  whole[1] = { ...whole[1], text: '整组替换' }
  const swapped = await store.patch(ID, 2, [
    { op: 'set', path: ['_storageRevision'], value: 3 },
    { op: 'set', path: ['messages'], value: whole },
  ])
  assert.equal(swapped._storageRevision, 3)
  assert.equal((await store.read(ID)).messages[1].text, '整组替换')
  assert.equal((await store.read(ID)).messages.length, 4)
  // 单楼改动同样走整档路径。
  const saved = await store.patch(ID, 3, [
    { op: 'set', path: ['_storageRevision'], value: 4 },
    { op: 'set', path: ['messages', 2, 'text'], value: '改过的输入' },
  ])
  assert.equal(saved._storageRevision, 4)
  assert.equal((await store.read(ID)).messages[2].text, '改过的输入')
  // 增量证据在整档写之后仍可建立（快路径只失效，不伪造证据）。
  assert.deepEqual((await store.readChangedIndices(ID, 3)).indices, [2])
})

test('第二刀：legacy与缺档不进入快路径，denseMessages判定不被占位数组带偏', async t => {
  const { root, store } = await fixture(t)
  // legacy 原档：快路径前置不成立，仍交回 legacyRead（原档只读语义不变）。
  const legacyId = 'chat-headonly-legacy'
  writeFileSync(path.join(root, 'chats', legacyId + '.json'), JSON.stringify({ ...structuredClone(CHAT), id: legacyId }), 'utf8')
  await assert.rejects(() => store.patch(legacyId, 1, [{ op: 'set', path: ['title'], value: 'x' }, { op: 'set', path: ['_storageRevision'], value: 2 }]), /原档只读/)
  assert.equal((await store.read(legacyId)).title, '原标题', 'legacy 档不得被快路径改动')
  // 缺档：回 undefined，不建库。
  assert.equal(await store.patch('chat-headonly-absent', 1, [{ op: 'set', path: ['title'], value: 'x' }]), undefined)
  // 头部-only 写之后，稠密判定仍按真实楼层（含"不 dense"的负例）。
  assert.equal((await store.readSlice(ID, [1])).denseMessages, true)
  await store.patch(ID, 1, [{ op: 'set', path: ['title'], value: '再改' }, { op: 'set', path: ['_storageRevision'], value: 2 }])
  assert.equal((await store.readSlice(ID, [1])).denseMessages, true, '快路径写后 denseMessages 仍为真')
  assert.equal((await store.readSlice(ID, [])).denseMessages, true)
  const db = new DatabaseSync(path.join(root, 'chats', ID, 'archive.db'))
  try { db.prepare('UPDATE archive_messages SET message_json = ? WHERE message_index = 3').run('[1,2]') } finally { db.close() }
  assert.equal((await store.readSlice(ID, [1])).denseMessages, false, '出现非对象楼后必须判不 dense')
  assert.equal((await store.readSlice(ID, [])).denseMessages, false)
})
