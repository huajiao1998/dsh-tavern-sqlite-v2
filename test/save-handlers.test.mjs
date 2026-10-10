// 标准插件迁移：自有存档 RPC 的宿主/前端契约定向测试（真上游 plugin-api.js + 真 registerSaveHandlers + 真 callHost 提取）。
// 不启动服务、不碰真实档、不假造 tavern API：owner 由真 ownerOf(ctx.fiber.name) 推出，分派走真 callHandler。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { handlerName, registerSaveHandlers, SAVE_HANDLERS } from '../save-handlers.js'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const authorTree = path.resolve(process.env.DSH_TAVERN_TEST_AUTHOR_TREE
  || path.join(workspace, 'tmp/plugin-standard-migration-20261010/author-tree/dsh-tavern-7cdd287eef24ad410ecea38c20e6e63d1da8704e'))
const authorApiPath = path.join(authorTree, 'tavern-plugin', 'lib', 'plugin-api.js')
const authorClientPath = path.join(authorTree, 'tavern-plugin', 'lib', 'client.js')
assert.ok(existsSync(authorApiPath), '需要上游 7cdd287 真实树（真 plugin-api.js）：' + authorApiPath)
assert.ok(existsSync(authorClientPath), '需要上游 7cdd287 真 client.js（提取真 callHost）')

/** 花括号配对取真函数文本（与既有测试同法，不用正则猜边界）。 */
function extractFunction(text, header) {
  const start = text.indexOf(header)
  assert.ok(start >= 0, '应能定位 ' + header)
  let depth = 0
  for (let i = text.indexOf('{', start); i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(start, i + 1) }
  }
  throw new Error('函数花括号不平衡：' + header)
}

const { createTavernPluginApi } = await import(pathToFileURL(authorApiPath).href)
const OWNER = 'dsh-tavern-sqlite-v2'

/** 最小 dep stub：只提供真 ownerOf 需要的 ctx（fiber.name）＋ effect（register 的 owned 用真 ctx.effect 时才有）。 */
function makeApi({ actions, owner = OWNER, withEffect = true, extraDeps = {} } = {}) {
  const services = {}
  const ctx = {
    fiber: { name: owner },
    get: name => services[name],
    ...(withEffect ? { effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } } } : {}),
  }
  const api = createTavernPluginApi({ ctx, ...extraDeps })
  // 真注入形态（cordis tracker：associate 'tavern' / property 'ctx'）：服务对象是**按调用方**的代理，
  // 其 .ctx 指向调用方 ctx ⇒ ownerOf(service) 读到的是我们的 fiber.name，而不是 root。
  services.tavern = Object.assign(Object.create(api.service), { ctx })
  if (actions) services.tavernSaveActions = actions
  return { api, ctx, services }
}
const makeActions = () => {
  const calls = []
  const actions = { runtimeGeneration: 7 }
  for (const target of Object.values(SAVE_HANDLERS)) {
    actions[target] = async args => { calls.push([target, args]); return { echo: target, sessionId: args.sessionId } }
  }
  return { actions, calls }
}

test('保存RPC：7条动作经真tavern.handle注册并真callHandler分派回同一服务', async () => {
  const { actions, calls } = makeActions()
  const { api, ctx } = makeApi({ actions })
  const unload = registerSaveHandlers(ctx)
  try {
    for (const [method, target] of Object.entries(SAVE_HANDLERS)) {
      const reply = await api.callHandler(handlerName(method), { sessionId: 's1', n: 1 })
      assert.equal(reply.echo, target, method + ' 必须分派到同一服务的 ' + target)
      assert.equal(reply.ok, true)
      assert.equal(reply.sessionId, 's1')
      assert.equal(reply.runtimeGeneration, 7, '成功回执必须带同一实例的 runtimeGeneration')
    }
    assert.deepEqual(calls.map(([target]) => target).sort(), Object.values(SAVE_HANDLERS).sort(), '七个动作各执行一次')
  } finally { unload() }
})

