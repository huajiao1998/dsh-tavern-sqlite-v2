// PR10 修复定向测试（本地隔离克隆，不属主仓产品）：两条具名契约，全部用真 store ＋ 682 真投影 helper。
//  ① 外部提交后（另一 store/连接写同库）读缓存与连接级行缓存不得返回旧值；出借值脱离，篡改不回灌缓存。
//  ② 预算为 0（cacheMaxBytes=0 / maxCachedChats=0）时读路径不得缓存：每次读都要真执行 timeline 子行全量 SQL
//     与 messages 全量 SQL，投影 helper 每读各自重跑。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createChatSqliteStore } from '../chat-sqlite-store.js'
import { createChatProjectionReads } from '../lib/chat-projection-reads.js'
import { readdirSync } from 'node:fs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const author = path.resolve(process.env.TAVERN_PROJECTION_AUTHOR_ROOT || path.join(
  repo, '../release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain'))
assert.ok(existsSync(path.join(author, 'chat-session-state.js')), '需要 682 作者源码（只读）：' + author)

const load = name => import(pathToFileURL(path.join(author, name + '.js')).href)
const [json, copy, scoped, lazy] = await Promise.all(['json-mutation', 'copy-json-tree', 'scoped-messages', 'lazy-history-read'].map(load))
const source = readFileSync(path.join(author, 'chat-session-state.js'), 'utf8')
// 与既有 projection-reads.test.mjs 同做：两段真窗口拼起来取全部真 helper（不假造；copyLazyHistoryHeader 用真身）
const windowOf = (begin, end) => source.slice(source.indexOf('export function ' + begin), end === null ? undefined : source.indexOf('export function ' + end))
const projectionText = windowOf('pendingMvuSettlementState', 'settlementTurn') + '\n' + windowOf('projectDisplayRuntimeState', null)
const projectionNames = [...projectionText.matchAll(/export function (\w+)/g)].map(match => match[1])
assert.ok(projectionNames.length >= 6, '必须取到 6 个真投影 helper，实际 ' + projectionNames.length + '：' + projectionNames.join(','))
for (const required of ['pendingMvuSettlementState', 'projectChatSessionState', 'projectSessionMessage', 'projectDisplayRuntimeState']) {
  assert.ok(projectionNames.includes(required), '投影窗口缺 ' + required + '（实际 ' + projectionNames.join(',') + '）')
}
const projection = Function('copyJsonTree', 'copyLazyHistoryHeader',
  projectionText.replaceAll('export function ', 'function ') + ';return {' + projectionNames.join(',') + '}')(copy.copyJsonTree, lazy.copyLazyHistoryHeader)
let projections = 0
const helpers = {
  ...projection, ...json, ...copy, ...scoped, ...lazy,
  projectSessionMessage: row => { projections += 1; return projection.projectSessionMessage(row) },
}

const CHAT_ID = 'pr10-read-cache'
const MESSAGES = Array.from({ length: 6 }, (_v, index) => ({ role: index % 2 ? 'user' : 'assistant', turn: index + 1, text: '行文' + index }))
const baseChat = revision => ({
  id: CHAT_ID, sessionId: 'pr10-session', mode: 'card', _storageRevision: revision, updatedAt: revision,
  timeline: {
    schemaVersion: 1, branchId: 'branch-old', revision, participants: { background: { status: 'idle' } },
    operations: { op1: { kind: 'mvu', status: 'pending' } }, checkpoints: [{ payload: 'checkpoint-old' }],
  },
  messages: MESSAGES.map(row => ({ ...row })),
})
const BUSINESS_SET = revision => ([
  { op: 'set', path: ['_storageRevision'], value: revision },
  { op: 'set', path: ['updatedAt'], value: revision },
  { op: 'set', path: ['timeline', 'revision'], value: revision },
  { op: 'set', path: ['timeline', 'branchId'], value: 'branch-new' },
  { op: 'set', path: ['timeline', 'operations', 'op1', 'status'], value: 'completed' },
  { op: 'set', path: ['timeline', 'checkpoints', 0, 'payload'], value: 'checkpoint-new' },
  { op: 'set', path: ['messages', 1, 'text'], value: '行文-new' },
])

async function withRoot(name, run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pr10-' + name + '-'))
  try { return await run(root) } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep), '只清自建临时目录')
    rmSync(root, { recursive: true, force: true })
  }
}

