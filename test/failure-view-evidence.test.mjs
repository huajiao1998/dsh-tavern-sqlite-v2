// 冷视图失败证据：真函数 + 真 Symbol.dispose 释放语义；不建 Session/Agent、不跑浏览器、不触网。
import test from 'node:test'
import assert from 'node:assert/strict'
import {isLiveFailureEvidence, readFailureEvidence, requireFailureEvidenceQuery} from '../lib/failure-view-evidence.js'
import {resolveFailureEvidence} from '../lib/session-window-projector.js'

function lease(id, events, release) {
  return {header: {id}, events, [Symbol.dispose]: release}
}

test('失败视图证据1 冷视图只读观察：live直用 / cold lease 形状与释放 / 缺观察口·身份不符·事件非数组皆响亮失败', async () => {
  const calls = []
  let released = 0
  const sessionQuery = {observeSession: async (id, options) => { calls.push([id, options]); return lease(id, [{seq: 0}], () => { released++ }) }}
  // live：原样返回，绝不额外观察
  const live = {sessionId: 's1', loaded: true, session: {snapshotEvents: () => [{seq: 0}]}, events: [{seq: 0}]}
  assert.equal(await readFailureEvidence(live, sessionQuery, 's1'), live)
  assert.deepEqual(calls, [])
  assert.equal(isLiveFailureEvidence(live), true)
  assert.equal(isLiveFailureEvidence({sessionId: 's1', loaded: false, events: []}), false)
  // cold：观察一次、形状 exact、释放恰一次
  const cold = {sessionId: 's1', loaded: false, events: []}
  const evidence = await readFailureEvidence(cold, sessionQuery, 's1')
  assert.deepEqual(calls, [['s1', {projectionMode: 'none'}]])
  assert.deepEqual(Object.keys(evidence).sort(), ['events', 'header', 'loaded', 'session', 'sessionId'])
  assert.equal(evidence.sessionId, 's1')
  assert.equal(evidence.loaded, true)
  assert.equal(evidence.session, null)
  assert.equal(evidence.header.id, 's1')
  assert.deepEqual(evidence.events, [{seq: 0}])
  assert.equal(released, 1)
  // 身份不符 / 事件非数组：抛错且仍然释放（finally 真调用）
  await assert.rejects(() => readFailureEvidence(cold, {observeSession: async () => lease('other', [], () => { released++ })}, 's1'), /会话身份不一致/)
  await assert.rejects(() => readFailureEvidence(cold, {observeSession: async () => lease('s1', 'nope', () => { released++ })}, 's1'), /未返回事件数组/)
  assert.equal(released, 3)
  // 缺观察口：响亮失败，绝不退回收窄摘要
  assert.throws(() => requireFailureEvidenceQuery(null), /缺少宿主只读观察接口/)
  await assert.rejects(() => readFailureEvidence(cold, {}, 's1'), /缺少宿主只读观察接口/)
  // 缺释放方法：读取前即抛（不留半观察）；dispose 抛错不得被吞
  await assert.rejects(() => readFailureEvidence(cold, {observeSession: async () => ({header: {id: 's1'}, events: []})}, 's1'), /缺少释放方法/)
  await assert.rejects(() => readFailureEvidence(cold, {observeSession: async () => ({header: {id: 's1'}, events: [], [Symbol.dispose]: () => { throw new Error('释放失败') }})}, 's1'), /释放失败/)
})

test('失败视图证据2 投影读口 resolveFailureEvidence：注入优先 / 冷档缺DI响亮失败 / 旧夹具无loaded保持旧形状', async () => {
  const seen = []
  const withInjected = value => name => name === 'readFailureEvidence' ? value : undefined
  const injected = async sessionId => {
    seen.push(sessionId)
    return {sessionId, loaded: true, events: [{seq: 0}], header: {id: sessionId}, session: null}
  }
  const viaInjected = await resolveFailureEvidence(withInjected(injected), 's1')
  assert.deepEqual(seen, ['s1'], '注入的读口必须收到 sessionId')
  assert.equal(viaInjected.events.length, 1)
  // 冷档（作者证据明确 loaded:false）缺 DI：响亮失败，不用空事件冒充失败尾
  const legacyOnly = fn => name => name === 'sessionDebugEvidence' ? fn : undefined
  await assert.rejects(() => resolveFailureEvidence(legacyOnly(() => ({sessionId: 's1', loaded: false, events: []})), 's1'), /缺少 readFailureEvidence 接线/)
  // 旧夹具：live 形状（loaded!==false 且有 Session）与完全旧形状（undefined）都保持原样返回
  const liveShape = await resolveFailureEvidence(legacyOnly(() => ({sessionId: 's1', loaded: true, session: {snapshotEvents: () => []}, events: []})), 's1')
  assert.equal(liveShape.loaded, true)
  assert.equal(await resolveFailureEvidence(legacyOnly(() => undefined), 's1'), undefined)
})