test('保存RPC：16KB按UTF-8字节拒绝中文超限且不执行动作', async () => {
  const { actions, calls } = makeActions()
  const { api, ctx } = makeApi({ actions })
  const unload = registerSaveHandlers(ctx)
  try {
    const big = await api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1', text: '中'.repeat(6000) })
    assert.equal(big.ok, false)
    assert.equal(big.errorCode, 'DSH_TAVERN_REQUEST_TOO_LARGE')
    assert.equal(calls.length, 0, '超限不得触达业务动作')
    const ok = await api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1', text: '中'.repeat(100) })
    assert.equal(ok.ok, true)
    assert.equal(calls.length, 1)
  } finally { unload() }
})

test('保存RPC：缺sessionId与非法参数对象被拒', async () => {
  const { actions, calls } = makeActions()
  const { api, ctx } = makeApi({ actions })
  const unload = registerSaveHandlers(ctx)
  try {
    assert.equal((await api.callHandler(handlerName('sqliteSavePrepare'), {})).errorCode, 'DSH_TAVERN_SESSION_REQUIRED')
    assert.equal((await api.callHandler(handlerName('sqliteSavePrepare'), [1, 2])).errorCode, 'DSH_TAVERN_BAD_ARGS')
    assert.equal((await api.callHandler(handlerName('sqliteSavePrepare'), 'x')).errorCode, 'DSH_TAVERN_BAD_ARGS')
    assert.equal(calls.length, 0)
  } finally { unload() }
})

test('保存RPC：同名handler重复注册被真register拒绝', () => {
  const { actions } = makeActions()
  const { api, ctx } = makeApi({ actions })
  const unload = registerSaveHandlers(ctx)
  try {
    assert.throws(() => ctx.get('tavern').handle(handlerName('sqliteSaveStatus'), () => ({ ok: true })), /已被注册/)
    assert.equal(typeof api.callHandler, 'function')
  } finally { unload() }
})

test('保存RPC：卸载后active门拒绝执行且handler随fiber释放', async () => {
  const { actions, calls } = makeActions()
  const { api, ctx } = makeApi({ actions })
  const unload = registerSaveHandlers(ctx)
  unload()
  // 卸载＝handler 随 fiber 释放 ⇒ 真 callHandler 抛 TAVERN_PLUGIN_NOT_FOUND（不是 envelope）
  await assert.rejects(() => api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1' }),
    error => error?.code === 'TAVERN_PLUGIN_NOT_FOUND')
  assert.equal(calls.length, 0, '卸载后不得执行动作')
})

test('保存RPC：缺服务时注册立即失败且不残留部分handler', async () => {
  const { actions } = makeActions()
  delete actions.claim
  const { api, ctx } = makeApi({ actions })
  assert.throws(() => registerSaveHandlers(ctx), /缺少保存服务方法/)
  await assert.rejects(() => api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1' }),
    error => error?.code === 'TAVERN_PLUGIN_NOT_FOUND')   // 部分注册失败 ⇒ 一个 handler 都不许留下

  const noTavern = { fiber: { name: OWNER }, get: () => undefined }
  assert.throws(() => registerSaveHandlers(noTavern), /缺少tavern服务/)
  const noActions = makeApi()
  assert.throws(() => registerSaveHandlers(noActions.ctx), /缺少tavernSaveActions服务/)
})

test('保存RPC：真callHost经rpc桥分派到真handler', async () => {
  const { actions, calls } = makeActions()
  const { api, ctx } = makeApi({ actions })
  const unload = registerSaveHandlers(ctx)
  try {
    // 真前端通道：从上游 client.js 提取真 callHost，仅把 rpc 桥到真宿主 callHandler（通道测试不需要整个 bundle）
    const clientText = readFileSync(authorClientPath, 'utf8')
    const callHostText = extractFunction(clientText, 'callHost(name, args) {')
    const rpc = (method, payload) => {
      assert.equal(method, 'callPluginHandler', '通道方法名必须是 callPluginHandler')
      return api.callHandler(payload.name, payload.args).then(result => ({ result }))
    }
    const tavernUi = { callHost: new Function('rpc', 'return { ' + callHostText + ' }')(rpc).callHost }
    const reply = await tavernUi.callHost(handlerName('sqliteVariablesQuery'), { sessionId: 's2' })
    assert.equal(reply.ok, true)
    assert.equal(reply.echo, 'variables')
    assert.equal(calls.length, 1)
  } finally { unload() }
})

