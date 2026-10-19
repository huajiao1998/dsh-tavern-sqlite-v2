// 第0刀定向叶：真实SQLite与固定作者helper；只造合成档，不连接现场或调用模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { startAssembleProbe } from '../lib/assemble-probe.js'
import { activeSendCapture } from '../lib/send-acceptance.js'

const author = new URL('../../../tmp/adapt-65401-pr17/dsh-tavern-65401c0f67465acd3988f65e6c33881c40189dd0/tavern-plugin/lib/domain/', import.meta.url)
const helpers = {
  ...await import(new URL('copy-json-tree.js', author)),
  ...await import(new URL('json-mutation.js', author)),
  ...await import(new URL('chat-session-state.js', author)),
}
const ID = 'chat-probe-synthetic'
async function fixture(t, options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'tavern-assemble-probe-'))
  const stores = []
  const open = () => {
    const store = createChatSqliteStore({ dataRoot: root, helpers, ...options })
    stores.push(store)
    return store
  }
  t.after(() => {
    stores.forEach(store => store.dispose())
    const target = path.resolve(root)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('tavern-assemble-probe-'))
    rmSync(target, { recursive: true, force: true })
  })
  const initial = open()
  await initial.update(ID, () => ({ id: ID, sessionId: 'session-probe', _storageRevision: 1,
    mode: 'story', title: '合成档', variables: { hp: 3 },
    messages: [{ role: 'user', text: '合成输入' }, { role: 'assistant', text: '合成正文', turn: 1 }],
    timeline: { schemaVersion: 1, branchId: 'main', revision: 1, operations: {}, checkpoints: [], participants: {} },
  }))
  initial.dispose()
  return { root, open, store: open() }
}
const start = (store, extra = {}) => startAssembleProbe(store, { chatId: ID, durationMs: 30_000, maxCalls: 100, ...extra })

test('第0刀：默认关闭、对象隔离、脱离快照及窗口生命周期', async t => {
  const f = await fixture(t, { cacheMaxBytes: 0 })
  const keys = Object.keys(f.store)
  await f.store.read(ID) // 默认关闭，不回溯计入后来开启的窗口。
  assert.throws(() => startAssembleProbe(f.store), /chatId/)
  assert.throws(() => start(f.store, { durationMs: 300_001 }), /durationMs/)
  assert.throws(() => start(f.store, { maxCalls: 0 }), /maxCalls/)
  const probe = start(f.store)
  assert.equal(probe.snapshot().calls, 0)
  assert.throws(() => start(f.store), /尚未停止/)
  const other = f.open()
  await other.read(ID)
  await f.store.read('chat-other-missing')
  assert.equal(probe.snapshot().calls, 0, '其他实例和其他档不纳入目标窗口')
  await f.store.read(ID)
  const snapshot = probe.snapshot()
  assert.equal(snapshot.calls, 1)
  assert.equal(snapshot.messageRows, 2)
  snapshot.byReason.read.calls = 999
  assert.equal(probe.snapshot().byReason.read.calls, 1)
  assert.equal(JSON.stringify(snapshot).includes('合成正文'), false)
  assert.equal(JSON.stringify(snapshot).includes(ID), false)
  const stopped = probe.stop()
  await f.store.read(ID)
  assert.deepEqual(probe.snapshot(), stopped)
  assert.equal(stopped.stopReason, 'manual')
  assert.deepEqual(Object.keys(f.store), keys)
  const limited = start(f.store, { maxCalls: 1 })
  await f.store.read(ID)
  await f.store.read(ID)
  assert.equal(limited.snapshot().calls, 1)
  assert.equal(limited.snapshot().completed, 1)
  assert.equal(limited.snapshot().stopReason, 'maxCalls')
  const expired = start(f.store, { durationMs: 1 })
  await delay(15)
  await f.store.read(ID)
  assert.equal(expired.snapshot().calls, 0)
  assert.equal(expired.snapshot().stopReason, 'expired')
  const disposed = start(f.store)
  f.store.dispose()
  assert.equal(disposed.snapshot().stopReason, 'disposed')
  assert.throws(() => start(f.store), /dispose/)
})

test('第0刀：冷读后五次头部保存只首次组装、热缓存不重复记账', async t => {
  const { store } = await fixture(t)
  const probe = start(store)
  for (let index = 0; index < 5; index++) {
    const selected = await store.readSlice(ID, [])
    const revision = selected.chat._storageRevision
    const saved = await store.patch(ID, revision, [
      { op: 'set', path: ['title'], value: '保存-' + index },
      { op: 'set', path: ['_storageRevision'], value: revision + 1 },
    ])
    assert.equal(saved.title, '保存-' + index)
    assert.deepEqual(saved.messages, [], '既有patch返回头部加空messages，并不是完整档')
  }
  const snap = probe.stop()
  // 第二刀后：readSlice([]) 走窄读口、头部-only patch 走快路径，两者都不 assemble。
  assert.equal(snap.calls, 0)
  assert.equal(snap.completed, 0)
  assert.equal(snap.messageRows, 0)
  assert.equal(snap.headFields, 0)
  assert.deepEqual(Object.keys(snap.byReason), [])
  const chat = await store.read(ID)
  assert.equal(chat._storageRevision, 6)
  assert.equal(chat.messages.length, 2)
  assert.equal(chat.messages[1].text, '合成正文')
  t.diagnostic('合成读写序列：第二刀后 5 次头部保存合计 assemble=0（readSlice窄读＋patch快路径都不组装）')
})

