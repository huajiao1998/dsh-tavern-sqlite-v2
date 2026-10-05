// 定向闸：变量归档（PLG-012 C 阶段）——变量快照链/当前态与聊天存档**同库同事务**。
//
// 覆盖（本轮指定的最小集，全部为**本文件自带的原创小 fixture**）：
//   ① fake 新档：变量表与 chat 表同在 archive.db（不另建 variables.db）
//   ② K4：窗口外老楼的 variables 落库前先存快照（含 swipe 数组），读口（read / readWindow /
//      readHelperContext / readSettlementBase）按 swipe 精确补回；greeting 基线不修剪
//   ③ R0 snapshotAll 缓存：命中同一 Map、写后按 generation 失效
//   ④ 同一个 SQL 事务失败 ⇒ chat 行与变量行一起回滚
//   ⑤ 尾部截断：越界快照清零 + state 回拨到幸存的最新一棵
//   ⑥ legacy 原件（块布局 head.json）：只读不写、不建 archive.db/变量表、字节不变
//   ⑦ store.variables 接口与 dispose：释放后禁止写入、读口不偷开句柄
//
// 只用 node 内置 + mkdtemp：不读真实存档、不碰远端、不读别的测试 fixture。
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { createChatSqliteStore } from '../chat-sqlite-store.js'

const noop = () => undefined

// ---------- fixture：8 项必需 helper + 3 项协议 helper（自写，只保留被断言的契约） ----------
function baseHelpers() {
  const helpers = Object.fromEntries([
    'copyJsonTree', 'diffJson', 'applyJsonChangesShared',
    'projectSceneImageState', 'projectChatSessionState', 'projectDisplayRuntimeState',
    'projectChatBackgroundConfig', 'projectSettlementCheckpoint',
  ].map(name => [name, noop]))
  helpers.copyJsonTree = value => (value === undefined ? undefined : structuredClone(value))
  helpers.applyJsonChangesShared = (value, changes) => {
    const next = structuredClone(value)
    for (const change of changes) {
      assert.equal(change.op, 'set')
      let parent = next
      for (const key of change.path.slice(0, -1)) parent = parent[key]
      parent[change.path.at(-1)] = structuredClone(change.value)
    }
    return next
  }
  // 真一点的 diff：只报真的变了的键/楼（少报=不会把未变的楼重写，也就验证得了 touched 语义）
  helpers.diffJson = (previous, next) => {
    if (!previous || typeof previous !== 'object') return [{ path: [], op: 'set', value: next }]
    const changes = []
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (key === 'messages') continue
      if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes.push({ path: [key], op: 'set', value: next[key] })
    }
    const before = Array.isArray(previous.messages) ? previous.messages : []
    const after = Array.isArray(next.messages) ? next.messages : []
    if (after.length < before.length) {
      changes.push({ path: ['messages'], op: 'splice', index: after.length, deleteCount: before.length - after.length, items: [] })
    } else {
      for (let index = 0; index < before.length; index++) {
        if (JSON.stringify(before[index]) !== JSON.stringify(after[index])) changes.push({ path: ['messages', index], op: 'set', value: after[index] })
      }
      for (let index = before.length; index < after.length; index++) changes.push({ path: ['messages', index], op: 'set', value: after[index] })
    }
    return changes
  }
  return helpers
}

function protocolHelpers() {
  return {
    projectTavernHelperMessage(source, messageId) {
      const swipes = Array.isArray(source.swipes) && source.swipes.length > 0 ? source.swipes : [String(source.text ?? '')]
      const swipeId = Math.max(0, Math.min(swipes.length - 1, Number(source.swipeId) || 0))
      const variables = Array.isArray(source.variables) ? structuredClone(source.variables) : []
      return { message_id: messageId, role: 'assistant', swipes, swipe_id: swipeId, swipes_data: variables, variables: variables[swipeId] ?? {} }
    },
    projectTavernHelperContext(chat) {
      return { version: 1, chatId: String(chat?.id || ''), stateRevision: Math.max(0, Number(chat?._storageRevision) || 0), messages: [] }
    },
    // scoped messages 的最小契约：按位懒读、成员不可改
    createScopedMessages(length, entries, readBase) {
      const owned = new Map((entries || []).map(([id, row]) => [String(id), row]))
      const indexable = key => typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < length
      return new Proxy([], {
        get(target, key, receiver) {
          if (key === 'length') return length
          if (indexable(key)) return owned.has(key) ? owned.get(key) : readBase(Number(key))
          return Reflect.get(target, key, receiver)
        },
        set(target, key, value) {
          if (key === 'length' && value === length) return true
          if (!indexable(key)) throw new Error('Scoped messages cannot change history membership')
          owned.set(key, value)
          return true
        },
        deleteProperty() { throw new Error('Scoped messages cannot delete history') },
      })
    },
  }
}