test('保存RPC：8s窗口超时触发一次且不重试不宣称取消', async () => {
  const clientText = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const saveRpcText = extractFunction(clientText, 'async function saveRpc(method, args, sessionId) {')
  const timers = []
  let calls = 0
  const tavernUi = { callHost: () => { calls += 1; return new Promise(() => {}) } }   // 永不 settle：只能靠窗口
  const fakeSetTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  const fakeClearTimeout = id => { if (timers[id - 1]) timers[id - 1].cleared = true }
  const saveRpc = new Function('active', 'tavernUiRef', 'setTimeout', 'clearTimeout',
    saveRpcText + ';' + ';return saveRpc')(
    true, tavernUi, fakeSetTimeout, fakeClearTimeout)
  const pending = saveRpc('sqliteSaveStatus', {}, 's1')
  assert.equal(timers.length, 1, '必须建立恰好一个定向窗口')
  assert.equal(timers[0].ms, 8000, '窗口必须是 8s')
  timers[0].fn()                                   // 定向触发（不等 8s）
  await assert.rejects(() => pending, /超时/)
  assert.equal(calls, 1, '超时后不得自动重试')
  assert.equal(timers[0].cleared, true, 'settle 后必须清掉计时器')
})

test('保存RPC：业务错误码经envelope原样回传且不重试', async () => {
  const calls = []
  const actions = { runtimeGeneration: 3 }
  for (const target of Object.values(SAVE_HANDLERS)) {
    actions[target] = async args => {
      calls.push(target)
      if (target === 'claim') { const error = new Error('该档已被另一个保存占用'); error.code = 'DSH_TAVERN_SAVE_BUSY'; throw error }
      return { sessionId: args.sessionId }
    }
  }
  const { api, ctx } = makeApi({ actions })
  const unload = registerSaveHandlers(ctx)
  try {
    const busy = await api.callHandler(handlerName('sqliteSaveClaim'), { sessionId: 's1' })
    assert.equal(busy.ok, false)
    assert.equal(busy.errorCode, 'DSH_TAVERN_SAVE_BUSY', '业务错误码必须原样回传')
    assert.equal(busy.error, '该档已被另一个保存占用')
    assert.equal(calls.filter(target => target === 'claim').length, 1, '失败不得自动重试')
    const ok = await api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1' })
    assert.equal(ok.ok, true)
    assert.equal(ok.runtimeGeneration, 3)
  } finally { unload() }
})

test('保存RPC：本局禁用拒绝且缺gameId按上游语义放行', async () => {
  const { actions, calls } = makeActions()
  // 真 choicesFor 实现（plugin-api.js:104-108）：disabled 来自 deps.data.readSettings(game.chatId).disabled
  const { api, ctx } = makeApi({
    actions,
    extraDeps: {
      resolveGame: async id => ({ chatId: 'chat-' + id }),
      data: { readSettings: async () => ({ disabled: [OWNER] }) },
    },
  })
  const unload = registerSaveHandlers(ctx)
  try {
    await assert.rejects(() => api.callHandler(handlerName('sqliteSaveStatus'), { gameId: 'g1', sessionId: 's1' }),
      error => /关闭了插件/.test(String(error?.message)))
    assert.equal(calls.length, 0, '本局禁用时不得执行业务动作')
    const plain = await api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1' })
    assert.equal(plain.ok, true, '缺 gameId 时按上游语义跳过本局开关；不是更强鉴权证据')
    assert.equal(calls.length, 1)
  } finally { unload() }
})

