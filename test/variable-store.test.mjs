// 路径说明：本测试随包走（test/ 下），store 在包根 ⇒ 用 ../ 相对路径。
// （2026-09-30 从 tools/lab-src-new/ 拉进包时曾写成 ./ ⇒ 在包内跑不起来；已修正。）
import { createVariableSqliteStore } from '../variable-sqlite-store.js'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert'

// P0 单测：快照链 / state 回拨 / 回退物理删除 / 幂等覆盖 / 迁移导入 / 删档 / 未初始化判空
const root = mkdtempSync(path.join(tmpdir(), 'vstore-test-'))
let passed = 0
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ok -', name) },
    error => { console.error('  FAIL -', name, '\n', error); process.exitCode = 1 })
}

const tree = turn => ({ stat_data: { 轮次: turn, 角色: { 好感度: turn * 10 } }, schema: 'x' })
const store = createVariableSqliteStore({ chatsRoot: root, logger: { warn() {} } })

await test('未初始化档 has/snapshot/snapshotAt 为空', () => {
  assert.strictEqual(store.has('chat-a'), false)
  assert.strictEqual(store.snapshot('chat-a'), undefined)
  assert.strictEqual(store.snapshotAt('chat-a', 99), undefined)
  assert.deepStrictEqual(store.deleteFrom('chat-a', 1), { deleted: 0, state: false })
})

await test('commitSettlement 写快照+state，可查可回放', () => {
  store.commitSettlement('chat-a', { turn: 3, tree: tree(3), operations: [{ op: 'set', path: '/stat_data/轮次', value: 3 }], uid: 'op-1' })
  store.commitSettlement('chat-a', { turn: 5, tree: tree(5), uid: 'op-2' })
  assert.strictEqual(store.has('chat-a'), true)
  assert.deepStrictEqual(store.snapshot('chat-a').stat_data.轮次, 5)
  assert.deepStrictEqual(store.snapshotAt('chat-a', 3).stat_data.轮次, 3)
  assert.deepStrictEqual(store.snapshotAt('chat-a', 5).stat_data.轮次, 5)
  assert.strictEqual(store.snapshotAt('chat-a', 2), undefined)
  assert.strictEqual(store.snapshotAt('chat-a', 4), undefined)
})

await test('同轮重复结算幂等覆盖（uid 更新）', () => {
  store.commitSettlement('chat-a', { turn: 5, tree: tree(50), uid: 'op-2-retry' })
  assert.deepStrictEqual(store.snapshot('chat-a').stat_data.角色.好感度, 500)
  const stats = store.stats('chat-a')
  assert.strictEqual(stats.snapshots.count, 2)
})

await test('updateState 只动 state 不加快照', () => {
  store.updateState('chat-a', { turn: 5, tree: tree(51) })
  assert.deepStrictEqual(store.snapshot('chat-a').stat_data.轮次, 51)
  assert.strictEqual(store.stats('chat-a').snapshots.count, 2)
})

await test('回退物理删除：state 回拨到幸存快照', () => {
  const result = store.deleteFrom('chat-a', 5)
  assert.deepStrictEqual(result, { deleted: 1, state: true })
  assert.deepStrictEqual(store.snapshot('chat-a').stat_data.轮次, 3)
  assert.strictEqual(store.snapshotAt('chat-a', 5), undefined)
  assert.deepStrictEqual(store.snapshotAt('chat-a', 3).stat_data.轮次, 3)
})

await test('回退到头：快照链清空则 state 清空（回到未初始化）', () => {
  assert.deepStrictEqual(store.deleteFrom('chat-a', 1), { deleted: 1, state: false })
  assert.strictEqual(store.has('chat-a'), false)
  assert.strictEqual(store.snapshot('chat-a'), undefined)
})