const tree = turn => ({ stat_data: { 轮次: turn }, schema: { type: 'object' } })
const treeOf = (index, offset = 0) => ({ stat_data: { 轮次: index * 10 + offset }, schema: { type: 'object' } })

function assistant(index, options = {}) {
  const trees = options.trees ?? [tree(index)]
  const swipes = options.swipes ?? trees.map((_value, swipe) => 'text-' + index + '-' + swipe)
  return {
    role: 'assistant', turn: options.turn ?? index, swipeId: options.swipeId ?? 0, swipes,
    variables: trees, text: swipes[0],
  }
}
const greeting = index => ({ role: 'assistant', greeting: true, turn: 0, swipeId: 0, swipes: ['开场'], variables: [tree(0)], text: '开场' })

function chatFixture(id, messages, revision = 1) {
  return {
    id, sessionId: 'session-' + id, _storageRevision: revision, mode: 'story', title: '变量归档闸',
    timeline: { branchId: 'main', revision, checkpoints: [], operations: {} }, messages,
  }
}

const chatRow = (db, index) => {
  const row = db.prepare('SELECT message_json FROM archive_messages WHERE message_index = ?').get(index)
  return row === undefined ? undefined : JSON.parse(row.message_json)
}
const snapshotCount = db => Number(db.prepare('SELECT COUNT(*) AS n FROM variable_snapshots').get().n)

const root = mkdtempSync(path.join(os.tmpdir(), 'tavern-variable-archive-'))
const chatsRoot = path.join(root, 'chats')
mkdirSync(chatsRoot, { recursive: true })
const stores = []
const sides = []

function openStore(options = {}) {
  const store = createChatSqliteStore({
    dataRoot: root,
    legacyData: undefined,
    helpers: { ...baseHelpers(), ...protocolHelpers() },
    ...options,
  })
  stores.push(store)
  return store
}
function openSide(chatId) {
  const db = new DatabaseSync(path.join(chatsRoot, chatId, 'archive.db'))
  sides.push(db)
  return db
}

