// 真实最新酒馆菜单组件经正式client链：入口归并、同步互斥、目标透传和缺桥拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { clientCoreWrites } from '../deploy/client-seams.mjs'
import { applyRollbackMenuTransform } from '../deploy/rollback-menu-transform.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
const ROOT = fileURLToPath(new URL('../../../tmp/adapt-65401-pr17/dsh-tavern-65401c0f67465acd3988f65e6c33881c40189dd0/', import.meta.url))
const writes = () => clientCoreWrites(ROOT)
const feature = 'tavern-plugin/src/client/features/play-controls.js'
function component(source, { view, running = false, request, clean, retry = null } = {}) {
  const calls = [], refs = [], states = []
  const React = { createElement: (type, props, ...children) => ({ type, props, children }), useState: initial => {
    const isRetry = states.length === 1
    states.push(initial)
    return [isRetry ? retry : initial, next => calls.push(['state', next])]
  }, useRef: value => { const ref = { current: value }; refs.push(ref); return ref }, useEffect: () => {} }
  const context = {
    React, useRegenPanel: () => null, latestTavernAssistantMessageId: () => 'assistant',
    useLiveTavernView: () => ({ view }), useTavernCoordination: () => ({ view: { activity: view.activity || {} } }),
    describeTavernActivity: value => value, rpc: async (...args) => { calls.push(['rpc', ...args]); return request(...args) },
    historyProjection: { rolledBack: (...args) => calls.push(['projection', ...args]) },
    setCandidatePanel: () => calls.push(['panel']), setRegenPanel: () => {}, setCandidateGuidePanel: () => {},
    tavernErrorHub: { report: (...args) => calls.push(['error', ...args]) },
    liveTavernView: { rebase: () => calls.push(['rebase']), invalidate: () => calls.push(['invalidate']) },
    tavernCoordination: { invalidate: () => calls.push(['coord']) },
  }
  const begin = source.indexOf('function TavernRollbackAction(props)'), end = source.indexOf('function TavernUndoRollbackAction(props)', begin)
  assert.ok(begin >= 0 && end > begin)
  const fn = vm.runInNewContext('(' + source.slice(begin, end).trim() + ')', context)
  const props = { sessionId: 'session-a', useSession: select => select({ running }), useChat: () => 'assistant',
    sessions: { waitForTavernRollbackSync: async sync => calls.push(['wait', sync]) },
    storageUi: () => clean ? { cleanFailure: async (...args) => { calls.push(['clean', ...args]); return clean(...args) } } : undefined,
  }
  return { button: fn(props), calls }
}
const target = { kind: 'rollback', turn: 25, chatId: 'chat-a', sessionId: 'session-a', branchId: 'branch-a', revision: 7, operationId: 'body-25', nativeAnchor: { version: 1, start: 8, input: 9 } }
const viewOf = incomplete => ({ canRollback: true, canClearIncompleteReply: incomplete, rollbackTargetTurn: 25, rollbackTarget: target, activity: { busy: true, phase: 'running', role: 'settlement' } })

test('更多回退：正式source/built同链、二次幂等且常驻撤销条不再注册', () => {
  const out = writes()
  for (const rel of [feature, 'tavern-plugin/lib/client.js']) {
    const source = out.get(rel)
    assert.match(source, /\[dsh-tavern-rollback-menu:v1\]/)
    assert.match(source, /React\.createElement\(TavernRollbackAction, props\)/)
    assert.equal(applyRollbackMenuTransform(source), source)
    parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  }
  const ui = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(ui, /FailureCleanupStrip|dsh-sqlite-save__failure-strip|撤销最新发送|name: 'conversation\.input\.dock'/)
  assert.match(ui, /async cleanFailure\(/)
  assert.match(ui, /conversation\.session\.header\.utilities/)
  parse(ui, { ecmaVersion: 'latest', sourceType: 'script' })
  assert.deepEqual([...clientCoreWrites(ROOT, { sourceReader: rel => out.get(rel) ?? fs.readFileSync(ROOT + rel, 'utf8') })], [...out])
})

test('更多回退：完成或在途统一目标可点，精确凭据和同连接等待不变', async () => {
  const source = writes().get(feature)
  for (const running of [false, true]) {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const h = component(source, { view: viewOf(false), running, request: async () => { await gate; return { view: { rolledBack: { sync: 'sync-a' } } } } })
    assert.equal(h.button.props.role, 'menuitem')
    assert.equal(h.button.props.disabled, false)
    assert.equal(h.button.children[0], '回退第 25 轮')
    const first = h.button.props.onClick(), second = h.button.props.onClick()
    assert.equal(h.calls.filter(c => c[0] === 'rpc').length, 1, '同步ref防同帧双击，不等React重绘')
    const args = h.calls.find(c => c[0] === 'rpc')
    assert.equal(args[1], 'rollbackTurn'); assert.equal(args[2].expectedTurn, target); assert.equal(args[3], 'session-a')
    release(); await Promise.all([first, second])
    assert.deepEqual(h.calls.filter(c => c[0] === 'wait'), [['wait', 'sync-a']])
    assert.equal(h.calls.filter(c => c[0] === 'error').length, 0)
  }
})

test('更多回退：未完成发送只委托共享清理、缺桥拒绝且无目标不猜删', async () => {
  const source = writes().get(feature)
  let release
  const gate = new Promise(resolve => { release = resolve })
  const h = component(source, { view: viewOf(true), running: true, request: () => { throw Error('不该直接RPC') }, clean: async () => { await gate; return { view: { rolledBack: { rolledBackTarget: target } } } } })
  assert.equal(h.button.props.disabled, false)
  assert.equal(h.button.children[0], '回退第 25 轮（未完成发送）')
  const first = h.button.props.onClick(), second = h.button.props.onClick()
  const calls = h.calls.filter(c => c[0] === 'clean')
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].slice(1), ['session-a', 25, target])
  release(); await Promise.all([first, second])
  assert.equal(h.calls.filter(c => ['rpc', 'wait'].includes(c[0])).length, 0, '等待归共享服务，不重复等待')
  const missing = component(source, { view: viewOf(true) })
  await missing.button.props.onClick()
  assert.match(String(missing.calls.find(c => c[0] === 'error')?.[2]), /精简清理未接线/)
  assert.equal(missing.calls.filter(c => ['rpc', 'clean'].includes(c[0])).length, 0)
  const empty = component(source, { view: { canRollback: false, rollbackUnavailableReason: '没有可回退轮次' } })
  assert.equal(empty.button.props.disabled, true)
  assert.equal(empty.button.props.onClick, undefined)
})