test('PR10修复：外部提交后读缓存与行缓存不得返回旧值', () => withRoot('external', async root => {
  const writer = createChatSqliteStore({ dataRoot: root, helpers })
  const reader = createChatSqliteStore({ dataRoot: root, helpers })
  try {
    await writer.update(CHAT_ID, () => baseChat(1))
    // read 直接返回 Chat（不是 {chat,revision} 包装）
    const warmed = await reader.read(CHAT_ID)
    assert.equal(warmed.timeline.operations.op1.status, 'pending')
    await reader.readSessionState(CHAT_ID, { scoped: true })
    // 另一连接（writer store）真业务写：revision 2 ＋ op/branch/checkpoint/正文全变
    await writer.patch(CHAT_ID, 1, BUSINESS_SET(2))
    const full = await reader.read(CHAT_ID)
    assert.equal(full._storageRevision, 2, '外部提交后必须读到新 revision')
    assert.equal(full.timeline.operations.op1.status, 'completed', '外部提交后 timeline 行不得返回旧值')
    assert.equal(full.timeline.branchId, 'branch-new')
    assert.equal(full.timeline.checkpoints[0].payload, 'checkpoint-new')
    assert.equal(full.messages[1].text, '行文-new')
    const scopedState = await reader.readSessionState(CHAT_ID, { scoped: true })
    assert.equal(scopedState.timeline.operations.op1.status, 'completed', 'scoped 读同样不得旧值')
    const sliceText = JSON.stringify(await reader.readSlice(CHAT_ID, [1]))
    assert.ok(sliceText.includes('行文-new'), 'readSlice 必须给新正文：' + sliceText.slice(0, 160))
    // 出借值脱离：改返回值不得回灌缓存
    full.timeline.operations.op1.status = 'TAMPERED'
    full.timeline.checkpoints[0].payload = 'TAMPERED'
    const again = await reader.read(CHAT_ID)
    assert.equal(again.timeline.operations.op1.status, 'completed', '篡改出借值不得回灌行缓存')
    assert.equal(again.timeline.checkpoints[0].payload, 'checkpoint-new')
  } finally {
    reader.dispose()
    try { writer.dispose() } catch { /* 失败路径也要收 */ }
  }
}))

test('PR10修复：预算为0时读路径不得缓存（SQL 次数与委托计数）', () => withRoot('zero', async root => {
  const executed = []
  const original = DatabaseSync.prototype.prepare
  // statement-cache 会复用同一 statement ⇒ 只数 prepare 会漏；代理 statement 记录**每次执行**
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const statement = original.call(this, sql, ...rest)
    const text = String(sql)
    return new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value
        if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'iterate') {
          return (...args) => { executed.push(text); return value.apply(target, args) }
        }
        return value.bind(target)          // 合法调用一律放行（保留原上下文）
      },
    })
  }
  const since = from => executed.slice(from)
  const countOf = (list, needle) => list.filter(sql => sql === needle).length
  const NODES_FULL = 'SELECT node_key, ord, value_json FROM archive_timeline_nodes'
  const MESSAGES_FULL = 'SELECT message_index, message_json FROM archive_messages ORDER BY message_index'
  let writer = null
  try {
    writer = createChatSqliteStore({ dataRoot: root, helpers })
    await writer.update(CHAT_ID, () => baseChat(1))
    writer.dispose()
    writer = null
    for (const [label, options] of [['cacheMaxBytes=0', { cacheMaxBytes: 0 }], ['maxCachedChats=0', { maxCachedChats: 0 }]]) {
      const store = createChatSqliteStore({ dataRoot: root, helpers, ...options })
      try {
        const mark = executed.length
        const projectionsBefore = projections
        await store.readSessionState(CHAT_ID, { scoped: true })
        await store.readSessionState(CHAT_ID, { scoped: true })
        const afterScoped = since(mark)
        assert.ok(countOf(afterScoped, NODES_FULL) >= 2, label + '：两次 scoped 读都必须真执行 timeline 子行全量 SQL，实际=' + countOf(afterScoped, NODES_FULL))
        // scoped 会话读走 summaries 投影（不是整行 select）：只要每次都真查 messages 即证明无缓存命中
        const messagesScoped = afterScoped.filter(sql => sql.includes('FROM archive_messages')).length
        assert.ok(messagesScoped >= 2, label + '：两次 scoped 读都必须真查 messages，实际=' + messagesScoped)
        assert.equal(projections - projectionsBefore, MESSAGES.length * 2, label + '：投影 off 时每次读都要重跑 projectSessionMessage')
        const mark2 = executed.length
        await store.readSlice(CHAT_ID, [0, 1, 2])
        await store.readSlice(CHAT_ID, [0, 1, 2])
        const afterSlice = since(mark2)
        assert.equal(countOf(afterSlice, MESSAGES_FULL), 2, label + '：两次 readSlice 都要各自整行查 messages，实际=' + countOf(afterSlice, MESSAGES_FULL))
        // 整档读：预算为 0 时两次 read 都必须各自执行整行 messages 全量 select
        const mark3 = executed.length
        await store.read(CHAT_ID)
        await store.read(CHAT_ID)
        const afterRead = since(mark3)
        assert.equal(countOf(afterRead, MESSAGES_FULL), 2, label + '：两次 read 都要各自整行查 messages，实际=' + countOf(afterRead, MESSAGES_FULL))
        assert.ok(countOf(afterRead, NODES_FULL) >= 2, label + '：两次 read 都要各自执行 timeline 子行全量 SQL，实际=' + countOf(afterRead, NODES_FULL))
      } finally {
        store.dispose()
      }
    }
  } finally {
    DatabaseSync.prototype.prepare = original
    try { if (writer !== null) writer.dispose() } catch { /* 失败路径 */ }
  }
}))

