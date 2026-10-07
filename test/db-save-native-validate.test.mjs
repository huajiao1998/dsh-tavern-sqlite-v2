// 只验backend dbSaveValidate 的实际接线（fake wire）：源码截取方法体 + fake patch，不 import SDK/业务、不建真实Session。
// ⚠ 本文件 stored 是**合成 wire 输入**，不是合法 native protocol 夹具：seq 非 0..连续、type/字段形状为合成
//   （真实为 assistant/message、surfaceOp 为对象）、meta.patchMarker 不是 required event。
// 断言目的仅为「输入原样传给同代 ready 补丁、无写/无状态变化、非法接线必抛」，**不代表真实 SDK/宿主通过**。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const HEAD = '\tdbSaveValidate(stored) {'
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const start = source.indexOf(HEAD)
assert.ok(start > 0, '未找到 dbSaveValidate 源码（消费者协议变更需人工复核）')
const end = source.indexOf('\n\t}', start)
assert.ok(end > start, '未找到 dbSaveValidate 方法结束边界')
const body = source.slice(start + HEAD.length, end)
assert.ok(body.includes('缺少同代原生事件严格解码接线') && body.includes('原生解码身份不一致'), '提取体不是真实方法')
// 只准同代 ready 补丁：方法体不得自带 stock validate / 建 Session / resume / 新 agent 字段
for (const forbidden of ['Session.create', 'agents.create', '.resume(', 'newAgent', 'validateStored']) assert.equal(body.includes(forbidden), false, '方法体含禁止路径：' + forbidden)
const KEY = Symbol.for('dsh-tavern.host-session-patch.v1')
const makeValidate = new Function('return function dbSaveValidate(stored) {' + body + '}')
// 合成 wire 输入（非合法 native protocol）：只用于验证透传与守卫，不做 schema 自证。
function stored() {
  return {
    header: { id: 'session-native-x', source: 'source-chat-x', cwd: '/source' },
    inheritedEventCount: 2,
    events: [
      { seq: 2, type: 'turn/start', time: 3, data: { turn: 2 }, surfaceOp: 'append', sourceEventSeqs: [0, 1] },
      { seq: 3, type: 'message/assistant', time: 4, data: { turn: 2, content: [{ type: 'image', imageAttachmentRef: { attachmentId: 'img-1', mediaType: 'image/png', width: 4, height: 4, bytes: 8, name: 'a.png' } }] }, surfaceOp: 'append', sourceEventSeqs: [1] }
    ],
    meta: { patchMarker: 'dsh-tavern.host-session-patch.v1' }
  }
}
function harness({ serverReady = true, restore, id } = {}) {
  const received = []
  const patch = { serverReady }
  if (restore !== null) patch.restoreStoredSession = restore ?? (value => { received.push(structuredClone(value)); return { id: id ?? value.header.id } })
  const host = { [KEY]: patch }
  return { received, host, validate: makeValidate() }
}
test('DB交换原生严格预检只用同代ready补丁且不改继承上下文', () => {
  const value = stored(), snapshot = structuredClone(value)
  // 一次 validate：原样收到副本、返回 true、无写/状态变化
  const ready = harness()
  assert.equal(ready.validate.call(ready.host, value), true)
  assert.equal(ready.received.length, 1)
  assert.deepEqual(ready.received[0], snapshot)
  assert.deepEqual(value, snapshot, 'validate 修改了传入 stored')
  assert.equal(value.inheritedEventCount, 2)
  assert.deepEqual(value.events.map(event => event.seq), [2, 3])
  assert.deepEqual(value.events[1].data.content[0].imageAttachmentRef, { attachmentId: 'img-1', mediaType: 'image/png', width: 4, height: 4, bytes: 8, name: 'a.png' })
  // serverReady=false / 无 restoreStoredSession / 返回错id 必须抛
  const notReady = harness({ serverReady: false })
  assert.throws(() => notReady.validate.call(notReady.host, value), /缺少同代原生事件严格解码接线/)
  const noRestore = harness({ restore: null })
  assert.throws(() => noRestore.validate.call(noRestore.host, value), /缺少同代原生事件严格解码接线/)
  const wrongId = harness({ id: 'session-other' })
  assert.throws(() => wrongId.validate.call(wrongId.host, value), /原生解码身份不一致/)
  // 补丁自身严格校验抛错必须原样冒泡，不被忽略
  const throwing = harness({ restore: () => { throw Error('同代补丁严格解码失败：extra 字段非法') } })
  assert.throws(() => throwing.validate.call(throwing.host, value), /同代补丁严格解码失败/)
  // 失败路径同样不改原 stored
  assert.deepEqual(value, snapshot)
})
