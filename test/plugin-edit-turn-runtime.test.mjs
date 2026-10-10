// a2008 实际调用 DI 执行：用**缓存真源** tmp/upstream-a2008-review-20261010/api/index.js 跑真 applyBodyEditEventTransform，
// 再从变换结果里**提取真实注入的 editText 表达式**（花括号配对，非手写同体）以**参数 DI 构造**（new Function 仅注入依赖，非 VM 沙箱）执行，核真实调用顺序/次数/失败传播。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyBodyEditEventTransform } from '../deploy/core-host-transform.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const cachedIndex = path.join(workspace, 'tmp/upstream-a2008-review-20261010/api/index.js')
assert.ok(existsSync(cachedIndex), '需要缓存的 a2008 真源：' + cachedIndex + '（只读，不重新下载）')

/** 花括号配对取一段真实源码（用于从变换结果里提取真注入表达式）。 */
function sliceBraced(text, header) {
  const start = text.indexOf(header)
  assert.ok(start >= 0, '应能定位 ' + header)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error('花括号不平衡：' + header)
}

const transformed = applyBodyEditEventTransform(readFileSync(cachedIndex, 'utf8'))
const editBlock = sliceBraced(transformed, 'editText: async (material, text) =>')

/** 用真注入源码做参数 DI 构造（依赖全走形参注入；非虚拟机、非手写同体）。 */
function loadInjectedEditText(di) {
  const factory = new Function(
    'bodyEditor', 'notifyPluginTimeline', 'readSessionMap', 'chatPersistence', 'chatForSession', 'tavernScriptHostAdapter',
    'return ({ ' + editBlock + ' }).editText',
  )
  return factory(di.bodyEditor, di.notifyPluginTimeline, di.readSessionMap, di.chatPersistence, di.chatForSession, di.tavernScriptHostAdapter)
}
function deferred() { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no }); return { promise, resolve, reject } }

test('正文编辑事件：真实a2008源码注入体DI执行（顺序/一次/失败不派发）', async () => {
  // ① 正文变化：before 窗口 → replaceText（deferred，未决前不得继续）→ notify 恰一次 → after 窗口 → dispatch（deferred 且被 await）
  const order = []
  const replaceGate = deferred(), dispatchGate = deferred()
  const fen = {
    bodyEditor: { replaceText: async (sessionId, text) => { order.push(['replaceText', sessionId, text]); await replaceGate.promise } },
    notifyPluginTimeline: (...args) => { order.push(['notify', ...args]) },
    readSessionMap: async () => ({ 'sess-1': 'chat-1' }),
    chatPersistence: {
      readWindow: async (chatId, options) => {
        order.push(['readWindow', chatId, JSON.stringify(options)])
        return order.filter(item => item[0] === 'readWindow').length === 1
          ? { chat: { messages: [{ text: 'old' }] }, to: 42 }
          : { chat: { messages: [{ text: 'new' }] }, to: 42 }
      },
    },
    chatForSession: async sessionId => { order.push(['chatForSession', sessionId]); return { id: 'chat-1', sessionId } },
    tavernScriptHostAdapter: { dispatchServerEvent: async payload => { order.push(['dispatch', payload.event, JSON.stringify(payload.args)]); await dispatchGate.promise } },
  }
  const editText = loadInjectedEditText(fen)
  let settled = false
  const running = editText({ sessionId: 'sess-1' }, 'new text').then(() => { settled = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order.map(item => item[0]), ['readWindow', 'replaceText'], '未决的 replaceText 之前不得继续（deferred 生效）：' + JSON.stringify(order))
  replaceGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order.map(item => item[0]), ['readWindow', 'replaceText', 'notify', 'readWindow', 'chatForSession', 'dispatch'], '顺序错误：' + JSON.stringify(order))
  assert.equal(order.filter(item => item[0] === 'notify').length, 1, '作者 notify 必须恰一次')
  assert.deepEqual(order[0], ['readWindow', 'chat-1', '{"limit":1}'], 'before 必须按 limit:1 读最后一楼')
  assert.deepEqual(order[3], ['readWindow', 'chat-1', '{"limit":1}'], 'after 同样 limit:1')
  assert.equal(order[5][2], '[42]', 'dispatch 必须带作者协议的楼层号 after.to（integer 协议）')
  assert.equal(settled, false, 'dispatch 未决前外层不得提前返回（必须 await）')
  dispatchGate.resolve()
  await running
  assert.equal(settled, true)

  // ② 正文未变：notify 仍一次，但不派发
  const same = []
  const unchanged = loadInjectedEditText({
    bodyEditor: { replaceText: async () => { same.push('replaceText') } },
    notifyPluginTimeline: () => { same.push('notify') },
    readSessionMap: async () => ({ 'sess-1': 'chat-1' }),
    chatPersistence: { readWindow: async () => ({ chat: { messages: [{ text: 'same' }] }, to: 42 }) },
    chatForSession: async () => { same.push('chatForSession'); return {} },
    tavernScriptHostAdapter: { dispatchServerEvent: async () => { same.push('dispatch') } },
  })
  await unchanged({ sessionId: 'sess-1' }, 'same')
  assert.deepEqual(same, ['replaceText', 'notify'], '正文未变不得派发、不得取 chat：' + JSON.stringify(same))

  // ③ 保存失败：notify 与 dispatch 都不得发生，错误必须传出
  const failed = []
  const failing = loadInjectedEditText({
    bodyEditor: { replaceText: async () => { failed.push('replaceText'); throw new Error('save-boom') } },
    notifyPluginTimeline: () => { failed.push('notify') },
    readSessionMap: async () => ({ 'sess-1': 'chat-1' }),
    chatPersistence: { readWindow: async () => ({ chat: { messages: [{ text: 'old' }] }, to: 42 }) },
    chatForSession: async () => { failed.push('chatForSession'); return {} },
    tavernScriptHostAdapter: { dispatchServerEvent: async () => { failed.push('dispatch') } },
  })
  await assert.rejects(() => failing({ sessionId: 'sess-1' }, 'new'), /save-boom/)
  assert.deepEqual(failed, ['replaceText'], '保存失败不得 notify/dispatch：' + JSON.stringify(failed))

  // ④ 事件失败：必须向调用方传播（不吞）
  let readCount2 = 0
  const eventFail = loadInjectedEditText({
    bodyEditor: { replaceText: async () => {} },
    notifyPluginTimeline: () => {},
    readSessionMap: async () => ({ 'sess-1': 'chat-1' }),
    // ④ 事件失败：before/after 必须真有正文差异，否则不会派发（原夹具两窗相同导致本项失败：Missing expected rejection）
    chatPersistence: { readWindow: async () => ({ chat: { messages: [{ text: String(readCount2 += 1) }] }, to: 42 }) },
    chatForSession: async () => ({ id: 'chat-1' }),
    tavernScriptHostAdapter: { dispatchServerEvent: async () => { throw new Error('event-boom') } },
  })
  await assert.rejects(() => eventFail({ sessionId: 'sess-1' }, 'new'), /event-boom/)

  // ⑤ 真实注入体必须走全局 tavernScriptHostAdapter（而非局部同名），且 a2008 真源里 saveBodyEdit 链仍被同一变换处理（不重复派发）
  assert.ok(editBlock.includes('tavernScriptHostAdapter.dispatchServerEvent'), '注入体必须调用全局适配器')
  assert.equal(transformed.split("event: 'MESSAGE_EDITED'").length - 1, 2, 'saveBodyEdit 与 editText 各自一次派发（各一处，不得重复注入）')
})
