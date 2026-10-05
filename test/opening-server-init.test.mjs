// 新增开局消费者定向断言：原创数据、真实 VM/核心，不读真实卡/存档、不调用模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(new URL('../../../tools/mvu-server-core/package.json', import.meta.url))
const dependencies = new Map(['lodash', 'yaml', 'json5', 'jsonrepair'].map(name => [name, pathToFileURL(require.resolve(name)).href]))
registerHooks({ resolve(name, context, next) { return dependencies.has(name) ? { url: dependencies.get(name), shortCircuit: true } : next(name, context) } })
const { createServerExecution } = await import('../lib/server-execution.js')
const { createCardScriptRuntime } = await import('../lib/mvu/mvu-card-runtime.js')
const { initializeOpeningRuntime } = await import('../lib/opening-server-init.js')
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function draftOf(swipes = ['开场白'], scripts = []) {
  return { id: 'fixture', cardPath: '/fixture/card.png', card: { name: '原创卡' }, userName: '旅人', helperScripts: scripts,
    globalVariables: {}, characterVariables: {}, extensionSettings: {},
    chat: { id: 'fixture', sessionId: 'opening:fixture', cardPath: '/fixture/card.png', mode: 'story', mvu: { enabled: true }, variables: {},
      messages: [{ greeting: true, role: 'assistant', text: swipes[0], sourceText: swipes[0], swipeId: 0, swipes, variables: swipes.map(() => ({})) }] } }
}
const bookOf = () => ({ name: '主书', entries: [{ uid: 1, name: '[initvar] 基础', content: 'hp: 7\nflag: false' }] })
const scriptOf = (id, content) => ({ id, name: id, content })
function factory(extra = {}, capture = () => {}) {
  return options => { const execution = createServerExecution({ ...options, logger: quiet, lodash: require('lodash'), project: scripts => ({ scripts: scripts || [] }), isHostOwnedMvu: () => false, ...extra }); capture(execution); return execution }
}
const hook = body => `eventOn('mag_variable_initialized', function(data, index) { ${body} })`

test('开局真实命令、逐swipe事件和短timer全部在发布前完成，重复初始化不重放', async () => {
  const draft = draftOf(["<initvar>hp: 7\nflag: false</initvar>\n_.add('hp', 2);", "<initvar>hp: 11\nflag: false</initvar>\n_.add('hp', 2);"],
    [scriptOf('derive.js', hook("setTimeout(function() { data.stat_data.flag = true; data.stat_data.index = index }, 30); updateVariablesWith(v => ({count:(v.count||0)+1}), {type:'script'});"))])
  draft.chat.messages[0].swipeId = 1
  const result = await initializeOpeningRuntime({ draft, worldbook: bookOf(), createServerExecution: factory() })
  assert.equal(result.initialized, true)
  assert.deepEqual(draft.chat.messages[0].variables.map(v => [v.stat_data.hp, v.stat_data.flag, v.stat_data.index]), [[9, true, 0], [13, true, 1]])
  assert.equal(draft.chat.tavernHelperScriptVariables['derive.js'].count, 2)
  assert.equal(draft.chat.messages[0].swipeId, 1)
  const again = await initializeOpeningRuntime({ draft, worldbook: bookOf(), createServerExecution: factory() })
  assert.equal(again.initialized, false)
  assert.equal(draft.chat.tavernHelperScriptVariables['derive.js'].count, 2)
  assert.deepEqual(draft.chat.messages[0].variables.map(v => v.stat_data.hp), [9, 13])
})

test('主书开场白覆盖不丢附加和全局initvar，浏览器UI不进服务端', async () => {
  const draft = draftOf(['<initvar>hp: 20</initvar>'], [scriptOf('ui.js', "document.querySelector('#fixture')")])
  draft.initializationWorldbooks = [bookOf(), { name: '附加书', entries: [{ name: '[initvar]', content: 'mp: 3' }] }, { name: '全局书', entries: [{ name: '[initvar]', content: 'gold: 4' }] }]
  await initializeOpeningRuntime({ draft, worldbook: bookOf(), createServerExecution: factory() })
  assert.deepEqual(draft.chat.messages[0].variables[0].stat_data, { hp: 20, mp: 3, gold: 4 })
})

test('current世界书走真实消费者读口，脚本私有写不改原投影', async () => {
  const worldbook = bookOf(), before = structuredClone(worldbook)
  const draft = draftOf(['开场白'], [scriptOf('book.js', hook("return getWorldbook('current').then(entries => replaceVariables({uid:entries[0].uid, content:entries[0].content}, {type:'script'}))"))])
  await initializeOpeningRuntime({ draft, worldbook, createServerExecution: factory() })
  assert.deepEqual(draft.chat.tavernHelperScriptVariables['book.js'], { uid: 1, content: 'hp: 7\nflag: false' })
  assert.deepEqual(worldbook, before)
  // 同一私有消费者内公开楼层 Helper 回写不得被后续 core/最终 outputs 覆盖。
  const writes = draftOf(['开场一', '开场二'], [scriptOf('message.js', hook("const tree=getVariables();tree.stat_data.hp=30+index;return setChatMessages([{message_id:0,data:tree}])"))])
  await initializeOpeningRuntime({ draft: writes, worldbook, createServerExecution: factory() })
  assert.deepEqual(writes.chat.messages[0].variables.map(tree => tree.stat_data.hp), [30, 31])
})

