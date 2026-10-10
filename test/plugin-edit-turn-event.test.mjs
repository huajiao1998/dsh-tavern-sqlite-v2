// a2008bf 适配：插件 editTurn → deps.editText → bodyEditor.replaceText 路径原先**不派发**服务端 MESSAGE_EDITED。
// 本叶只验该注入的静态契约（严格锚点/幂等/未知拒/新旧兼容），不跑真实宿主、不碰其他变换。
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyBodyEditEventTransform } from '../deploy/core-host-transform.mjs'

const SAVE_LEGACY = "      case 'saveBodyEdit': return { view: await bodyEditor.save(args && args.sessionId, args) }\n"
const EDIT_TEXT = "    editText: async (material, text) => {\n"
  + "      await bodyEditor.replaceText(material.sessionId, text)\n"
  + "      notifyPluginTimeline(material.sessionId, 'edit', { settled: true })\n"
  + "    },"
const UNKNOWN_EDIT_TEXT = "    editText: async (material, text) => { await bodyEditor.replaceText(material.sessionId, text) },"

test('正文编辑事件：新增editText入口同步派发且幂等兼容新旧', () => {
  // ① 新版（a2008 形态）：saveBodyEdit 走旧锚点 + 新增 editText 入口 ⇒ 必须补派 MESSAGE_EDITED
  const newSource = SAVE_LEGACY + EDIT_TEXT + '\n'
  const once = applyBodyEditEventTransform(newSource)
  const block = once.slice(once.indexOf('editText: async'), once.indexOf('editText: async') + 1400)
  assert.ok(block.includes('dispatchServerEvent'), 'editText 入口必须派发服务端事件')
  assert.ok(block.includes("event: 'MESSAGE_EDITED'"), '事件名必须是 MESSAGE_EDITED')
  assert.ok(block.indexOf('bodyEditor.replaceText') < block.indexOf('dispatchServerEvent'), '事件必须在正文替换之后')
  assert.equal(block.split('notifyPluginTimeline(').length - 1, 1, '作者 notify 必须恰好保留一次')
  assert.equal(block.split('readWindow(').length - 1, 2, '只观察最后一楼窗口（前后各一次），不扫描历史')
  assert.ok(block.includes('{ limit: 1 }'), '窗口必须 limit: 1')
  assert.ok(block.includes('oldText !== newText'), '正文未变不得派发')
  assert.ok(once.includes('const bodyView = await bodyEditor.save(sessionId, args)'), '既有 saveBodyEdit 锚点仍被同一变换处理（旧形态注入体用 bodyView）')

  // ② 幂等：对已变换源码再变换必须逐字不变（严格锚点只命中注入体本身之外的形态）
  assert.equal(applyBodyEditEventTransform(once), once)

  // ③ 未知形态拒（不得削弱）：声明了 editText 但不是我们认识的形态 ⇒ 抛错
  assert.throws(() => applyBodyEditEventTransform(SAVE_LEGACY + UNKNOWN_EDIT_TEXT + '\n'), /editText.*锚点不匹配/)

  // ④ 重复锚点拒：同一锚点出现两次 ⇒ 抛错，不做 global replace
  assert.throws(() => applyBodyEditEventTransform(SAVE_LEGACY + EDIT_TEXT + '\n' + EDIT_TEXT + '\n'), /editText.*重复/)

  // ⑤ 旧版（无 editText 入口）：原样兼容，不假造派发
  const legacy = applyBodyEditEventTransform(SAVE_LEGACY)
  assert.ok(!legacy.includes('editText: async'), '旧版不得被凭空加上 editText 入口')
  assert.ok(legacy.includes('dispatchServerEvent'), 'saveBodyEdit 路径的既有派发保持')
})

test('正文编辑事件：旧标记不能掩盖新入口半缺或未知签名', () => {
  const installed = applyBodyEditEventTransform(SAVE_LEGACY + EDIT_TEXT + '\n')
  const begin = installed.indexOf('    editText: async'), end = installed.lastIndexOf('    },') + 6
  assert.ok(begin > 0 && end > begin, '必须定位真实已注入的完整新入口')
  const restoreOriginal = installed.slice(0, begin) + EDIT_TEXT + installed.slice(end)
  assert.throws(() => applyBodyEditEventTransform(restoreOriginal), /editText.*未注入或内容不符/)
  // 只损坏新入口，旧UI完整块仍存在，旧标记不能代新入口验收。
  const brokenNew = installed.slice(0, begin) + installed.slice(begin).replace('await tavernScriptHostAdapter.dispatchServerEvent(', 'await removedDispatcher(')
  assert.notEqual(brokenNew, installed)
  assert.throws(() => applyBodyEditEventTransform(brokenNew), /editText.*未注入或内容不符/)
  const unknownSignature = EDIT_TEXT.replace('(material, text)', '(input, text)')
  assert.throws(() => applyBodyEditEventTransform(SAVE_LEGACY + unknownSignature), /editText.*锚点不匹配/)
  const doubled = installed + installed.slice(begin, end)
  assert.throws(() => applyBodyEditEventTransform(doubled), /editText.*重复/)
})