try {
  const store = openStore()

  // ---------- ① fake 新档：变量表与 chat 表同库 + K4 修剪 ----------
  const chatId = 'chat-var-k4'
  const messages = [
    greeting(0),
    assistant(1),
    // 2 号楼：两个 swipe 槽（选中 1）—— swipe 准确性的关键样本
    assistant(2, { trees: [treeOf(2, 1), treeOf(2, 2)], swipeId: 1 }),
    assistant(3),
    assistant(4),
    assistant(5),
    assistant(6),
    assistant(7),
  ]
  const created = await store.update(chatId, current => {
    assert.equal(current, undefined)
    return chatFixture(chatId, messages, 1)
  })
  assert.equal(created._storageRevision, 1)

  const db = openSide(chatId)
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name)
  for (const name of ['archive_messages', 'variable_snapshots', 'variable_state']) {
    assert.ok(tables.includes(name), 'archive.db 里必须有 ' + name)
  }
  assert.equal(existsSync(path.join(chatsRoot, chatId, 'variables.db')), false, '不得另建 variables.db')

  // K4：最新 4 个带树楼（4/5/6/7）留在行里；1/2/3 先存快照再删；0 楼是 greeting 基线，永不修剪
  for (const index of [1, 2, 3]) assert.equal(Object.hasOwn(chatRow(db, index), 'variables'), false, index + ' 楼应已修剪')
  for (const index of [0, 4, 5, 6, 7]) assert.equal(Object.hasOwn(chatRow(db, index), 'variables'), true, index + ' 楼不应修剪')
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM variable_snapshots WHERE message_index = 2').get().n), 2, '2 号楼两个 swipe 槽都要有快照')

  const stats = store.variables.stats(chatId)
  assert.equal(stats.snapshots.count, 9, '0..7 共 9 个 swipe 槽')
  assert.deepEqual(stats.hot, { count: 4, limit: 4 }, 'K4 热内存窗口 = 最新 4 棵')
  assert.equal(store.variables.has(chatId), true)

  // ---------- ② 读口按 swipe 精确补回 ----------
  const full = await store.read(chatId)
  assert.deepEqual(full.messages[1].variables, [tree(1)], '修剪掉的老楼在读口补回')
  assert.deepEqual(full.messages[2].variables, [treeOf(2, 1), treeOf(2, 2)], '两个 swipe 槽都要还原（不是 turn-only）')
  assert.equal(full.messages[2].swipeId, 1, '选中 swipe 不变')
  assert.equal(store.variables.snapshot(chatId).stat_data.轮次, 7, '当前态 = 最新一棵合格 MVU 树')
  assert.deepEqual(store.variables.snapshotAt(chatId, 2), treeOf(2, 2), '时间旅行取选中 swipe 的树')
  assert.deepEqual(store.variables.snapshotAt(chatId, 1), tree(1))
  assert.equal(store.variables.snapshotAt(chatId, 99), undefined)

  full.messages[1].variables[0].stat_data.轮次 = 999
  assert.deepEqual((await store.read(chatId)).messages[1].variables, [tree(1)], '读口给的是脱离副本，改不到库/缓存')
  assert.deepEqual(store.variables.snapshotAt(chatId, 1), tree(1), '用户 mutation 不污染变量缓存')

  const page = await store.readWindow(chatId, { limit: 3, before: 4 })
  assert.equal(page.from, 1)
  assert.equal(page.to, 3)
  assert.deepEqual(page.chat.messages[1].variables, [treeOf(2, 1), treeOf(2, 2)], '窗口只含这一页且老楼已补数')

  const helper = await store.readHelperContext(chatId, { from: 1, to: 2 })
  assert.equal(helper.context.messages[1].swipes_data.length, 2, '非选中 swipe 也要在投影里')
  assert.deepEqual(helper.context.messages[1].variables, treeOf(2, 2), '投影里的当前变量 = 选中 swipe')

  const base = await store.readSettlementBase(chatId)
  assert.deepEqual(base.chat.messages[3].variables, [tree(3)], '结算基座按位懒读同样补数')
  assert.equal(await base.previousMvu(4), 3, '被修剪的老楼仍能被 previousMvu 找到（走快照表）')
  assert.deepEqual(base.chat.messages[2].variables, [treeOf(2, 1), treeOf(2, 2)])

  const slice = await store.readSlice(chatId, [1, 2])
  assert.deepEqual(slice.chat.messages[1].variables, [treeOf(2, 1), treeOf(2, 2)], 'readSlice 也补数')

  // header-only 写：不重扫 messages、不动变量表
  const snapshotsBeforeHeader = snapshotCount(db)
  await store.update(chatId, current => ({ ...current, title: '改了标题', _storageRevision: current._storageRevision + 1 }))
  assert.equal(snapshotCount(db), snapshotsBeforeHeader, 'header-only 写不动变量表')

  // 脱离隔离的强断言：读口补出的老变量被改过之后再写一轮，也不能把它写进库/写进 readCache 基线
  const polluted = await store.read(chatId)
  polluted.messages[1].variables[0].stat_data.轮次 = -1
  polluted.messages[2].variables[1].stat_data.轮次 = -1
  await store.update(chatId, current => ({
    ...current, _storageRevision: current._storageRevision + 1,
    messages: [...current.messages, assistant(8)],
  }))
  assert.deepEqual(store.variables.snapshotAt(chatId, 1), tree(1), '用户改读口副本不得回写变量库')
  assert.deepEqual(store.variables.snapshotAt(chatId, 2), treeOf(2, 2))
  assert.deepEqual((await store.read(chatId)).messages[1].variables, [tree(1)], '写基线里也不得混入被改过的副本')
  assert.equal(Object.hasOwn(chatRow(db, 4), 'variables'), false, '窗口前移后 4 号楼也被修剪')

  // ---------- ③ R0 snapshotAll：缓存命中 + 写后按 generation 失效 ----------
  const cacheA = store.variables.snapshotAll(chatId)
  assert.ok(cacheA instanceof Map)
  assert.equal(cacheA.size, 9, 'turn 0..8 各一棵（同 turn 取最后写入的）')
  assert.deepEqual(cacheA.get(2), treeOf(2, 2))
  assert.strictEqual(store.variables.snapshotAll(chatId), cacheA, '同一代内命中同一 Map')

  await store.update(chatId, current => ({
    ...current, _storageRevision: current._storageRevision + 1,
    messages: [...current.messages, assistant(9)],
  }))
  const cacheB = store.variables.snapshotAll(chatId)
  assert.notStrictEqual(cacheB, cacheA, '写后必须换一代（缓存失效）')
  assert.equal(cacheB.size, 10)
  assert.deepEqual(cacheB.get(9), tree(9))
  assert.equal(Object.hasOwn(chatRow(db, 5), 'variables'), false, '窗口再前移，5 号楼被修剪')
  assert.equal(store.variables.stats(chatId).hot.count, 4)

  // ---------- ④ 同一个 SQL 事务失败 ⇒ chat 行与变量行一起回滚 ----------
  const beforeRead = await store.read(chatId)
  const beforeSnapshots = snapshotCount(db)
  db.exec(`CREATE TRIGGER fail_append BEFORE INSERT ON archive_messages
    WHEN NEW.message_index = 10 BEGIN SELECT RAISE(ABORT, 'same-sql-fail'); END`)
  await assert.rejects(
    () => store.update(chatId, current => ({
      ...current, _storageRevision: current._storageRevision + 1,
      messages: [...current.messages, assistant(10)],
    })),
    /same-sql-fail/,
  )
  db.exec('DROP TRIGGER fail_append')
  assert.equal(snapshotCount(db), beforeSnapshots, '变量快照必须随 chat 写一起回滚（同事务）')
  const afterRead = await store.read(chatId)
  assert.equal(afterRead._storageRevision, beforeRead._storageRevision, '失败的写不得推进 revision')
  assert.equal(afterRead.messages.length, beforeRead.messages.length, '失败的写不得落楼')
  assert.equal(store.variables.has(chatId), true)

  // ---------- ⑤ readViewDelta 的 dirty 行也按同一条规则补数 ----------
  //  dirty 通常落在热楼，但"通常"不是契约：这里故意改动一个**已被 K4 修剪**的老楼（1 号楼），
  //  它的 stored 形态没有 variables —— 不补数的话客户端拿到的就是"变量凭空消失"。
  await store.update(chatId, current => ({
    ...current, _storageRevision: current._storageRevision + 1,
    messages: current.messages.map((row, index) => (index === 1 ? { ...row, text: '改写过' } : row)),
  }))
  assert.equal(Object.hasOwn(chatRow(db, 1), 'variables'), false, '被改的老楼仍是修剪形态（快照仍在）')
  const view = await store.readViewDelta(chatId, beforeRead._storageRevision)
  assert.ok(view, '视图增量应可算')
  assert.deepEqual(view.indices, [1], 'dirty 只含被改的 1 号楼')
  assert.deepEqual(view.chat.messages[1].variables, [tree(1)], 'dirty 行必须与其它读口一样补数')
  assert.equal(view.chat.messages[1].text, '改写过')
  assert.equal(Object.hasOwn(view.chat.messages[0], 'variables'), false, '非 dirty 行仍不带变量（显示增量）')

  // ---------- ⑥ 尾部截断：越界快照清零 + state 回拨 ----------
  const tailId = 'chat-var-tail'
  await store.update(tailId, () => chatFixture(tailId, [
    greeting(0), assistant(1), assistant(2), assistant(3), assistant(4), assistant(5),
  ], 1))
  assert.equal(store.variables.stats(tailId).snapshots.count, 6)
  assert.deepEqual(store.variables.snapshot(tailId), tree(5))
  await store.update(tailId, current => ({
    ...current, _storageRevision: current._storageRevision + 1,
    messages: current.messages.slice(0, 3),
  }))
  assert.equal(store.variables.stats(tailId).snapshots.count, 3, '尾部越界快照必须清零')
  assert.deepEqual(store.variables.snapshot(tailId), tree(2), 'state 回拨到幸存的最新一棵')
  assert.equal(store.variables.snapshotAt(tailId, 5), undefined)
  assert.deepEqual(store.variables.snapshotAt(tailId, 1), tree(1))
  assert.equal(store.variables.deleteFrom(tailId, 3).deleted >= 0, true, 'deleteFrom 只动变量自己的表')
  assert.deepEqual(store.variables.snapshot(tailId), tree(2))

  // ---------- ⑥ legacy 原件：只读、不写、不建库 ----------
  const legacyId = 'chat-var-legacy'
  const legacyDir = path.join(chatsRoot, legacyId)
  mkdirSync(legacyDir, { recursive: true })
  const headFile = path.join(legacyDir, 'head.json')
  const legacyChat = chatFixture(legacyId, [greeting(0), assistant(1), assistant(2)], 1)
  writeFileSync(headFile, JSON.stringify(legacyChat), 'utf8')
  const headBytes = readFileSync(headFile)
  const legacyStore = openStore({ legacyData: { readJson: async () => legacyChat } })
  assert.deepEqual((await legacyStore.read(legacyId)).messages, legacyChat.messages)
  assert.equal((await legacyStore.readWindow(legacyId, { limit: 2 })).messageCount, 3)
  assert.equal(legacyStore.variables.has(legacyId), false)
  assert.equal(legacyStore.variables.snapshotAll(legacyId), undefined)
  assert.equal(existsSync(path.join(legacyDir, 'archive.db')), false, '读原档不得建 archive.db')
  assert.deepEqual(readFileSync(headFile), headBytes, '读原档不得改写原件字节')

  // ---------- ⑦ 坏快照行：响亮失败（不静默跳过假装快照链完整） ----------
  const corruptId = 'chat-var-corrupt'
  await store.update(corruptId, () => chatFixture(corruptId, [greeting(0), assistant(1), assistant(2)], 1))
  const corruptSide = openSide(corruptId)
  corruptSide.prepare('UPDATE variable_snapshots SET tree_json = ? WHERE message_index = 1 AND swipe_id = 0').run('{坏行')
  const freshStore = openStore()      // 空缓存：不会被上一代的好值掩盖
  assert.throws(
    () => freshStore.variables.snapshotAll(corruptId),
    error => error?.code === 'DSH_TAVERN_VARIABLE_SNAPSHOT_CORRUPT' && /损坏/.test(String(error.message)),
    '坏行必须抛 DSH_TAVERN_VARIABLE_SNAPSHOT_CORRUPT',
  )
  corruptSide.prepare('UPDATE variable_snapshots SET tree_json = ? WHERE message_index = 1 AND swipe_id = 0').run(JSON.stringify(tree(1)))
  assert.deepEqual(freshStore.variables.snapshotAll(corruptId).get(1), tree(1), '坏行修好后照常可读')

  // ---------- ⑧ v1（archive_state 单行）→ v3 迁移：变量表一并建好、迁移写入即落快照 ----------
  //  本轮改了 writeChat 签名与 ensureSchema，这条只做冒烟（防"迁移路径没人走"的假通过）。
  const v1Id = 'chat-var-v1'
  mkdirSync(path.join(chatsRoot, v1Id), { recursive: true })
  const v1Raw = new DatabaseSync(path.join(chatsRoot, v1Id, 'archive.db'))
  v1Raw.exec('CREATE TABLE archive_state (id INTEGER PRIMARY KEY CHECK (id = 1), chat_json TEXT NOT NULL, revision INTEGER NOT NULL)')
  v1Raw.prepare('INSERT INTO archive_state (id, chat_json, revision) VALUES (1, ?, ?)')
    .run(JSON.stringify(chatFixture(v1Id, [greeting(0), assistant(1), assistant(2)], 3)), 3)
  v1Raw.close()
  const migrated = await store.read(v1Id)
  assert.equal(migrated._storageRevision, 3, 'v1→v3 迁移保留 revision')
  assert.deepEqual(migrated.messages[1].variables, [tree(1)])
  assert.equal(store.variables.snapshot(v1Id).stat_data.轮次, 2, '迁移写入即建当前态')
  const v1Side = openSide(v1Id)
  assert.ok(v1Side.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='variable_snapshots'").get() !== undefined, '迁移后变量表在位')

  // ---------- ⑨ dispose：释放后禁写、读口不偷开句柄 ----------
  const doomed = openStore()
  const doomedId = 'chat-var-dispose'
  await doomed.update(doomedId, () => chatFixture(doomedId, [greeting(0), assistant(1)], 1))
  doomed.dispose()
  await assert.rejects(() => doomed.update(doomedId, current => current), /dispose/)
  await assert.rejects(() => doomed.remove(doomedId), /dispose/)
  assert.equal(doomed.variables.snapshot(doomedId), undefined, 'dispose 后不再打开句柄')
  assert.equal(existsSync(path.join(chatsRoot, doomedId, 'archive.db')), true, 'dispose 不删用户数据')

  // ---------- ⑩ 反方向：变量表 ABORT ⇒ 同一事务里**已经写过的 chat 侧**一起回滚 ----------
  //  ④ 是 chat 侧失败（archive_messages trigger）；这条是变量侧失败（variable_snapshots trigger）。
  //  写序是"先变量快照、后楼层行"，但头部键值**更早**就已写进 archive_head_fields ⇒
  //  变量失败后旧标题必须回来，才证明整笔（含已写部分）真的回滚，而不是各写各的。
  const rollbackId = 'chat-var-rollback'
  await store.update(rollbackId, () => chatFixture(rollbackId, [greeting(0), assistant(1)], 1))
  const rbSide = openSide(rollbackId)
  rbSide.exec(`CREATE TRIGGER fail_var_high_turn BEFORE INSERT ON variable_snapshots
    WHEN NEW.turn = 999 BEGIN SELECT RAISE(ABORT, 'var-sql-fail'); END`)
  const rbBefore = await store.read(rollbackId)
  const rbSnapshots = snapshotCount(rbSide)
  await assert.rejects(
    () => store.update(rollbackId, current => ({
      ...current, title: '不该落库的标题', _storageRevision: current._storageRevision + 1,
      // 两楼：2 号楼（turn 998）先成功插入快照，3 号楼（turn 999）才 ABORT ⇒
      // 计数不变才能证明"事务内**已经插入**的变量行"也一起回滚（不是只挡住最后一条）。
      messages: [
        ...current.messages,
        assistant(2, { turn: 998, trees: [tree(998)] }),
        assistant(3, { turn: 999, trees: [tree(999)] }),
      ],
    })),
    /var-sql-fail/,
  )
  rbSide.exec('DROP TRIGGER fail_var_high_turn')
  const rbAfter = await store.read(rollbackId)
  assert.equal(rbAfter.title, rbBefore.title, '变量失败必须回滚已经写过的 chat 头（同事务）')
  assert.equal(rbAfter._storageRevision, rbBefore._storageRevision, '变量失败不得推进 revision')
  assert.equal(rbAfter.messages.length, rbBefore.messages.length, '变量失败不得落楼')
  assert.equal(snapshotCount(rbSide), rbSnapshots, '变量侧也不得留半行')

  // ---------- ⑪ null swipe 槽：修剪后必须原样还原 null（不是 undefined/洞） ----------
  //  最小 fixture：1 号楼是 `[null, tree]`（选中 swipe 1），被 K4 修剪后再读 —— 第 0 槽必须是 null。
  const nullId = 'chat-var-nullswipe'
  const nullRow = {
    role: 'assistant', turn: 3, swipeId: 1, swipes: ['a', 'b'],
    variables: [null, treeOf(3, 2)], text: 'a',
  }
  await store.update(nullId, () => chatFixture(nullId, [
    greeting(0), nullRow, assistant(2), assistant(3), assistant(4), assistant(5), assistant(6), assistant(7),
  ], 1))
  const nullSide = openSide(nullId)
  assert.equal(Object.hasOwn(chatRow(nullSide, 1), 'variables'), false, '1 号楼应已被 K4 修剪')
  const nullRead = await store.read(nullId)
  assert.deepStrictEqual(nullRead.messages[1].variables, [null, treeOf(3, 2)], 'null 槽必须原样还原（不是 undefined）')
  assert.equal(nullRead.messages[1].variables[0], null)
  assert.equal(Object.hasOwn(nullRead.messages[1].variables, 0), true, '不是洞')
  assert.deepStrictEqual((await store.readWindow(nullId, { limit: 3, before: 2 })).chat.messages[1].variables, [null, treeOf(3, 2)], '窗口读口同样还原 null')

  console.log('variable-archive: ①②③④⑤⑥⑦⑧⑨⑩⑪ 全部断言通过')
} finally {
  for (const db of sides) { try { db.close() } catch { /* 已关 */ } }
  for (const instance of stores) { try { instance.dispose() } catch { /* 已释放 */ } }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