test('第二swipe失败时不发布第一个swipe或scope的半写结果', async () => {
  const draft = draftOf(['开场一', '开场二'], [scriptOf('bad.js', hook("if(index===1)throw new Error('第二开场失败'); return replaceVariables({touched:true}, {type:'chat'})"))])
  const before = structuredClone(draft)
  await assert.rejects(initializeOpeningRuntime({ draft, worldbook: bookOf(), createServerExecution: factory() }), /第二开场失败/)
  assert.deepEqual(draft, before)
})

test('async timer回调拒绝必须原错误上抛，不得把普通timeout当通过', async () => {
  const draft = draftOf(['开场白'], [scriptOf('reject.js', hook("setTimeout(async function() { await Promise.resolve(); throw new Error('async回调专用错误') }, 20)"))])
  const before = structuredClone(draft)
  await assert.rejects(initializeOpeningRuntime({ draft, worldbook: bookOf(), createServerExecution: factory() }), /async回调专用错误/)
  assert.deepEqual(draft, before)
})

test('钩子和短timer同步死循环均受真实VM20ms约束', async () => {
  for (const body of ["while(true){}", "setTimeout(function(){while(true){}}, 1)"]) {
    const draft = draftOf(['开场白'], [scriptOf('loop.js', hook(body))])
    const started = Date.now()
    await assert.rejects(initializeOpeningRuntime({ draft, worldbook: bookOf(), createServerExecution: factory({ createRuntime: options => createCardScriptRuntime({ ...options, syncTimeoutMs: 20 }) }) }), /timed out|超时/i)
    assert.ok(Date.now() - started < 1000)
  }
})

test('不await的async updater及不同脚本timer await后仍归自己scope', async () => {
  const scripts = ['a.js', 'b.js'].map(id => scriptOf(id, hook(`setTimeout(async function(){ await new Promise(r=>setTimeout(r,10)); updateVariablesWith(async v=>{await new Promise(r=>setTimeout(r,10));return {...v,owner:getScriptId()}},{type:'script'}) },10)`)))
  const draft = draftOf(['开场白'], scripts)
  await initializeOpeningRuntime({ draft, worldbook: bookOf(), createServerExecution: factory() })
  assert.deepEqual(draft.chat.tavernHelperScriptVariables, { 'a.js': { owner: 'a.js' }, 'b.js': { owner: 'b.js' } })
})

test('Host调用在飞时取消立即拒绝，whenIdle在dispose后仍join已发调用', async () => {
  let enter, release, execution, idleDone = false
  const entered = new Promise(resolve => { enter = resolve }), gate = new Promise(resolve => { release = resolve })
  const draft = draftOf(['开场白'], [scriptOf('gate.js', hook("replaceVariables({pending:true},{type:'script'})"))])
  const before = structuredClone(draft), controller = new AbortController()
  const run = initializeOpeningRuntime({ draft, worldbook: bookOf(), signal: controller.signal,
    createServerExecution: options => {
      const original = options.host.updateVariables
      options.host.updateVariables = async (...args) => { enter(); await gate; return original(...args) }
      Object.freeze(options.host) // 真实冻结 Host 的包装也不能违反 Proxy 不变量。
      return factory({}, value => { execution = value })(options)
    } })
  // 及时挂拒绝消费者，避免取消先于 assert 的进程级 unhandled。
  const checked = assert.rejects(run, error => error.code === 'SERVER_EXECUTION_CANCELLED')
  try {
    await entered
    const started = Date.now()
    controller.abort()
    await checked
    assert.ok(Date.now() - started < 300)
    const idle = execution.whenIdle('opening:fixture').then(() => { idleDone = true })
    await sleep(20)
    assert.equal(idleDone, false)
    assert.deepEqual(draft, before)
    release()
    await idle
    assert.equal(idleDone, true)
    assert.deepEqual(draft, before)
  } finally { release(); await execution?.whenIdle('opening:fixture'); execution?.disposeAll() }
})

test('异步DOM探针即使被脚本catch仍拒提交，标记保原脚本身份', async () => {
  const marked = []
  const draft = draftOf(['开场白'], [scriptOf('dom.js', hook("setTimeout(async function(){await Promise.resolve();try{window['doc'+'ument']['query'+'Selector']('#x')}catch(_){}},10)"))])
  const store = { markScript: (_path, id) => marked.push(id), lookupScript: (_path, id) => marked.includes(id) }
  await assert.rejects(initializeOpeningRuntime({ draft, worldbook: bookOf(), cardScriptDispatchStore: store, createServerExecution: factory() }), /DOM/)
  assert.ok(marked.includes('dom.js'))
  const { storageBrowserScripts } = await import('../lib/server-execution.js')
  assert.equal(storageBrowserScripts(draft.helperScripts, { store, cardPath: draft.cardPath }).length, 1)
  // 重试已判UI的脚本不在服务端再执行，两端使用同一标记判据。
  await initializeOpeningRuntime({ draft, worldbook: bookOf(), cardScriptDispatchStore: store, createServerExecution: factory() })
})

test('ready微任务及短timer保脚本身份，超过256待办即拒绝提交', async () => {
  const ready = draftOf(['开场白'], [scriptOf('ready.js', "$(function(){setTimeout(function(){replaceVariables({ready:true},{type:'script'})},10)})")])
  await initializeOpeningRuntime({ draft: ready, worldbook: bookOf(), createServerExecution: factory() })
  assert.deepEqual(ready.chat.tavernHelperScriptVariables['ready.js'], { ready: true })
  const flood = draftOf(['开场白'], [scriptOf('flood.js', hook("for(let i=0;i<257;i++)setTimeout(()=>{},50)"))])
  await assert.rejects(initializeOpeningRuntime({ draft: flood, worldbook: bookOf(), createServerExecution: factory() }), /数量超过上限/)
})
