// 只测两个生产接入缺陷：真实vm加载失败不能伪成功；DOM标记必须被浏览器消费。
// 不安装依赖、不访问真实档、不复制作者树、不运行全量或既有33个fake测试。
// 变量核心仅提供最小受控命令；真实核心缺lodash、作者副本缺freeze-json/json-mutation，
// 所以本文件不声称完整真实adapter→SQL提交链已经实测。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServerExecution, storageBrowserScripts } from '../lib/server-execution.js'

const logger = { info() {}, warn() {}, error() {} }
const script = { id: '派生钩子', name: '派生钩子', content: 'eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, () => {})' }
const draft = () => ({ id: 'fixture-chat', sessionId: 'fixture-session', cardPath: 'fixture-card', messages: [
  { role: 'assistant', swipeId: 0, variables: [{ stat_data: { n: 1 }, schema: { type: 'object', properties: {}, extensible: true } }] }
] })
function options(scripts, extra = {}) {
  return {
    logger, hookLoadBudgetMs: 1, hookLoadTickMs: 1, hookLoadMaxTurns: 1,
    host: { updateVariables: async () => { throw new Error('本fixture禁止宿主变量写') } },
    project: helpers => ({ scripts: helpers }),
    readCardExtensions: async () => ({ helperScripts: scripts }),
    executeCommand: async (_text, variables) => { variables.stat_data.n = 2; return true },
    ...extra
  }
}

test('真实vm脚本加载语法失败必须阻断服务端成功回执', async () => {
  let coreRuns = 0
  const execution = createServerExecution(options([{ ...script, content: 'const = ;' }], {
    executeCommand: async () => { coreRuns += 1; return true }
  }))
  try {
    await assert.rejects(execution.executeMvuUpdate({ sessionId: 'fixture-session', transaction: { eventId: 'mvu-work:fixture' },
      draft: draft(), messageId: 0, swipeId: 0, commandText: 'fixture-command' }), /加载|load|语法|Syntax|脚本/)
    assert.equal(coreRuns, 0, '脚本加载失败后不允许继续变量核心')
  } finally { execution.disposeAll() }
})

test('动态DOM标记脚本必须进入实际浏览器过滤结果', () => {
  // 内容未命中静态DOM token；运行期已标成browser-ui，标记本身不是第二次静态分类。
  const store = { lookupScript: () => ({ reason: 'dom-probe-hook' }), lookupCard: () => null }
  assert.equal(storageBrowserScripts([script], { store, cardPath: 'fixture-card' }).length, 1,
    '动态标記不能仅服务端排除、浏览器仍排除，造成两端都不执行')
})

test('卡级DOM标记不能误称浏览器脚本数为零', async () => {
  const execution = createServerExecution(options([script], { cardScriptDispatchStore: { lookupCard: () => ({ reason: 'dom-probe' }) } }))
  try {
    const result = await execution.dispatchLifecycleEvent({ sessionId: 'fixture-session', chat: draft(), event: 'MESSAGE_SENT', args: [0] })
    assert.notEqual(result.browserScripts, 0, '纯计算快捷回执不得吞掉已经判给浏览器的卡')
  } finally { execution.disposeAll() }
})
