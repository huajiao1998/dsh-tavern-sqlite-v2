// 只测已确认的mvu_zod通知读取契约；原创模拟模块，不读取实际卡档、不联网。
import assert from 'node:assert/strict'
import { createServerExecution } from '../lib/server-execution.js'
const logger = { info() {}, warn() {}, error() {} }
const draft = () => ({ id: 'notification-fixture', sessionId: 'notification-session', cardPath: 'notification-card', messages: [{ role: 'assistant', text: '', swipeId: 0, swipes: [''], variables: [{ stat_data: { hp: 1 }, schema: {} }] }] })
async function run(hook, kind = 'server-compute') {
  const content = kind === 'esm' ? "import 'https://fixture.example/mvu_zod.mjs'" : hook
  const execution = createServerExecution({ logger, hookLoadBudgetMs: 1,
    host: { updateVariables: async () => ({ updated: true }) },
    project: scripts => ({ scripts }),
    readCardExtensions: async () => ({ helperScripts: [{ id: 'notification-hook', name: '通知读取夹具', content }] }),
    esm: { lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async () => new Response(hook) },
    executeCommand: async (_text, variables, emit) => { await emit('mag_command_parsed_for_zod', variables, [], ''); return true },
  })
  const chat = draft()
  try { return await execution.executeMvuUpdate({ sessionId: chat.sessionId, draft: chat, transaction: { eventId: 'notification-test' }, messageId: 0, swipeId: 0, commandText: '受控命令' }) }
  finally { execution.disposeAll() }
}
const hook = "eventOn('mag_command_parsed_for_zod', (variables, commands) => { variables.stat_data.notify = Boolean($('#mvu_notification_error').prop('checked')); variables.stat_data.commands = commands.length })"
for (const kind of ['server-compute', 'esm']) {
  const result = await run(hook, kind)
  assert.equal(result.variables.stat_data.notify, true, kind + '必须开启schema校验错误报告')
  assert.equal(result.variables.stat_data.commands, 0, kind + '保留原事件参数')
}
await assert.rejects(run("eventOn('mag_command_parsed_for_zod', () => $('#other-panel').prop('checked'))"), /服务端不支持.*选择器/, '任意DOM选择器不得静默返回undefined或伪造成功')
await assert.rejects(run("eventOn('mag_command_parsed_for_zod', () => $('#mvu_notification_error').prop('checked', false))"), /只读/, '通知控件写操作必须拒绝')
await assert.rejects(run("eventOn('mag_command_parsed_for_zod', () => $('#mvu_notification_error').prop('value'))"), /只读/, '仅支持checked读取')
await assert.rejects(run("eventOn('mag_command_parsed_for_zod', () => { if ($('#mvu_notification_error').prop('checked')) throw new Error('schema校验失败夹具') })"), /schema校验失败夹具/, '不得吞掉schema钩子错误')
console.log('mvu-zod-notification: 经典及ESM通知读取、参数保留、任意DOM及写入拒绝、strict失败闸通过')
