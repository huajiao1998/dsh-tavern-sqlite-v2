// 作者2.4 Shared helper 变量契约（author__lib__client.js:6957–7016）的定向断言。
// 只覆盖本轮已确认的三小项：getAllVariables 合并顺序/不遍历消息、deleteVariable 返回契约与"不存在不伪删除"。
// lodash 走仓库内已存在的**真实实现**（tools/mvu-server-core/node_modules/lodash，与
// server-dependencies.js 的 require('lodash') 同一实现），不自造桩、不 npm 安装。
// 与同目录 tavern-helper-api.test.mjs 取用同一份 lodash。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createTavernHelperExtensions } from '../lib/tavern-helper-api.js'

const require = createRequire(import.meta.url)
const lodash = require('../../../tools/mvu-server-core/node_modules/lodash/lodash.js')
const { unset, mergeWith } = lodash
assert.equal(typeof unset, 'function', '需要真实 lodash.unset')
assert.equal(typeof mergeWith, 'function', '需要真实 lodash.mergeWith')

// 内存宿主：按 scope 存变量，写口记录调用并真的落值；读口返回**真身**（用于验证包装层是否隔离拷贝）。
function harness(seed = {}) {
  const store = { global: {}, character: {}, chat: {}, script: {}, message: {} }
  for (const [scope, value] of Object.entries(seed)) store[scope] = value
  const calls = []
  let open = true
  let revision = 0
  const readOpen = () => {
    if (!open) throw new Error('卡脚本读窗口已关闭')
    return { sessionId: 's1', chat: { messages: seed.messages || [] } }
  }
  const requireOpen = () => { const c = readOpen(); return c }
  const getVariables = option => {
    const scope = option?.type || 'message'
    if (scope === 'message') return store.message[option.message_id] || {}
    return store[scope] || {}
  }
  const replaceVariables = async (variables, option) => {
    const scope = option?.type || 'message'
    if (scope === 'message') store.message[option.message_id] = variables
    else store[scope] = variables
    revision += 1
    calls.push({ scope, variables })
    return { updated: true, stateRevision: revision }
  }
  const api = createTavernHelperExtensions({ getVariables, replaceVariables, readOpen, requireOpen,
    assertOpen() {}, lodash, currentScriptId: () => 'script-a' })
  return { api, store, calls, close() { open = false } }
}

test('getAllVariables 按 global→character→script→chat 合并，不遍历聊天消息', () => {
  const run = harness({
    global: { g: 1, shared: 'global', only_global: true },
    character: { c: 2, shared: 'character' },
    script: { s: 3, shared: 'script' },
    chat: { t: 4, shared: 'chat' },
    messages: [
      { message_id: 0, variables: { from_message: 'm0', shared: 'm0' } },
      { message_id: 1, variables: { from_message: 'm1' } },
    ],
  })
  const all = run.api.getAllVariables()
  assert.deepEqual(Object.keys(all).sort(), ['c', 'g', 'only_global', 's', 'shared', 't'])
  // 后写覆盖先写：script 压 character，chat 压 script。
  assert.equal(all.shared, 'chat')
  // 消息变量不得掺入（旧实现会把每条消息 merge 进来，污染共享沙箱视图）。
  assert.equal('from_message' in all, false)
  assert.deepEqual(run.calls, [], '纯读不产生写')
})

test('getAllVariables 返回隔离拷贝，改返回值不污染宿主真身', () => {
  const run = harness({ global: { nested: { hp: 10 }, list: [1, 2] } })
  const all = run.api.getAllVariables()
  all.nested.hp = 999
  all.list.push(3)
  all.injected = true
  assert.deepEqual(run.store.global, { nested: { hp: 10 }, list: [1, 2] })
  assert.equal(run.api.getAllVariables().injected, undefined)
})

test('deleteVariable 返回 {variables, delete_occurred}，删除真的发生时标志为真', async () => {
  const run = harness({ global: { keep: 1, drop: { deep: { x: 7 }, y: 2 } } })
  const receipt = await run.api.deleteVariable('drop.deep.x', { type: 'global' })
  assert.deepEqual(Object.keys(receipt).sort(), ['delete_occurred', 'variables'])
  assert.equal(receipt.delete_occurred, true)
  assert.deepEqual(receipt.variables, { keep: 1, drop: { deep: {}, y: 2 } })
  // 返回的 variables 必须是拷贝：改回执不影响落库内容。
  receipt.variables.keep = 'tampered'
  assert.equal(run.store.global.keep, 1)
  assert.equal(run.calls.length, 1)
  assert.deepEqual(run.calls[0].variables, { keep: 1, drop: { deep: {}, y: 2 } })
})

test('deleteVariable 路径不存在时按 lodash 规定返回 true，但变量树不变', async () => {
  const run = harness({ global: { keep: 1 } })
  const receipt = await run.api.deleteVariable('absent.deep.path', { type: 'global' })
  // 作者client:7010–7016：delete_occurred 直接取 lodash unset 的返回值；
  // lodash 规定「路径不存在时 unset 也返回 true」（它报告的是"按该路径执行删除"），
  // 因此这里必须是 true，不能按"真的删掉了"重定义成 false。
  assert.equal(unset({ keep: 1 }, 'absent.deep.path'), true)
  assert.equal(receipt.delete_occurred, true)
  // 标志为 true 并不代表树变了：路径不存在时实际内容原样保留。
  assert.deepEqual(receipt.variables, { keep: 1 })
  assert.deepEqual(run.store.global, { keep: 1 })
  // 作者 client:7010–7016 仍调用 replaceVariables；我们保持同一调用序列，不吞掉写。
  assert.equal(run.calls.length, 1)
  assert.deepEqual(run.calls[0].variables, { keep: 1 })
})

test('deleteVariable 走真实 lodash 的数组/深层路径语义，并保 scope 与 CAS', async () => {
  const run = harness({ chat: { list: [{ a: 1 }, { a: 2 }], other: true } })
  const receipt = await run.api.deleteVariable('list[0].a', { type: 'chat' })
  assert.equal(receipt.delete_occurred, true)
  assert.deepEqual(receipt.variables, { list: [{}, { a: 2 }], other: true })
  assert.equal(run.calls[0].scope, 'chat')

  const closed = harness({ global: { keep: 1 } })
  closed.close()
  await assert.rejects(() => closed.api.deleteVariable('keep', { type: 'global' }), /读窗口已关闭/)
})

test('deleteVariable 不复用全树 JSON 编码：源码该段无 JSON.stringify', () => {
  // 负断言：早期实现用 JSON.stringify 全变量树做 before/after 对比（并 copy(JSON.stringify(...))），
  // 属于 noJSONdebt 禁止的"整档文本往返"，且把 delete_occurred 从 lodash 返回值改成"全树 diff"语义。
  // 该段必须只依赖 lodash unset 的结果。
  const source = readFileSync(new URL('../lib/tavern-helper-api.js', import.meta.url), 'utf8')
  const start = source.indexOf('deleteVariable: async')
  const end = source.indexOf('getAllVariables:', start)
  assert.ok(start > -1 && end > start, '需要定位到 deleteVariable 段落')
  const segment = source.slice(start, end)
  assert.equal(segment.includes('JSON.stringify'), false, 'deleteVariable 段不得出现 JSON.stringify')
  assert.ok(segment.includes('delete_occurred'), 'deleteVariable 段应返回 delete_occurred')
})
