// 本次最小路由闸：真实共用分类/双端筛选/生命周期/VM钩子/最终标准shim；不启动GUI、不读真实档。
// MVU命令核心为受控DI夹具，不冒认完整真实核心或浏览器页面验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { classifyCardScript, projectServerScripts, storageBrowserScripts, createServerExecution } from '../lib/server-execution.js'

const browserCases = [
  "SillyTavern.getContext().variables.local.get('coins')",
  "SillyTavern.variables.local.set('coins', 9)",
  "window.SillyTavern?.getContext?.().variables?.local.get('coins')",
  "globalThis['SillyTavern']['getContext']().variables['local'].get('coins')",
  "window['getContext']().variables.local.get('coins')",
  "const context = getContext; context().variables.local.get('coins')",
  "const st = SillyTavern; st.variables.local.get('coins')",
  "const { getContext: context } = window; context()",
  "variables.local.get('coins')",
  "variables?.['local'].get('coins')",
  "variables /* 间隔 */ ['local'].get('coins')",
  "ctx['variables']['local'].get('coins')",
  "ctx?.['variables']?.local.get('coins')",
  "const value = `${getContext().variables.local.get('coins')}`",
  "const value = `https://example.invalid/${getContext().variables.local.get('coins')}`",
]
const compute = "eventOn(Mvu.events.VARIABLE_UPDATE_ENDED, (_before, after) => { after.stat_data.派生值 = getVariables().stat_data.数值 + 1 })"
const computeCases = [
  compute,
  "const local = getVariables(); local.stat_data.数值 = 3",
  "// SillyTavern.getContext().variables.local\ngetVariables()",
  "/* getContext variables.local */ getVariables()",
  "console.log('SillyTavern getContext variables.local'); getVariables()",
  'console.log("SillyTavern.getContext().variables.local"); getVariables()',
  "const getContext2 = 1, mygetContext = 2, SillyTavernName = 3; getVariables()",
]
const browserScript = { id: '浏览器local', name: '浏览器local', content: browserCases[0] }
const computeScript = { id: '派生计算', name: '派生计算', content: compute }
const logger = { info() {}, warn() {}, error() {} }
const draft = () => ({ id: 'route-chat', sessionId: 'route-session', cardPath: 'route-card', messages: [
  { role: 'assistant', swipeId: 0, swipes: ['正文'], variables: [{ stat_data: { 数值: 1 }, schema: {} }] },
] })
const executionOptions = scripts => ({
  logger, hookLoadBudgetMs: 1, hookLoadTickMs: 1, hookLoadMaxTurns: 1,
  host: { updateVariables: async () => { throw new Error('夹具禁止持久化写') } },
  project: scripts => ({ scripts }), readCardExtensions: async () => ({ helperScripts: scripts }),
})

test('浏览器facade常见静态形式保留浏览器；纯MVU、注释和描述字符串不迁端', () => {
  for (const code of browserCases) assert.equal(classifyCardScript(code), 'browser-ui', code)
  for (const code of computeCases) assert.equal(classifyCardScript(code), 'server-compute', code)
  assert.equal(classifyCardScript("import { getContext } from 'fixture'"), 'browser-ui')
  assert.equal(classifyCardScript("import { derive } from 'https://example.invalid/math.mjs'"), 'esm')
  assert.equal(classifyCardScript('document.querySelector(".x")'), 'browser-ui')
  assert.equal(classifyCardScript('  '), 'empty')
  const scripts = [browserScript, computeScript]
  assert.deepEqual(storageBrowserScripts(scripts).map(script => script.id), [browserScript.id])
  assert.deepEqual(projectServerScripts(scripts).map(script => script.id), [computeScript.id])
})

test('旧失败脚本不再送入VM；混合卡的纯MVU核心与派生钩子仍真实服务端执行', async () => {
  let commands = 0
  const execution = createServerExecution({ ...executionOptions([browserScript, computeScript]),
    executeCommand: async (_text, variables, emit) => {
      commands++; variables.stat_data.数值 = 7
      await emit('mag_variable_update_ended', variables, variables)
      return true
    },
  })
  try {
    const chat = draft()
    const outcome = await execution.executeMvuUpdate({ sessionId: chat.sessionId, draft: chat,
      transaction: { eventId: 'mvu-work:route' }, messageId: 0, swipeId: 0, commandText: '受控命令',
    })
    assert.equal(commands, 1)
    assert.equal(outcome.variables.stat_data.数值, 7)
    assert.equal(outcome.variables.stat_data.派生值, 8)
  } finally { execution.disposeAll() }
})

test('生命周期仍要求派发浏览器facade脚本；仅脚本级动态标记也不能两端消失', async () => {
  const normal = createServerExecution(executionOptions([browserScript]))
  const markedScript = { id: '动态浏览器', name: '动态浏览器', content: 'const neutral = 1' }
  const marks = { lookupCard: () => null, lookupScript: () => ({ reason: 'dom-probe' }) }
  const marked = createServerExecution({ ...executionOptions([markedScript]), cardScriptDispatchStore: marks })
  try {
    for (const execution of [normal, marked]) {
      const outcome = await execution.dispatchLifecycleEvent({ sessionId: 'route-session', chat: draft(), event: 'MESSAGE_SENT', args: [0] })
      assert.equal(outcome.browserScripts, 1, '必须让作者adapter下发浏览器，不能误报0而直接结束')
    }
  } finally { normal.disposeAll(); marked.disposeAll() }
})

test('标准安装最终生成shim转发真实dispatchDeps，不以备用shim替代生产证据', () => {
  const source = readFileSync(new URL('../deploy/standard-seams.mjs', import.meta.url), 'utf8')
  const match = source.match(/write\.set\(DOMAIN \+ 'storage-server-execution\.js', shim\(("(?:\\.|[^"\\])*")\)\)/)
  assert.ok(match, '最终buildCore的生产写口必须存在')
  const body = JSON.parse(match[1])
  const wrapperSource = body.slice(body.indexOf('export function storageBrowserScripts'))
  const wrapper = new Function('impl', 'authorScripts', wrapperSource.replace('export ', '') + '\nreturn storageBrowserScripts')(
    { storageBrowserScripts }, { isHostOwnedMvu: () => false },
  )
  const neutral = { id: '动态浏览器', content: 'const neutral = 1' }
  const marks = { lookupScript: (card, id) => card === 'route-card' && id === neutral.id }
  assert.deepEqual(wrapper([browserScript, computeScript]).map(script => script.id), [browserScript.id])
  assert.deepEqual(wrapper([neutral], { store: marks, cardPath: 'route-card' }).map(script => script.id), [neutral.id])
  assert.equal(wrapper([neutral], { store: marks, cardPath: 'other-card' }).length, 0)
})