await test('importSnapshots 迁移导入并置 state', () => {
  store.importSnapshots('chat-b', [
    { turn: 1, source: 'import', tree: tree(1) },
    { turn: 2, source: 'import', tree: tree(2) },
    { turn: 4, source: 'import', tree: tree(4) }
  ])
  assert.deepStrictEqual(store.snapshot('chat-b').stat_data.轮次, 4)
  assert.deepStrictEqual(store.snapshotAt('chat-b', 2).stat_data.轮次, 2)
  assert.strictEqual(store.snapshotAt('chat-b', 3), undefined)
})

await test('drop 删除库文件与句柄', () => {
  assert.strictEqual(existsSync(path.join(root, 'chat-b', 'variables.db')), true)
  store.drop('chat-b')
  assert.strictEqual(existsSync(path.join(root, 'chat-b', 'variables.db')), false)
  assert.strictEqual(store.has('chat-b'), false)
})

await test('回退后重新结算继续快照链', () => {
  store.commitSettlement('chat-c', { turn: 2, tree: tree(2), uid: 'c2' })
  store.commitSettlement('chat-c', { turn: 3, tree: tree(3), uid: 'c3' })
  store.deleteFrom('chat-c', 3)
  store.commitSettlement('chat-c', { turn: 3, tree: tree(33), uid: 'c3-new' })
  assert.deepStrictEqual(store.snapshot('chat-c').stat_data.轮次, 33)
  assert.deepStrictEqual(store.snapshotAt('chat-c', 2).stat_data.轮次, 2)
})

await test('非法 chatId 拒绝', () => {
  assert.throws(() => store.has('../evil'), /不合法/)
  assert.throws(() => store.has('a/b'), /不合法/)
})

await test('大批量导入性能冒烟（500 轮 × 20KB 树）', () => {
  const bigTree = turn => ({ stat_data: { 轮次: turn, 大对象: Array.from({ length: 200 }, (_, i) => ({ 键: i, 值: 'x'.repeat(50) })) }, schema: 'x' })
  const t0 = Date.now()
  for (let turn = 1; turn <= 500; turn++) store.commitSettlement('chat-perf', { turn, tree: bigTree(turn), uid: 'p' + turn })
  const elapsed = Date.now() - t0
  const t1 = Date.now()
  const snap = store.snapshot('chat-perf')
  const snapAt = store.snapshotAt('chat-perf', 250)
  const readElapsed = Date.now() - t1
  console.log(`    500 轮提交 ${elapsed}ms（${(elapsed / 500).toFixed(2)}ms/轮），读 ${readElapsed}ms`)
  assert.ok(elapsed < 30000, '提交耗时可接受')
  assert.deepStrictEqual(snap.stat_data.轮次, 500)
  assert.deepStrictEqual(snapAt.stat_data.轮次, 250)
  const t2 = Date.now()
  store.deleteFrom('chat-perf', 400)
  console.log(`    回退删除 ${Date.now() - t2}ms`)
  assert.strictEqual(store.stats('chat-perf').snapshots.count, 399)
})

await test('snapshotAll 批量读取 + 缓存 + 写时失效', () => {
  store.importSnapshots('chat-d', [{ turn: 1, source: 'import', tree: tree(1) }, { turn: 3, source: 'import', tree: tree(3) }])
  const map1 = store.snapshotAll('chat-d')
  assert.ok(map1 instanceof Map)
  assert.strictEqual(map1.size, 2)
  assert.deepStrictEqual(map1.get(3).stat_data.轮次, 3)
  // 缓存命中：删除数据库文件后仍能读到（说明来自缓存）
  store.drop('chat-d')
  const map2 = store.snapshotAll('chat-d')
  assert.strictEqual(map2, undefined) // drop 后缓存已失效且无库
  // 未初始化档
  assert.strictEqual(store.snapshotAll('chat-none'), undefined)
})

store.dispose()
rmSync(root, { recursive: true, force: true })
console.log(process.exitCode ? 'FAILED' : `ALL ${passed} PASSED`)
