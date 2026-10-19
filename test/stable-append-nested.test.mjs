// stable真实消费者→生成接缝→同连接SQLite；仅覆盖本轮嵌套数组写入修复。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { applyNativeMessageTransform } from '../deploy/native-data-transform.mjs'
import { computeTimelinePlan } from '../lib/timeline-nodes.js'

const author = new URL('../../../tmp/adapt-dsh-021rc2-20261018/stable/tavern-plugin/lib/domain/', import.meta.url)
const { diffJson, applyJsonChangesShared } = await import(new URL('json-mutation.js', author))
const { copyJsonTree } = await import(new URL('copy-json-tree.js', author))
const { captureChatHeader } = await import(new URL('chat-persistence.js', author))
const { createStoryTimeline } = await import(new URL('story-timeline.js', author))
const source = applyNativeMessageTransform(readFileSync(new URL('turn-orchestration.js', author), 'utf8'), 'appendMessages')
const begin = source.indexOf('  async function finalizeAppend(input) {')
const end = source.indexOf('  async function finalizeSnapshot(', begin)
const factory = new Function('store', 'diffJson', 'captureChatHeader', 'lastTavernHelperVariables', 'finalizeSnapshot',
  source.slice(begin, end) + '\nreturn finalizeAppend')
const helpers = { copyJsonTree, diffJson, applyJsonChangesShared }
for (const name of ['projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState', 'projectChatBackgroundConfig', 'projectSettlementCheckpoint']) helpers[name] = value => value

async function fixture(t, mutate) {
  const root = mkdtempSync(path.join(tmpdir(), 'stable-append-nested-'))
  const store = createChatSqliteStore({ dataRoot: root, helpers })
  t.after(() => { store.dispose(); rmSync(root, { recursive: true }) })
  const id = 'fixture-stable', sessionId = 'fixture-session'
  const timeline = createStoryTimeline({ now: () => 1700000000000 })
  let chat = { id, sessionId, _storageRevision: 1, mode: 'story', messages: [], contextCompaction: { baseline: [1, 2, 3] } }
  const first = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 1, userText: '第一轮' } })
  chat = timeline.complete({ chat: first.chat, operationId: first.value.operationId, basedOn: first.chat.timeline.operations[first.value.operationId].basedOn, outcome: { status: 'success' } }).chat
  chat.timeline.checkpoints[0].businessBefore = { version: 1, fields: { contextCompaction: { baseline: [1, 2, 3, 4, 5, 6, 7, 8], obsolete: true } } }
  const second = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 2, userText: '第二轮' } })
  await store.update(id, () => ({ ...second.chat, _storageRevision: 2 }))
  const before = await store.read(id) // 预热同行缓存。
  const calls = []
  const adapter = {
    readChatSlice: async () => { const value = await store.read(id); return { chat: value, denseMessages: true, messageCount: value.messages.length } },
    patchChat: () => { throw Error('不得回落整档patch') },
    appendMessages: async (...args) => { calls.push(args); return store.appendMessages(...args) },
  }
  // 只替换LLM/模板边界；完成态由真实timeline.complete生成。
  const finalize = factory(adapter, diffJson, captureChatHeader, () => undefined, async (input, current, write) => {
    const op = current.timeline.operations[second.value.operationId]
    const next = timeline.complete({ chat: current, operationId: second.value.operationId, basedOn: op.basedOn, outcome: { status: 'success' } }).chat
    next.messages = [{ role: 'user', turn: 2, text: '输入' }, { role: 'assistant', turn: 2, text: '输出' }]
    mutate(next)
    await write(next, { source: 'fixture', sessionId })
    return { saved: true }
  })
  const db = () => new DatabaseSync(path.join(root, 'chats', id, 'archive.db'))
  return { store, id, sessionId, before, calls, db, finalize }
}

for (const [name, mutate, expected] of [
  ['追加', value => value.push(9), [1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ['缩短', value => value.splice(5), [1, 2, 3, 4, 5]],
]) test('stable追加链：baseline嵌套数组' + name + '与正文同事务保存', async t => {
  const f = await fixture(t, next => {
    mutate(next.timeline.checkpoints[0].businessBefore.fields.contextCompaction.baseline)
    next.contextCompaction.baseline.push(4) // 头字段深层splice也必须按最终根值保存。
  })
  assert.deepEqual(await f.finalize({ sessionId: f.sessionId, turn: 2 }), { saved: true })
  const update = f.calls[0][2].timelineUpdate
  const nested = update.changes.find(change => change.op === 'splice' && change.path.at(-1) === 'baseline')
  assert.ok(nested && nested.index > 0, '嵌套下标必须大于所属检查点下标，覆盖旧漏写路径')
  const plan = computeTimelinePlan([nested], update.value)
  assert.deepEqual([...plan.checkpointWrites], [0])
  assert.equal(plan.spliceFrom, Infinity, '嵌套变化只写所属行，不重写检查点尾部')
  const hot = await f.store.read(f.id)
  assert.deepEqual(hot.timeline.checkpoints[0].businessBefore.fields.contextCompaction.baseline, expected)
  assert.deepEqual(hot.contextCompaction.baseline, [1, 2, 3, 4])
  assert.equal(hot.messages.length, 2)
  const db = f.db()
  try {
    const cp = JSON.parse(db.prepare("SELECT value_json FROM archive_timeline_nodes WHERE node_key='checkpoints#0'").get().value_json)
    assert.deepEqual(cp.businessBefore.fields.contextCompaction.baseline, expected, 'SQL真实行与热读一致')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM archive_messages').get().n, 2)
  } finally { db.close() }
})

test('stable追加链：检查点内字段删除只写所属行', async t => {
  const f = await fixture(t, next => { delete next.timeline.checkpoints[0].businessBefore.fields.contextCompaction.obsolete })
  await f.finalize({ sessionId: f.sessionId, turn: 2 })
  const update = f.calls[0][2].timelineUpdate
  const changes = update.changes.filter(change => change.op === 'delete')
  const plan = computeTimelinePlan(changes, update.value)
  assert.deepEqual([...plan.checkpointWrites], [0])
  assert.equal(plan.spliceFrom, Infinity)
  const db = f.db()
  try {
    const cp = JSON.parse(db.prepare("SELECT value_json FROM archive_timeline_nodes WHERE node_key='checkpoints#0'").get().value_json)
    assert.equal(Object.hasOwn(cp.businessBefore.fields.contextCompaction, 'obsolete'), false)
  } finally { db.close() }
})

test('stable追加链：过期时间线仍回滚正文与头字段', async t => {
  const f = await fixture(t, () => {})
  const value = structuredClone(f.before.timeline)
  value.revision += 2
  await assert.rejects(() => f.store.appendMessages(f.id, f.before._storageRevision, {
    items: [{ role: 'assistant', turn: 2, text: '不得写入' }],
    headerSets: { contextCompaction: { baseline: [99] } },
    timelineUpdate: { value, expected: { branchId: value.branchId, revision: f.before.timeline.revision + 1 }, changes: diffJson(f.before.timeline, value).map(change => ({ ...change, path: ['timeline', ...change.path] })) },
  }, { sessionId: f.sessionId }), /版本不符/)
  const after = await f.store.read(f.id)
  assert.deepEqual(after.messages, f.before.messages)
  assert.deepEqual(after.contextCompaction, f.before.contextCompaction)
  assert.equal(after._storageRevision, f.before._storageRevision)
})