test('保存RPC：真实Cordis插件fiber归属注册并随卸载释放', async t => {
  // 真 Cordis 4.0.2（本地完整包，只读）：整模块复制到本测试自建 mkdtemp，仅重写它**唯一**的外部依赖为 checkout 绝对解析
  const cordisSource = path.join(workspace, 'tmp/plg-standard-1001-loader/cordis/lib/index.js')
  assert.ok(existsSync(cordisSource), '需要本地真 Cordis 包（只读）：' + cordisSource)
  const checkout = process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app'
  const requireFromCheckout = createRequire(path.join(checkout, 'package.json'))
  const cosmokitUrl = pathToFileURL(requireFromCheckout.resolve('@deepseek-ai/cosmokit')).href
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'save-handlers-cordis-'))
  t.after(() => { assert.ok(path.basename(tmpDir).startsWith('save-handlers-cordis-')); rmSync(tmpDir, { recursive: true, force: true }) })
  const cordisText = readFileSync(cordisSource, 'utf8')
  const EXTERNAL = 'import { defineProperty, hyphenate, isNullable } from "@deepseek-ai/cosmokit";'
  assert.equal(cordisText.split(EXTERNAL).length - 1, 1, '外部依赖必须恰一处（bounded set）')
  const cordisCopy = path.join(tmpDir, 'cordis.js')
  writeFileSync(cordisCopy, cordisText.replace(EXTERNAL, 'import { defineProperty, hyphenate, isNullable } from ' + JSON.stringify(cosmokitUrl) + ';'), 'utf8')
  const { Context } = await import(pathToFileURL(cordisCopy).href)

  // 真宿主服务表：tavern（真 api.service，owner 由 framework tracker 推断）＋tavernSaveActions 桩＋commands 轻实现（记注册/回收）
  const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
  const { actions, calls } = makeActions()
  const commandRegistrations = [], commandDisposals = []
  const root = new Context()
  const api = createTavernPluginApi({
    ctx: root,
    resolveGame: async id => ({ chatId: 'chat-' + id }),
    data: { readSettings: async () => ({ disabled: [OWNER] }) },
  })
  root.provide('tavern', api.service)
  root.provide('tavernSaveActions', actions)
  root.provide('commands', { register(definition) { commandRegistrations.push(definition); return () => commandDisposals.push(definition) } })

  // 真普通插件模块（root exports "."）：fiber 名必须由 module.name 决定 ⇒ owner 是包名而不是 root
  const pluginModule = await import(pathToFileURL(path.join(pluginRoot, 'plugin.js')).href)
  assert.equal(pluginModule.name, 'dsh-tavern-sqlite-v2')
  const fiber = root.plugin(pluginModule)
  await fiber
  assert.equal(fiber.name, 'dsh-tavern-sqlite-v2', 'fiber 名必须来自插件模块 name（owner 权威）')
  assert.equal(commandRegistrations.length, 2, 'host-actions 必须真注册两条命令')

  const okReply = await api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1' })
  assert.equal(okReply.ok, true, '真 fiber 下 handler 必须可用：' + JSON.stringify(okReply))
  assert.equal(okReply.echo, 'status')
  assert.equal(calls.filter(([target]) => target === 'status').length, 1)

  // 本局禁用反例（真 choicesFor）：带 gameId 时拒绝；缺 gameId 时**不 inherit root**、仍执行同一动作
  await assert.rejects(() => api.callHandler(handlerName('sqliteSavePrepare'), { gameId: 'g1', sessionId: 's1' }),
    error => /关闭了插件/.test(String(error?.message)))
  assert.equal(calls.filter(([target]) => target === 'prepare').length, 0, '本局禁用时不得执行动作')
  const noGame = await api.callHandler(handlerName('sqliteSavePrepare'), { sessionId: 's1' })
  assert.equal(noGame.ok, true, '缺 gameId 时必须执行（开关只在有局上下文时生效）')
  assert.equal(calls.filter(([target]) => target === 'prepare').length, 1)

  // 卸载：7 条 handler 随 fiber 释放 ⇒ callHandler 变 not found；2 条命令被回收
  await fiber.dispose()
  await assert.rejects(() => api.callHandler(handlerName('sqliteSaveStatus'), { sessionId: 's1' }),
    error => error?.code === 'TAVERN_PLUGIN_NOT_FOUND')
  assert.equal(commandDisposals.length, 2, '命令必须随 fiber 卸载回收')
})
