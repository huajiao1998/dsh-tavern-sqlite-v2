// 定向回归：原档可读但所有写入口只读；显式分叉必须使用新 ID 的 SQLite 档。
// 只用 Node 内置：node test/store-legacy-read.test.mjs
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'

const noop = () => undefined
const helpers = Object.fromEntries([
  'copyJsonTree', 'diffJson', 'applyJsonChangesShared',
  'projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState',
  'projectChatBackgroundConfig', 'projectSettlementCheckpoint',
].map(name => [name, noop]))
helpers.copyJsonTree = value => value === undefined ? undefined : structuredClone(value)
helpers.diffJson = () => [{ path: [], op: 'replace' }]
// 本闸仅用逐键 set，覆盖新 SQLite 档的正常 patch 写路径。
helpers.applyJsonChangesShared = (value, changes) => {
  const next = structuredClone(value)
  for (const change of changes) {
    assert.equal(change.op, 'set')
    assert.ok(change.path.length > 0)
    let parent = next
    for (const key of change.path.slice(0, -1)) parent = parent[key]
    parent[change.path.at(-1)] = structuredClone(change.value)
  }
  return next
}

function snapshot(directory, relative = '') {
  const files = {}
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name)
    const name = relative + entry.name
    if (entry.isDirectory()) Object.assign(files, snapshot(file, name + '/'))
    else files[name] = readFileSync(file)
  }
  return files
}

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-legacy-read-'))
const stores = []
const writableIds = []
try {
  const chatsRoot = path.join(root, 'chats')
  const blockId = 'chat-blocky'
  const journalId = 'chat-journal'
  const directoryJournalId = 'chat-journal-directory'
  const sourceMessages = [{ role: 'user', message: 'hi' }]
  const blockChat = { id: blockId, sessionId: 'session-source', _storageRevision: 1, chat_metadata: {}, messages: sourceMessages }
  const directoryJournalChat = { id: directoryJournalId, sessionId: 'session-journal-directory', _storageRevision: 3, chat_metadata: {}, messages: sourceMessages }
  mkdirSync(path.join(chatsRoot, blockId, 'blocks', 'ab'), { recursive: true })
  writeFileSync(path.join(chatsRoot, blockId, 'head.json'), '{"format":1,"headId":"ab' + '0'.repeat(62) + '"}', 'utf8')
  writeFileSync(path.join(chatsRoot, blockId, 'blocks', 'ab', 'ab' + '0'.repeat(62) + '.json'), '{"kind":"state"}', 'utf8')
  mkdirSync(path.join(chatsRoot, directoryJournalId, 'snapshots'), { recursive: true })
  mkdirSync(path.join(chatsRoot, directoryJournalId, 'journals'), { recursive: true })
  writeFileSync(path.join(chatsRoot, journalId + '.json'), JSON.stringify({ id: journalId, sessionId: 'session-journal', _storageRevision: 1, messages: sourceMessages }), 'utf8')

  const reads = []
  const legacyWrites = []
  const legacyDeletes = []
  const legacyStore = {
    async read(id) {
      reads.push(id)
      if (id === blockId || id === 'chat-shadow-block') return { ...structuredClone(blockChat), id }
      if (id === directoryJournalId) return structuredClone(directoryJournalChat)
      return undefined
    },
    async update(...args) { legacyWrites.push(args); throw new Error('不得回写作者原档') },
  }
  const legacyData = {
    async readJson(relative) {
      const file = path.join(root, relative)
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
    },
    async remove(...args) { legacyDeletes.push(args); throw new Error('不得删除作者原档') },
  }
  const store = createChatSqliteStore({ dataRoot: root, helpers, legacyData, legacyStore })
  stores.push(store)
  const originalBytes = snapshot(chatsRoot)

  // 1) 两种原件都能读；读取与 revision/slice 访问均不得建库、改原字节。
  assert.match(await store.version(blockId), /^legacy:\d+:\d+$/)
  assert.match(await store.version(journalId), /^legacy:\d+:\d+$/)
  const source = await store.read(blockId)
  assert.deepEqual(source, blockChat)
  assert.deepEqual(reads, [blockId], '块布局必须通过作者 store 读取')
  assert.equal((await store.read(journalId)).messages.length, 1)
  assert.deepEqual(await store.read(directoryJournalId), directoryJournalChat, '只有 snapshots/journals 的旧档必须交给作者 store 读取')
  assert.deepEqual(await store.readRevision(blockId, 1), blockChat)
  assert.equal((await store.readSlice(blockId, [])).chat.id, blockId)
  assert.deepEqual(snapshot(chatsRoot), originalBytes, '读原档不能改任何文件或生成数据库')

  // 2) 不存在的档不伪造；作者读源缺失时旧承载仍不可覆盖。
  assert.equal(await store.read('chat-none'), undefined)
  const bare = createChatSqliteStore({ dataRoot: root, helpers, legacyData: { readJson: async () => undefined } })
  stores.push(bare)
  assert.equal(await bare.read(blockId), undefined)
  const readonly = id => error => error?.code === 'DSH_TAVERN_LEGACY_READ_ONLY' && error.chatId === id && /手动分叉/.test(error.message)
  let unreadableUpdaterCalls = 0
  await assert.rejects(() => bare.update(blockId, () => { unreadableUpdaterCalls++; return blockChat }), readonly(blockId))
  await assert.rejects(() => bare.patch(blockId, 0, []), readonly(blockId))
  await assert.rejects(() => bare.remove(blockId), readonly(blockId))
  assert.equal(unreadableUpdaterCalls, 0, '不能把读不出的原件当新档传给 updater')

  // 3) 每个原档的普通 update、恒等 update、空 update、migrate:true 均拒绝，且不调用 updater。
  for (const id of [blockId, journalId, directoryJournalId]) {
    let updaterCalls = 0
    const mutate = chat => { updaterCalls++; chat._storageRevision++; chat.messages.push({ role: 'assistant', message: '不得写入' }); return chat }
    for (const metadata of [{}, { source: 'tavern.open' }, { migrate: true }]) {
      await assert.rejects(() => store.update(id, mutate, metadata), readonly(id))
    }
    await assert.rejects(() => store.update(id, chat => { updaterCalls++; return chat }), readonly(id))
    await assert.rejects(() => store.update(id, () => { updaterCalls++; return undefined }), readonly(id))
    assert.equal(updaterCalls, 0, '门禁必须先于原档 updater（含同 ID 显式迁移）')

    // 作者 chatPersistence.write 也最终走 records.update；完整替换不能绕过原档门禁。
    await assert.rejects(() => store.update(id, () => ({ id, _storageRevision: 2, messages: [] }), { source: 'chat.write' }), readonly(id))

    // 4) patch（非空、空、陈旧 revision、migrate:true）及 remove 一律拒绝。
    const changes = [{ op: 'set', path: ['_storageRevision'], value: 2 }, { op: 'set', path: ['title'], value: '不得改名' }]
    await assert.rejects(() => store.patch(id, 1, changes), readonly(id))
    await assert.rejects(() => store.patch(id, 1, changes, { migrate: true }), readonly(id))
    await assert.rejects(() => store.patch(id, 1, []), readonly(id))
    await assert.rejects(() => store.patch(id, 999, changes), readonly(id))
    await assert.rejects(() => store.remove(id), readonly(id))
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(existsSync(path.join(chatsRoot, id, 'archive.db' + suffix)), false, '拒写不得创建 archive.db/WAL/SHM')
    }
    assert.deepEqual(snapshot(chatsRoot), originalBytes, '全部原件字节与文件清单必须原样保留')
  }
  assert.equal(legacyWrites.length, 0, '绝不调用 legacyStore.update 做 JSON/块布局写回')
  assert.equal(legacyDeletes.length, 0, '绝不调用 legacyData.remove 删除原件')

  // 5) 没有可见物理文件、但作者读源返回 legacy state 时也必须拒写。
  const memoryId = 'chat-legacy-reader-only'
  const memoryStore = createChatSqliteStore({
    dataRoot: root, helpers, legacyData: { readJson: async () => undefined },
    legacyStore: { read: async id => id === memoryId ? { id, _storageRevision: 1, messages: [] } : undefined },
  })
  stores.push(memoryStore)
  await assert.rejects(() => memoryStore.update(memoryId, chat => ({ ...chat, _storageRevision: 2 }), { migrate: true }), readonly(memoryId))
  await assert.rejects(() => memoryStore.patch(memoryId, 1, []), readonly(memoryId))
  await assert.rejects(() => memoryStore.remove(memoryId), readonly(memoryId))
  assert.deepEqual(snapshot(chatsRoot), originalBytes)

  // 6) 原件与同 ID archive.db 并存（历史原地迁移/空库 shadow）仍是只读原档。
  // 用独立 SQLite fixture 构造 shadow；读取/拒写均不得打开它、建 WAL 或升级 schema。
  for (const kind of ['block', 'journal']) {
    const id = 'chat-shadow-' + kind
    mkdirSync(path.join(chatsRoot, id), { recursive: true })
    if (kind === 'block') writeFileSync(path.join(chatsRoot, id, 'head.json'), '{"format":1}', 'utf8')
    else writeFileSync(path.join(chatsRoot, id + '.json'), JSON.stringify({ id, _storageRevision: 1, messages: sourceMessages }), 'utf8')
    const db = new DatabaseSync(path.join(chatsRoot, id, 'archive.db'))
    db.exec('CREATE TABLE shadow_marker (note TEXT); INSERT INTO shadow_marker VALUES (\'原样保留\')')
    db.close()
    const before = snapshot(chatsRoot)
    assert.match(await store.version(id), /^legacy:\d+:\d+$/, '同 ID 的数据库不能覆盖原件 stamp')
    assert.deepEqual((await store.read(id)).messages, sourceMessages, '读取必须仍是原件，不是 shadow 数据库')
    assert.deepEqual((await store.readRevision(id, 1)).messages, sourceMessages)
    const selected = await store.readSlice(id, [0])
    assert.equal(selected.messageCount, 1)
    assert.deepEqual(selected.chat.messages, sourceMessages)
    assert.equal(await store.readChangedSlice(id, 1), undefined)
    assert.deepEqual((await store.readChangedIndices(id, 1)).indices, [])
    assert.equal(await store.readViewDelta(id, 1), undefined)
    const bareShadow = createChatSqliteStore({ dataRoot: root, helpers, legacyData: { readJson: async () => undefined } })
    stores.push(bareShadow)
    assert.equal(await bareShadow.read(id), undefined, '原件读不出也不能静默 fallback 到 shadow 数据库')
    let shadowUpdaterCalls = 0
    await assert.rejects(() => store.update(id, () => { shadowUpdaterCalls++; return { id, _storageRevision: 2, messages: [] } }, { migrate: true }), readonly(id))
    await assert.rejects(() => store.patch(id, 1, []), readonly(id))
    await assert.rejects(() => store.remove(id), readonly(id))
    assert.equal(shadowUpdaterCalls, 0)
    assert.deepEqual(snapshot(chatsRoot), before, '原件+shadow数据库必须都不被触碰')
  }

  // 7) 全新 ID 可创建 SQLite 档；手动 fork 复制已读源，改 chat/session 两个 ID，不修改原件。
  const beforeFork = snapshot(chatsRoot)
  const newId = 'chat-new'
  writableIds.push(newId)
  await store.update(newId, current => {
    assert.equal(current, undefined)
    return { id: newId, sessionId: 'session-new', _storageRevision: 1, messages: [] }
  })
  assert.ok(existsSync(path.join(chatsRoot, newId, 'archive.db')))
  assert.match(await store.version(newId), /^sqlite:gen:\d+$/)

  const forkId = 'chat-fork'
  writableIds.push(forkId)
  const fork = await store.update(forkId, current => {
    assert.equal(current, undefined)
    return { ...structuredClone(source), id: forkId, sessionId: 'session-fork', _storageRevision: 1,
      forkedFrom: { chatId: source.id, sessionId: source.sessionId, storageRevision: source._storageRevision } }
  }, { migrate: true })
  assert.equal(fork.id, forkId)
  assert.notEqual(fork.sessionId, source.sessionId)
  assert.deepEqual((await store.read(forkId)).messages, source.messages)
  assert.match(await store.version(forkId), /^sqlite:gen:\d+$/)
  const updatedFork = await store.update(forkId, chat => {
    chat._storageRevision = 2
    chat.messages.push({ role: 'assistant', message: '只改分叉' })
    return chat
  })
  assert.equal(updatedFork.messages.length, 2)
  const patchedFork = await store.patch(forkId, 2, [
    { op: 'set', path: ['_storageRevision'], value: 3 },
    { op: 'set', path: ['title'], value: '可写的分叉' },
  ])
  assert.equal(patchedFork.title, '可写的分叉')
  assert.equal((await store.read(forkId))._storageRevision, 3)
  assert.deepEqual((await store.read(blockId)).messages, source.messages, '源档内存状态也不能被fork后续写影响')
  for (const [name, bytes] of Object.entries(beforeFork)) {
    assert.deepEqual(readFileSync(path.join(chatsRoot, name)), bytes, '创建/写分叉后原件仍逐字节一致：' + name)
  }
  assert.equal(existsSync(path.join(chatsRoot, forkId + '.json')), false, '新档不能用 JSON 写回')
  assert.equal(existsSync(path.join(chatsRoot, forkId, 'head.json')), false, '新档不能生成块布局')

  // 8) 新 ID 首写失败仍清空本次创建的数据库/WAL/SHM，不留下半迁移空库。
  const boomId = 'chat-boom'
  writableIds.push(boomId)
  await assert.rejects(() => store.update(boomId, () => ({ id: boomId, _storageRevision: 1, kaboom: 1n, messages: [] })))
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(path.join(chatsRoot, boomId, 'archive.db' + suffix)), false)

  // 9) 可写数据库档仍可删除；删除只碰自己的SQLite，不触发作者原件删除接口。
  await store.remove(newId)
  for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(path.join(chatsRoot, newId, 'archive.db' + suffix)), false)
  assert.equal(legacyWrites.length, 0)
  assert.equal(legacyDeletes.length, 0)
} finally {
  // 本测试独占 mkdtemp 子目录；先关闭我们新建SQLite档的句柄，再清自己的目录。
  for (const instance of stores) {
    for (const id of writableIds) {
      try { await instance.remove(id) } catch { /* 首写失败可能没库 */ }
    }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

console.log('store-legacy-read：原件可读、全部写入口只读、shadow拒写、新ID/fork SQLite可写、原件字节完整保留通过')