// ===== 新增（第三/第四条）=====
const BIG = '时间线大载荷'.repeat(700)
const bigChat = (id, revision) => ({
  id, sessionId: 'pr10-' + id, mode: 'card', _storageRevision: revision, updatedAt: revision,
  timeline: { schemaVersion: 1, branchId: 'branch-' + id, revision, participants: { background: { status: 'idle' } },
    operations: { op1: { kind: 'mvu', status: 'pending', payload: BIG } }, checkpoints: [{ payload: BIG }] },
  messages: MESSAGES.map(row => ({ ...row })),
})
const NODES_FULL = 'SELECT node_key, ord, value_json FROM archive_timeline_nodes'
const KEY_GET = 'archive_timeline_nodes WHERE node_key'

test('PR10修复：行缓存软预算回收保留单个超大档及热读', () => withRoot('budget', async root => {
  const executed = []
  const keyReads = []                 // per-key 补读的 node_key 实参（用于断言"只补受影响行"）
  const original = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const statement = original.call(this, sql, ...rest)
    const text = String(sql)
    return new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value
        if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'iterate') return (...args) => {
          executed.push(text)
          if (text.includes('node_key=?') || text.includes('node_key = ?')) keyReads.push(args[0])
          return value.apply(target, args)
        }
        return value.bind(target)
      },
    })
  }
  const nodes = () => executed.filter(sql => sql === NODES_FULL).length
  const keys = () => executed.filter(sql => sql.includes(KEY_GET)).length
  const store = createChatSqliteStore({ dataRoot: root, helpers, cacheMaxBytes: 128, maxCachedChats: 2 })
  try {
    await store.update('idsa', () => bigChat('idsa', 1))
    await store.update('idsb', () => bigChat('idsb', 1))
    const cold = nodes()
    const readA = await store.read('idsa')
    assert.equal(readA.timeline.operations.op1.status, 'pending')
    assert.equal(nodes() - cold, 1, 'A 首读：整表组装恰好一次')
    let base = nodes()
    await store.read('idsa')
    assert.equal(nodes() - base, 0, 'A 热读：零整表组装（行缓存命中）')
    base = nodes()
    await store.read('idsb')
    assert.equal(nodes() - base, 1, 'B 首读：整表组装一次并触发软预算回收')
    base = nodes()
    await store.read('idsa')
    assert.equal(nodes() - base, 1, 'A 的旧行缓存必须被真正驱逐（再次整表组装）')
    base = nodes()
    await store.read('idsa')
    assert.equal(nodes() - base, 0, 'A 重新热读：零整表组装')
    // header-only patch：行不动（既不整表、也不按键补读）
    await store.patch('idsa', 1, [{ op: 'set', path: ['_storageRevision'], value: 2 }, { op: 'set', path: ['updatedAt'], value: 2 }])
    // 这里必须走**真投影读取**（read 会命中刚由 patch 写入的完整态 readCache ⇒ 0 SQL 不代表行缓存生效）
    base = nodes(); let keyBase = keyReads.length
    const headerOnly = await store.readSessionState('idsa', { scoped: true })
    assert.equal(headerOnly._storageRevision, 2)
    assert.equal(nodes() - base, 0, '头部写不得整表重解析 timeline')
    assert.deepEqual(keyReads.slice(keyBase), [], '头部写不得按键补读 timeline 行')
    // 新 op 行：只补 missing 键（R-5 护栏）
    await store.patch('idsa', 2, [{ op: 'set', path: ['_storageRevision'], value: 3 }, { op: 'set', path: ['timeline', 'revision'], value: 3 },
      { op: 'set', path: ['timeline', 'operations', 'op2'], value: { kind: 'mvu', status: 'new', payload: BIG } }])
    base = nodes(); keyBase = keyReads.length
    const afterOp = await store.readSessionState('idsa', { scoped: true })
    assert.equal(afterOp.timeline.operations.op2.status, 'new')
    assert.equal(nodes() - base, 0, '新 op 行不得整表重解析（零 NodeFull）')
    assert.deepEqual(keyReads.slice(keyBase), ['@meta', 'operations:op2'],
      '只补本次两受影响行(@meta/op2)；未受影响的 checkpoint 行不得补读')
    assert.equal(afterOp.timeline.checkpoints[0].payload, BIG, '未受影响的 checkpoint 保持旧缓存值')
    // remove 后重建：不得留旧行/旧 meta
    await store.remove('idsa')
    await store.update('idsa', () => ({ ...bigChat('idsa', 4), timeline: { schemaVersion: 1, branchId: 'branch-fresh', revision: 4, participants: { background: { status: 'idle' } }, operations: { op9: { kind: 'mvu', status: 'fresh' } }, checkpoints: [] } }))
    const fresh = await store.read('idsa')
    assert.equal(fresh.timeline.branchId, 'branch-fresh', 'remove 后不得留旧 meta')
    assert.equal(fresh.timeline.operations.op9.status, 'fresh')
    assert.equal(fresh.timeline.operations.op1, undefined, 'remove 后不得留旧行')
  } finally {
    store.dispose()
    DatabaseSync.prototype.prepare = original
  }
}))

