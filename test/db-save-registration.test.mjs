// 只验DB导入失败补偿：只撤本次新身份的两个登记文件，两文件各自独立尝试并汇总失败。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDbSaveRegistration } from '../lib/db-save-registration.js'
function seed() {
  return {
    'index.json': { chats: [{ id: 'chat-old', title: '旧局' }, { id: 'chat-new', title: '本次新局' }] },
    'sessions.json': { 'session-old': 'chat-old', 'session-new': 'chat-new', 'session-alias': 'chat-old' }
  }
}
function store(values, fail = []) {
  const writes = []
  return {
    values, writes,
    async updateJson(file, updater) {
      writes.push(file)
      if (fail.includes(file)) throw Error('模拟写失败：' + file)
      const next = await updater(values[file])
      if (next !== undefined) values[file] = next
      return next
    }
  }
}
test('DB导入登记补偿只删本次新身份', async () => {
  const values = seed(), s = store(values)
  const registration = createDbSaveRegistration({ store: s })
  await registration.discard({ chatId: 'chat-new', sessionId: 'session-new' })
  assert.deepEqual(values['index.json'].chats.map(row => row.id), ['chat-old'])
  assert.deepEqual(values['sessions.json'], { 'session-old': 'chat-old', 'session-alias': 'chat-old' })
  assert.deepEqual(s.writes, ['index.json', 'sessions.json'])
  // 已删净或sessionId不属于本次新chat时不再写：别名与源档关系保留
  await registration.discard({ chatId: 'chat-new', sessionId: 'session-old' })
  assert.deepEqual(values['index.json'].chats.map(row => row.id), ['chat-old'])
  assert.deepEqual(values['sessions.json'], { 'session-old': 'chat-old', 'session-alias': 'chat-old' })
})
test('DB导入登记补偿逐项尝试并报告失败', async () => {
  const values = seed(), s = store(values, ['index.json', 'sessions.json'])
  await assert.rejects(() => createDbSaveRegistration({ store: s }).discard({ chatId: 'chat-new', sessionId: 'session-new' }), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    assert.match(error.message, /登记补偿未完成/)
    return true
  })
  assert.deepEqual(s.writes, ['index.json', 'sessions.json'])
  assert.deepEqual(values, seed())
  // 首个失败不跳过第二个：index 抛错时 sessions 仍须被撤，并只报一条失败
  const partial = store(seed(), ['index.json'])
  await assert.rejects(() => createDbSaveRegistration({ store: partial }).discard({ chatId: 'chat-new', sessionId: 'session-new' }), error => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 1)
    return true
  })
  assert.deepEqual(partial.writes, ['index.json', 'sessions.json'])
  assert.deepEqual(partial.values['sessions.json'], { 'session-old': 'chat-old', 'session-alias': 'chat-old' })
})