test('第0刀：禁用缓存后读写分别归因、共享加载只计发起者', async t => {
  const { store } = await fixture(t, { cacheMaxBytes: 0 })
  const probe = start(store)
  for (let index = 0; index < 5; index++) {
    const selected = await store.readSlice(ID, [])
    const revision = selected.chat._storageRevision
    await store.patch(ID, revision, [{ op: 'set', path: ['_storageRevision'], value: revision + 1 }])
  }
  // 第二刀后：头部-only 写在缓存开/关下都不 assemble（快路径本就不经过读缓存）。
  assert.equal(probe.snapshot().calls, 0)
  assert.deepEqual(Object.keys(probe.snapshot().byReason), [])
  probe.stop()
  const shared = start(store)
  const [chat, sliced] = await Promise.all([store.read(ID), store.readSlice(ID, [])])
  assert.equal(chat._storageRevision, sliced.chat._storageRevision)
  assert.equal(shared.snapshot().calls, 1)
  assert.equal(shared.snapshot().byReason.read.calls, 1)
  t.diagnostic('合成读写序列：第二刀后头部-only写零assemble；完整读仍各自组装，并发共享加载只计1次')
})

test('第0刀：readRevision归因、空库与解析异常保留原语义', async t => {
  const f = await fixture(t)
  const probe = start(f.store)
  const before = await f.store.readRevision(ID, 1)
  assert.equal(before.messages.length, 2)
  await assert.rejects(f.store.readRevision(ID, 99), { code: 'DSH_TAVERN_REVISION_NOT_FOUND' })
  assert.equal(probe.snapshot().byReason.readRevision.completed, 2, '组装成功不等于外围revision校验成功')
  const db = new DatabaseSync(path.join(f.root, 'chats', ID, 'archive.db'))
  try {
    // 楼层更新触发器会解析JSON并提前拒绝坏值；改在头字段上造assemble解析失败。
    db.prepare("UPDATE archive_head_fields SET value_json=? WHERE key='title'").run('{')
    await assert.rejects(f.store.readRevision(ID, 1), SyntaxError)
    assert.equal(probe.snapshot().failed, 1)
    assert.equal(probe.snapshot().messageRows, 6, '读取行数不是成功解析行数')
    db.exec('DELETE FROM archive_head')
    await assert.rejects(f.store.readRevision(ID, 1), { code: 'DSH_TAVERN_REVISION_NOT_FOUND' })
    assert.equal(probe.snapshot().empty, 1)
    assert.equal(probe.snapshot().calls, 4)
  } finally { db.close() }
})

// 第三刀后：captureSend 主路径与补偿闭包都改走窄头部读口 + 头部-only 写，两处 assemble 归零。
// 本叶原按"分开计数"断言（captureSend=2 / captureSend.compensate=2 / messageRows=8），
// 现按新事实改为"两处均零 assemble"，CAS 拒绝、前像恢复与 messageCount 断言一字未减。
test('第0刀：发送前像与补偿去整档 assemble 且保留CAS拒绝', async t => {
  const f = await fixture(t)
  const probe = start(f.store)
  const capture = activeSendCapture(f.root)
  const input = { sessionId: 'session-probe', type: 'turn/start', turn: 2, seq: 10, events: [] }
  const compensate = capture(ID, input)
  const saved = await f.store.read(ID)
  assert.equal(Object.values(saved.timeline.operations)[0].businessBefore.messageCount, 2)
  compensate()
  const restored = await f.store.read(ID)
  assert.deepEqual(restored.timeline.operations, {})
  assert.equal(restored._storageRevision, 3)
  const stale = capture(ID, input)
  await f.store.update(ID, chat => ({ ...chat, title: '后续提交', _storageRevision: chat._storageRevision + 1 }))
  assert.throws(stale, /版本已变化/)
  assert.equal((await f.store.read(ID)).title, '后续提交')
  const snap = probe.stop()
  assert.equal(snap.byReason.captureSend, undefined, '第三刀：captureSend 不得再 assemble')
  assert.equal(snap.byReason['captureSend.compensate'], undefined, '第三刀：补偿闭包不得再 assemble')
  // 去 rememberState 后：前像写入、补偿写入各冷读一次，后续 update 一次。
  assert.equal(snap.byReason.read.calls, 2)
  assert.equal(snap.byReason.update.calls, 1)
  assert.equal(snap.calls, 3)
  assert.equal(snap.completed, 3)
  assert.equal(snap.messageRows, 6)
})