test('PR10修复：独立投影读口外部revision与零预算保持契约', () => withRoot('projection', async root => {
  const writer = createChatSqliteStore({ dataRoot: root, helpers })
  let dbA = null
  try {
    await writer.update(CHAT_ID, () => baseChat(1))
    const found = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(name => String(name).endsWith('archive.db'))
    assert.ok(found.length >= 1, '必须能定位真 store 的 archive.db：' + JSON.stringify(found))
    dbA = new DatabaseSync(path.join(root, String(found[0])))
    const rowsByDb = new Map()
    const rowsFor = db => { let map = rowsByDb.get(db); if (map === undefined) { map = new Map(); rowsByDb.set(db, map) } return map }
    const reads = createChatProjectionReads({ helpers: { copyJsonTree: copy.copyJsonTree }, maxEntries: 8, maxBytes: 16 * 1024 * 1024, timelineRowsFor: rowsFor })
    const first = reads.header(dbA, CHAT_ID, ['timeline', '_storageRevision'])
    assert.equal(first._storageRevision, 1)
    assert.equal(first.timeline.operations.op1.status, 'pending')
    await writer.patch(CHAT_ID, 1, BUSINESS_SET(2))          // 外部连接提交，且**无** beforeRead 探针
    const second = reads.header(dbA, CHAT_ID, ['timeline', '_storageRevision'])
    assert.equal(second._storageRevision, 2, '独立读口必须看到新 revision')
    assert.equal(second.timeline.branchId, 'branch-new', 'standalone 回退必须清掉旧行')
    assert.equal(second.timeline.operations.op1.status, 'completed')
    assert.equal(second.timeline.checkpoints[0].payload, 'checkpoint-new')
    // 零预算：不填外部行 Map、不保留条目
    const reads0 = createChatProjectionReads({ helpers: { copyJsonTree: copy.copyJsonTree }, maxEntries: 8, maxBytes: 0, timelineRowsFor: rowsFor })
    const mark = rowsFor(dbA).size
    reads0.header(dbA, CHAT_ID, ['timeline', '_storageRevision'])
    reads0.header(dbA, CHAT_ID, ['timeline', '_storageRevision'])
    assert.equal(rowsFor(dbA).size, mark, '零预算不得往外部行 Map 填任何行')
    assert.equal(reads0.stats().entries, 0, '零预算不得保留投影条目')
  } finally {
    try { if (dbA !== null) dbA.close() } catch { /* 已关 */ }
    try { writer.dispose() } catch { /* 失败路径 */ }
  }
}))
