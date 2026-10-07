// 只验backend dbSaveFinish(ids) 的批量提交协议：从 index.js 源码提取该方法体，用 Function+fake this/store 运行，不 import SDK/业务。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const HEAD = '\tdbSaveFinish(ids) {'
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf(HEAD)
assert.ok(start > 0, '未找到 dbSaveFinish 源码（消费者协议变更需人工复核）')
const end = source.indexOf('\n\t}', start)
assert.ok(end > start, '未找到 dbSaveFinish 方法结束边界')
const body = source.slice(start + HEAD.length, end)
// 固定字面确认提取的是真实方法体（不是本地等价实现）
assert.ok(body.includes('DB发布目标集合无效') && body.includes('DB目标未归属本次导入'))
const makeFinish = new Function('dbSaveTargets', 'return function dbSaveFinish(ids) {' + body + '}')
function harness(owned) {
  const dbSaveTargets = new Map(owned)
  const files = new Map([['session-a', '/n/a.db'], ['session-b', '/n/b.db']])
  const store = { pathOf(id) { if (!files.has(id)) throw Error('pathOf 未知目标：' + id); return files.get(id) } }
  return { dbSaveTargets, store, finish: makeFinish(dbSaveTargets) }
}
test('DB导入原生目标批量提交前置完整归属校验', () => {
  // A 已归属本次导入、B 未归属：抛错且 A 归属仍在（仍可回收）
  const h = harness([['/n/a.db', 'session-a']])
  assert.throws(() => h.finish.call({ store: h.store }, ['session-a', 'session-b']), /未归属本次导入/)
  assert.equal(h.dbSaveTargets.get('/n/a.db'), 'session-a')
  // 空集合与重复 id 一律拒绝，且不改状态
  assert.throws(() => h.finish.call({ store: h.store }, []), /集合无效/)
  assert.throws(() => h.finish.call({ store: h.store }, ['session-a', 'session-a']), /集合无效/)
  assert.throws(() => h.finish.call({ store: h.store }, 'session-a'), /集合无效/)
  assert.equal(h.dbSaveTargets.get('/n/a.db'), 'session-a')
  // pathOf 中途抛：全量预检前即失败，无任何归属变化
  assert.throws(() => h.finish.call({ store: h.store }, ['session-a', 'session-missing']), /pathOf 未知目标/)
  assert.equal(h.dbSaveTargets.get('/n/a.db'), 'session-a')
  // A/B 同批合法：一次调用解除全部归属（不逐项 finish 留中间态）
  h.dbSaveTargets.set('/n/b.db', 'session-b')
  h.finish.call({ store: h.store }, ['session-a', 'session-b'])
  assert.equal(h.dbSaveTargets.has('/n/a.db'), false)
  assert.equal(h.dbSaveTargets.has('/n/b.db'), false)
})
