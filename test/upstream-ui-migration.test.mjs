// 自有 UI 迁移定向断言：只验证页头入口与输入区失败清理条的**真实运行时契约**（slots 注册形状、桥只读转发、
// 共享 cleanFailure 的顺序与守卫）；不跑旧 SQL/sync 断言、不联网、不读真实档、不 fork。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { applyAuthorRollbackActionTransform } from '../deploy/rollback-sync-author-transform.mjs'
import { applyRollbackSyncActionGuardTransform } from '../deploy/rollback-sync-install-transform.mjs'
import { applyErrorPurgePlayControlsTransform, applyErrorPurgeTurnControlsTransform } from '../deploy/error-purge-transform.mjs'
import { readCurrentAuthorSource } from './fixtures/current-author-source.mjs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const norm = value => JSON.parse(JSON.stringify(value))
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

/**
 * 用**真实 client factory** 起一份共享服务实例（tavernStorageUi.cleanFailure 是产品实现，不是 dummy 算法），
 * 桥只提供作者 live view 的只读合同（selectFailure/getSnapshot/request/refresh）。
 */
function sharedStorageUiProbe(view, shared) {
  const cells = new Map()
  let cursor = 0
  const cell = () => { const key = 'ui#' + cursor++; if (!cells.has(key)) cells.set(key, {}); return cells.get(key) }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    Fragment: 'Fragment',
    useState(initial) { const store = cell(); if (!('value' in store)) store.value = initial; return [store.value, () => {}] },
    useRef(initial) { const store = cell(); if (!('current' in store)) store.current = initial; return store },
    useCallback(fn) { cell(); return fn },
    useMemo(fn) { cell(); return fn() },
    useEffect(fn) { cell(); return fn() },
    useSyncExternalStore(subscribe, getSnapshot) { cell(); return getSnapshot() },
  }
  const provided = new Map()
  const calls = { request: 0, refresh: 0, wait: 0 }
  const sessions = {
    subagentAddress: () => undefined,
    async waitForTavernRollbackSync(receipt) { calls.wait += 1; shared.waited = receipt; },
  }
  const ctx = {
    sessions,
    slots: { inject: (name, supply) => supply(), register: () => () => {} },
    get(name) {
      if (name === 'tavernStorageUi') return provided.get(name)
      if (name === 'tavernStorageView') {
        return {
          apiVersion: 2,
          selectFailure: () => ({ getSnapshot: () => view(), subscribe: () => () => {} }),
          getSnapshot: () => view(),
          request: async (method, args) => {
            calls.request += 1
            shared.lastArgs = args
            return { view: { rolledBack: { cleanedFailureTarget: args.failureTarget, sync: 'sync-shared', alreadyClean: false } } }
          },
          refresh: () => { calls.refresh += 1 },
        }
      }
      return undefined
    },
    provide(name, value) { provided.set(name, value) },
    effect(effect) { const dispose = effect(); return typeof dispose === 'function' ? dispose : () => {} },
    emit() {},
  }
  let loadedDefinition = null
  vm.runInNewContext(source, {
    AbortSignal, console, setTimeout,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    document: { activeElement: null },
    window: { __ModuleLoader__: { load(definition) { loadedDefinition = definition } } },
  }, { timeout: 1000 })
  assert.ok(loadedDefinition && typeof loadedDefinition.factory === 'function', '真实 client 必须注册带 factory 的模块定义')
  const plugin = loadedDefinition.factory(name => (name === 'react' ? React : {}))
  assert.equal(typeof plugin.apply, 'function', '工厂必须产出可 apply 的插件对象；实际 type=' + typeof plugin)
  plugin.apply(ctx)
  const ui = provided.get('tavernStorageUi')
  assert.ok(ui && typeof ui.cleanFailure === 'function', '必须取到真实共享服务 tavernStorageUi.cleanFailure')
  return { ui, calls, sessions }
}

function sameDeps(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
}

function fakeReact() {
  const cells = new Map()
  let cursor = 0
  let owner = 'root'
  let queued = false
  const cell = () => {
    const key = owner + '#' + cursor++
    if (!cells.has(key)) cells.set(key, {})
    return cells.get(key)
  }
  function drainEffects() {
    for (const cellValue of cells.values()) {
      if (cellValue && cellValue.pending) {
        if (typeof cellValue.pending.cleanup === 'function') { try { cellValue.pending.cleanup() } catch (_) {} }
        cellValue.pending = undefined
      }
    }
  }
  return {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() } },
    Fragment: 'Fragment',
    useState(initial) {
      const store = cell()
      if (!('value' in store)) store.value = typeof initial === 'function' ? initial() : initial
      return [store.value, next => {
        const value = typeof next === 'function' ? next(store.value) : next
        if (Object.is(value, store.value)) return
        store.value = value
        queued = true
      }]
    },
    useRef(initial) { const store = cell(); if (!('current' in store)) store.current = initial; return store },
    useCallback(callback, deps) {
      const store = cell()
      if (!('deps' in store) || !sameDeps(store.deps, deps)) { store.deps = deps; store.callback = callback }
      return store.callback
    },
    useMemo(factory, deps) {
      const store = cell()
      if (!('deps' in store) || !sameDeps(store.deps, deps)) { store.deps = deps; store.value = factory() }
      return store.value
    },
    useEffect(effect, deps) {
      const store = cell()
      if (!('deps' in store) || !sameDeps(store.deps, deps)) {
        const previous = store.cleanup
        store.deps = deps
        store.cleanup = effect()
        store.pending = typeof previous === 'function' ? { cleanup: previous } : undefined
      }
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const store = cell()
      if (!('value' in store)) store.value = getSnapshot()
      else store.value = getSnapshot()
      if (!('stop' in store)) store.stop = subscribe(() => { queued = true })
      return store.value
    },
    render(type, props) {
      const previousOwner = owner
      owner = (type.name || 'anonymous') + '@' + (props && props.sessionId ? props.sessionId : '')
      cursor = 0
      queued = false
      const tree = type(props)
      // 子组件（函数型节点）也要真实渲染：真 React 会递归，测试桩必须同样递归，否则 effect 不跑。
      const visit = node => {
        if (!node || typeof node !== 'object') return
        if (typeof node.type === 'function') {
          const ownerBackup = owner
          node.children = [this.render(node.type, node.props)]
          owner = ownerBackup
          cursor = 0
          return
        }
        for (const child of node.children || []) visit(child)
      }
      visit(tree)
      drainEffects()
      owner = previousOwner
      if (queued) return this.render(type, props)
      return tree
    },
    reset() { cursor = 0; queued = false },
  }
}

const original = { migrated: false, legacy: true, readonly: true, stamp: 'legacy:1:2', forked: false, pending: false }
const database = { migrated: true, legacy: false, readonly: false, stamp: 'sqlite:gen:1' }
const plan = { sourceChatId: 'chat-source', sourceSessionId: 'session-genuine', sourceRevision: 7, turn: 2, atSeq: 3, targetTitle: 'DB.原名' }
const claim = { ...plan, token: 'test-token', state: 'claimed' }
const targetSession = 'session-target'

/** 与作者 liveTavernView.select 同形的 stable handle：getSnapshot 只在内容变化时换引用。 */
function fakeLiveHandle(state) {
  let current = state
  let snapshot = { phase: current.phase, view: current.view, error: current.error }
  const listeners = new Set()
  return {
    setView(view) {
      current = { ...current, view }
      snapshot = { phase: current.phase, view, error: current.error }
      for (const listener of [...listeners]) listener()
    },
    getSnapshot() { return snapshot },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    get listeners() { return listeners.size },
  }
}

function failureTarget(turn = 42) {
  return { kind: 'body', turn, branchId: 'branch-1', revision: 9, operationId: 'op-' + turn, rollbackId: 'rb-1', chatId: 'chat-source', sessionId: 'session-genuine' }
}

/** native-only 目标：无 operationId，endSeq/eventCount 必须满足 eventCount === endSeq + 1。 */
function nativeFailureTarget(turn = 43, endSeq = 43, eventCount = 44) {
  return { kind: 'native-only', turn, branchId: 'branch-1', revision: 11, endSeq, eventCount, rollbackId: 'rb-1', chatId: 'chat-source', sessionId: 'session-genuine' }
}

function harness(options = {}) {
  const trace = [], registrations = [], disposers = [], provided = new Map()
  const React = fakeReact()
  const notifications = { ui: 0 }
  const live = fakeLiveHandle({ phase: 'ready', view: options.view === undefined ? null : options.view, error: '' })
  const bridgeCalls = []
  const bridge = {
    apiVersion: 2,
    selectFailure(sessionId) { bridgeCalls.push({ kind: 'select', sessionId }); return live },
    getSnapshot() { return live.getSnapshot() },
    async request(method, args, sessionId) {
      if (process.env.UI_TRACE) console.log('    [trace] base request 记录 kind=request method=' + method)
      bridgeCalls.push({ kind: 'request', method, args: norm(args), sessionId })
      assert.equal(method, 'rollbackTurn')
      return { view: { rolledBack: { cleanedFailureTarget: args.failureTarget, sync: 'sync-1', alreadyClean: false } } }
    },
    refresh(sessionId) { bridgeCalls.push({ kind: 'refresh', sessionId }) },
  }
  const sessions = {
    async fork(args) { trace.push({ kind: 'fork', args: norm(args) }); return options.target || targetSession },
    async open(id) { trace.push({ kind: 'open', id }) },
    subagentAddress(id) { return id === 'session-child' ? { parentSessionId: 'session-child-parent' } : undefined },
    async waitForTavernRollbackSync(receipt) { trace.push({ kind: 'wait', receipt: norm(receipt) }) },
  }
  // transport shell（本任务唯一改动）：客户端经真 tavernUi.callHost 调宿主 handler；
  // 桥内部仍复用下面的 fetch 桩（同前缀/同 body/同 8s 窗口语义），只是把 HTTP 响应解成 envelope。
  const tavernUi = { callHost: async (name, args) => {
    // 宿主注册名是 kebab（上游只允许小写）⇒ 还原成旧驼峰方法名再走原 fetch 桩断言
    const kebab = String(name).replace(/^dsh-tavern-sqlite-v2\//, '')
    const url = '/api/dsh-tavern-sqlite-v2/' + kebab.replace(/-([a-z])/g, (_m, c) => c.toUpperCase())
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(8000),
    })
    const value = await response.json()
    if (!response.ok || !value?.ok) {
      const error = new Error(value?.error || '存档接口失败')
      if (typeof value?.errorCode === 'string') error.code = value.errorCode
      throw error
    }
    return value
  } }

  const fetch = async (url, request) => {
    assert.match(url, /^\/api\/dsh-tavern-sqlite-v2\/sqliteSave(Status|Prepare|Claim|Complete|Recover|Release)$/, '存档 RPC 必须走已定前缀')
    const method = url.split('/').at(-1)
    const body = JSON.parse(request.body)
    assert.equal(request.method, 'POST')
    trace.push({ kind: 'rpc', method, args: body })
    const results = {
      sqliteSaveStatus: { ...original, ...(options.status || {}) },
      sqliteSavePrepare: plan,
      sqliteSaveClaim: claim,
      sqliteSaveComplete: { ...database, sessionId: targetSession, chatId: 'chat-target' },
      sqliteSaveRecover: { ...database, sessionId: targetSession, chatId: 'chat-target' },
      sqliteSaveRelease: { released: true },
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ...results[method] }) }
  }
  const slots = {
    inject(name, supply) { registrations.push({ kind: 'inject', name }); return supply() },
    register(definition, component) {
      assert.equal(definition.name, registrations.at(-1).name, 'register 的 name 必须与 inject 的 slot 一致')
      const entry = { kind: 'register', definition, component, tree: null }
      registrations.push(entry)
      return () => { entry.disposed = true }
    },
  }
  let bridgeEnabled = true
  const ctx = {
    sessions,
    slots,
    get(name) {
      if (name === 'tavernStorageView') return bridgeEnabled ? bridge : undefined
      return provided.get(name)
    },
    provide(name, value) { provided.set(name, value); disposers.push(() => provided.delete(name)) },
    effect(effect) { const dispose = effect(); assert.equal(typeof dispose, 'function'); disposers.push(dispose); return dispose },
    emit(name) { assert.equal(name, 'tavern-storage-ui/change'); notifications.ui += 1 },
  }
  ctx.tavernUi = tavernUi
  provided.set('tavernUi', tavernUi)   // ctx.get('tavernUi') 走白名单服务表（harness 对未核服务会抛错）
  let plugin = null
  vm.runInNewContext(source, {
    AbortSignal, fetch, console, setTimeout, clearTimeout,
    document: { activeElement: null },
    window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(name => { assert.equal(name, 'react'); return React }) } } },
  }, { timeout: 1000 })
  assert.ok(plugin, '必须能加载工厂')
  assert.deepEqual(Array.from(plugin.inject), ['sessions', 'slots', 'tavernStorageView', 'tavernUi'])
  plugin.apply(ctx)
  const found = name => registrations.find(entry => entry.kind === 'register' && entry.definition.name === name)
  return {
    React, live, trace, registrations, provided, notifications, ctx, found, sessions, bridge, bridgeCalls,
    disableBridge() { bridgeEnabled = false },
    close() { for (const dispose of disposers.reverse()) dispose() },
  }
}

function collect(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.children || []) collect(child, predicate, out)
  return out
}

const textOf = node => typeof node === 'string' ? node : (node?.children || []).map(textOf).join('')
const buttons = node => collect(node, item => item.type === 'button')

function renderInto(harnessRef, entry, props) {
  harnessRef.React.reset()
  const element = entry.component(props)
  if (element === null || element === undefined) return null
  harnessRef.React.render(element.type, element.props)
  return element.type(element.props)
}

/** 页头是有状态 Fragment 组件：保持同一实例，onClick 后重渲染即可看到 dialog。 */
function mountHeader(harnessRef, entry, props) {
  harnessRef.React.reset()
  const element = entry.component(props)
  const render = () => {
    const next = entry.component(props)
    const children = typeof next.type === 'function' ? null : next.children.flat()
    const type = children ? () => ({ type: 'Fragment', props: {}, children }) : next.type
    harnessRef.React.render(type, props)
    return type(props)
  }
  render()
  return {
    tree: render,
    button: () => collect(render(), node => node.type === 'button').find(node => node.props && node.props['aria-haspopup'] === 'dialog'),
    dialog: () => collect(render(), node => node.type === 'dialog')[0],
    rerender: () => render(),
  }
}

test('自有UI：页头入口按固定 order 注册且只在用户点击后走 prepare→claim→fork→complete', async () => {
  const h = harness()
  const header = h.found('conversation.session.header.utilities')
  const dock = h.found('conversation.input.dock')
  assert.ok(header, '必须注册页头 utility')
  assert.equal(dock, undefined, '撤销入口不得再注册输入区dock')
  assert.equal(header.definition.id, 'dsh-tavern-sqlite-v2:save')
  assert.equal(header.definition.order, 70)
  assert.equal(header.definition.label, '数据库存档')
  assert.doesNotMatch(source, /name: 'conversation\.input\.dock'/)

  // 页头按钮：始终可见，未点击前不得发生任何存档/fork 行为。
  const mounted = mountHeader(h, header, { sessionId: 'session-child' })
  assert.match(textOf(mounted.tree()), /数据库存档/)
  const trigger = mounted.button()
  assert.equal(trigger.props.disabled, false)
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.equal(mounted.dialog(), undefined, '未打开时不得挂 dialog')
  assert.deepEqual(h.trace, [], '未点击前不得有任何 RPC/fork')

  // 点击只打开面板：先出状态读，仍不得 fork/complete。
  trigger.props.onClick()
  mounted.rerender()
  const dialogNode = collect(mounted.tree(), () => true).find(node => typeof node.type === 'function' && node.type.name === 'HeaderSaveDialog')
  assert.ok(dialogNode, '点击后必须挂出 dialog 组件')
  assert.equal(dialogNode.props.open, true, 'dialog 必须以 open 状态渲染')
  assert.equal(dialogNode.props.sessionId, 'session-child-parent', 'dialog 必须拿到当前 owner')
  const dialog = dialogNode.type(dialogNode.props)
  assert.equal(dialog.type, 'dialog', 'dialog 组件必须渲染 <dialog>')
  await settle()
  h.React.reset()
  const settledTree = h.React.render(dialogNode.type, dialogNode.props)
  const kinds = () => h.trace.map(item => item.kind === 'rpc' ? item.method : item.kind)
  assert.equal(kinds().every(kind => kind === 'sqliteSaveStatus'), true, '打开面板只应读状态；实际 trace=' + JSON.stringify(kinds()))
  assert.equal(h.trace[0].args.sessionId, 'session-child-parent', '页头 owner 必须是子会话的 parent')
  const createButton = buttons(settledTree).find(button => textOf(button).includes('分叉迁移到数据库存档'))
  assert.ok(createButton, '面板必须有创建按钮；实际文本=' + textOf(settledTree).slice(0, 120))

  // 用户点击创建：完整 prepare → claim → fork → complete 顺序，且 fork 目标是 claim.sourceSessionId。
  await createButton.props.onClick()
  const order = h.trace.filter(item => item.kind !== 'open').map(item => item.kind === 'rpc' ? item.method : item.kind)
  assert.deepEqual(order.slice(1), ['sqliteSavePrepare', 'sqliteSaveClaim', 'fork', 'sqliteSaveComplete'])
  assert.equal(h.trace.find(item => item.kind === 'fork').args.sessionId, plan.sourceSessionId)

  // 数据库目标状态：面板不返回空、不出现禁用死按钮、不自动 fork。
  const h2 = harness({ status: { migrated: true, legacy: false, readonly: false, stamp: 'sqlite:gen:1', forked: true, pending: false } })
  const mounted2 = mountHeader(h2, h2.found('conversation.session.header.utilities'), { sessionId: 'session-child' })
  mounted2.button().props.onClick()
  mounted2.rerender()
  await settle()
  mounted2.rerender()
  const dbDialogNode = collect(mounted2.tree(), () => true).find(node => typeof node.type === 'function' && node.type.name === 'HeaderSaveDialog')
  assert.ok(dbDialogNode, '数据库状态下必须仍挂出面板（不得空面板）')
  h2.React.reset()
  const dbDialog = h2.React.render(dbDialogNode.type, dbDialogNode.props)
  assert.match(textOf(dbDialog), /当前为数据库存档/)
  assert.equal(buttons(dbDialog).some(button => textOf(button).includes('分叉迁移到数据库存档')), false, '数据库态不得再给创建按钮')
  assert.deepEqual(h2.trace.filter(item => item.kind === 'fork'), [], '数据库态不得自动 fork')
})

test('自有UI：退役dock后共享清理服务保留目标及回执守卫', async () => {
  const h = harness()
  assert.equal(h.found('conversation.input.dock'), undefined, '正常/失败/活动状态均不应注册常驻条')
  assert.deepEqual(h.bridgeCalls.filter(call => call.kind === 'request'), [], '注册服务不能发清理请求')
  h.live.setView({ failureTarget: failureTarget(42), failureCleanupReason: 'provider 失败', activity: null })

  // 过期目标（与当前视图不一致）⇒ 拒绝，且不得发 RPC。
  const ui = h.provided.get('tavernStorageUi')
  assert.ok(ui, '共享清理服务必须在位')
  h.bridgeCalls.length = 0
  await assert.rejects(() => ui.cleanFailure('session-child', 42, { ...failureTarget(42), revision: 8 }), /清理目标已过期/)
  assert.deepEqual(h.bridgeCalls.filter(call => call.kind === 'request'), [], '过期目标不得发起清理请求（先 select 只读是合法的）')

  // 菜单互斥另由真实菜单叶覆盖；共享服务仍只按本次明确目标调用，不自动清下一轮。
  let requests = 0
  const baseRequest = h.bridge.request
  h.bridge.request = async (method, args, sessionId) => { requests += 1; return baseRequest.call(h.bridge, method, args, sessionId) }
  await ui.cleanFailure('session-child', 42, failureTarget(42))
  assert.equal(requests, 1, '共享服务只发本次清理请求')
  assert.deepEqual(h.trace.filter(item => item.kind === 'wait').map(item => item.receipt), ['sync-1'], 'normal 清理必须等同连接 sync')
  assert.equal(h.bridgeCalls.filter(call => call.kind === 'refresh').length, 1, 'normal 清理只 refresh 一次')

  // alreadyClean：不等待，只定向 refresh。
  h.trace.length = 0
  h.bridgeCalls.length = 0
  h.bridge.request = async (method, args) => ({ view: { rolledBack: { cleanedFailureTarget: args.failureTarget, sync: 'sync-2', alreadyClean: true } } })
  const r = await ui.cleanFailure('session-child', 42, failureTarget(42))
  assert.equal(r.view.rolledBack.alreadyClean, true)
  assert.deepEqual(h.bridgeCalls.filter(call => call.kind === 'request' || call.kind === 'wait'), [], 'alreadyClean 不得发起新请求')
  assert.equal(h.bridgeCalls.filter(call => call.kind === 'refresh').length, 1, 'alreadyClean 只 refresh 一次')
  assert.deepEqual(h.trace.filter(item => item.kind === 'wait'), [], 'alreadyClean 不得等待')

  // 回执身份不一致 ⇒ 拒绝且不得 refresh。
  h.bridgeCalls.length = 0
  h.bridge.request = async (method, args) => ({ view: { rolledBack: { cleanedFailureTarget: { ...args.failureTarget, revision: 99 }, sync: 'sync-3', alreadyClean: false } } })
  await assert.rejects(() => ui.cleanFailure('session-child', 42, failureTarget(42)), /清理回执目标与请求不一致/)
  assert.equal(h.bridgeCalls.filter(call => call.kind === 'refresh').length, 0, '回执不一致时不得 refresh')

  // 缺桥：响亮失败，不静默跳过。
  h.disableBridge()
  await assert.rejects(() => ui.cleanFailure('session-child', 42, failureTarget(42)), /精简清理未接线/)

  // 卸载：slots 注册被撤销，且新 cleanup 被拒。
  h.close()
  assert.deepEqual(h.registrations.filter(entry => entry.kind === 'register').map(entry => entry.disposed), [true])
  await assert.rejects(() => ui.cleanFailure('session-child', 42, failureTarget(42)), /已经卸载/)
})

test('自有UI：连续失败目标与严格回执拒绝', async () => {
  const h = harness()
  assert.equal(h.found('conversation.input.dock'), undefined)
  const ui = h.provided.get('tavernStorageUi')
  const native43 = nativeFailureTarget(43, 43, 44)
  const body42 = failureTarget(42)
  let receipts = []
  const reqs = []
  const refreshes = []
  h.bridge.request = async (method, args) => {
    reqs.push({ method, args: norm(args) })
    assert.equal(method, 'rollbackTurn')
    const next = receipts.shift()
    assert.ok(next, '没有预置回执却发起了请求（receipts 空）')
    const view = next.viewAfter === undefined ? null : next.viewAfter
    h.live.setView(view)
    return { view: { rolledBack: { cleanedFailureTarget: next.receipt, sync: next.sync || 'sync-x', alreadyClean: next.alreadyClean === true } } }
  }
  h.bridge.refresh = sessionId => { refreshes.push(sessionId) }

  // ① native-only 43 成功：请求带 native 目标、回执同身份、wait 后 refresh；随后目标切到 body 42。
  h.live.setView({ failureTarget: native43, failureCleanupReason: null, activity: null })
  assert.equal(ui.readFailureTarget(ui.selectFailure('session-child')).turn, 43, 'native目标仍供菜单共享服务消费')
  receipts.push({ receipt: native43, sync: 'sync-43', viewAfter: { failureTarget: body42, failureCleanupReason: 'provider 失败', activity: null } })
  const refreshesBeforeNative = refreshes.length
  await ui.cleanFailure('session-child', 43, native43)
  assert.equal(reqs.length, 1, 'native 清理必须发起一次 request')
  assert.equal(reqs[0].args.failureTarget.kind, 'native-only')
  assert.equal(reqs[0].args.failureTarget.endSeq, 43)
  assert.deepEqual(h.trace.filter(item => item.kind === 'wait').map(item => item.receipt), ['sync-43'])
  assert.equal(refreshes.length, refreshesBeforeNative + 1, 'native 成功必须定向 refresh 一次')

  // ② 下一目标body42不得自动清理；实时服务目标切到42，再由用户发起。
  assert.equal(ui.readFailureTarget(ui.selectFailure('session-child')).turn, 42, '连续失败必须切到42且不自动清理')
  assert.equal(reqs.length, 1, '42 只能由用户点击触发，不自动')
  receipts.push({ receipt: body42, sync: 'sync-42', viewAfter: null })
  await ui.cleanFailure('session-child', 42, body42)

  // ③ 目标清空后共享服务不得虚构更早轮。
  assert.equal(ui.readFailureTarget(ui.selectFailure('session-child')), null)

  // ④ 严格回执拒绝（逐项）：零新请求、零 refresh。
  const live = { failureTarget: body42, failureCleanupReason: 'x', activity: null }
  const cases = [
    ['回执 revision 漂移', { ...body42, revision: 99 }],
    ['kind 由 body 反转 native', { ...body42, kind: 'native-only', operationId: undefined, endSeq: 42, eventCount: 43 }],
    ['unknown kind', { ...body42, kind: 'weird' }],
    ['operationId 变更', { ...body42, operationId: 'op-other' }],
    ['branchId 变更', { ...body42, branchId: 'branch-2' }],
  ]
  const before = { requests: reqs.length, refreshes: refreshes.length }
  for (const [label, receipt] of cases) {
    h.live.setView(live)
    h.bridge.request = async () => ({ view: { rolledBack: { cleanedFailureTarget: receipt, sync: 'sync-bad', alreadyClean: false } } })
    await assert.rejects(() => ui.cleanFailure('session-child', 42, body42), /清理回执目标与请求不一致/, label + ' 必须拒')
  }
  assert.equal(reqs.length, before.requests, '拒绝路径零新请求')
  assert.equal(refreshes.length, before.refreshes, '拒绝路径零 refresh')

  // ⑤ native 回执形状不合格：缺 endSeq / eventCount 不满足 +1 ⇒ 拒。
  const nativeLive = { failureTarget: native43, failureCleanupReason: null, activity: null }
  for (const [label, receipt] of [
    ['native 回执缺 endSeq', { ...native43, endSeq: undefined }],
    ['native 回执 eventCount ≠ endSeq+1', { ...native43, endSeq: 43, eventCount: 99 }],
  ]) {
    h.live.setView(nativeLive)
    h.bridge.request = async () => ({ view: { rolledBack: { cleanedFailureTarget: receipt, sync: 'sync-bad', alreadyClean: false } } })
    await assert.rejects(() => ui.cleanFailure('session-child', 43, native43), /native 回执形状不合法/, label + ' 必须拒')
  }

  // ⑥ rollbackId 重试身份不一致（同 revision 同 target，只有 rollbackId 变）：拒且零请求。
  h.live.setView({ failureTarget: { ...body42, rollbackId: 'rb-1' }, failureCleanupReason: 'x', activity: null })
  const staleRetry = { ...body42, rollbackId: 'rb-2' }
  let retryRequests = 0
  h.bridge.request = async () => { retryRequests += 1; return { view: { rolledBack: { cleanedFailureTarget: body42, alreadyClean: false } } } }
  await assert.rejects(() => ui.cleanFailure('session-child', 42, staleRetry), /重试身份不一致/)
  assert.equal(retryRequests, 0, 'rollbackId 过期必须零请求')

  // ⑦ alreadyClean：仍**一次** RPC 拿到 already 状态，但零 wait、一次 refresh。
  h.live.setView({ failureTarget: body42, failureCleanupReason: 'x', activity: null })
  let alreadyRequests = 0
  h.bridge.request = async (method, args) => { alreadyRequests += 1; return { view: { rolledBack: { cleanedFailureTarget: args.failureTarget, sync: 'sync-already', alreadyClean: true } } } }
  const waitsBefore = h.trace.filter(item => item.kind === 'wait').length
  const refreshesBefore = refreshes.length
  const resp = await ui.cleanFailure('session-child', 42, body42)
  assert.equal(resp.view.rolledBack.alreadyClean, true)
  assert.equal(alreadyRequests, 1, 'alreadyClean 仍需一次 RPC 取回状态')
  assert.equal(h.trace.filter(item => item.kind === 'wait').length, waitsBefore, 'alreadyClean 零 wait')
  assert.equal(refreshes.length, refreshesBefore + 1, 'alreadyClean 只 refresh 一次')
})

test('自有UI：原错误行注册委托共享服务', async () => {
  const src = readCurrentAuthorSource('tavern-plugin/src/client/features/play-controls.js')
  assert.equal(src.includes('storageUi: function () { return ctx.get("tavernStorageUi") }'), false, 'fresh 源不得已含接线')
  let transformed = applyRollbackSyncActionGuardTransform(applyAuthorRollbackActionTransform(src))
  transformed = applyErrorPurgePlayControlsTransform(transformed)

  // ① 注册语句：注入 storageUi 取用函数（SupersededTurnErrors 定义在 register(ctx) 之外，函数体拿不到 ctx）。
  const registerStatement = transformed.slice(
    transformed.indexOf('React.createElement(SupersededTurnErrors'),
    transformed.indexOf('React.createElement(SupersededTurnErrors') + 400)
  assert.ok(registerStatement.includes('storageUi: function () { return ctx.get("tavernStorageUi") }'), '注册必须注入 storageUi 取用函数')
  assert.ok(registerStatement.includes('sessions: ctx.sessions'), '注册仍须注入 sessions 服务')
  assert.ok(transformed.includes('var storageUi = typeof props.storageUi === "function" ? props.storageUi() : undefined;'), 'superseded 只经 props.storageUi 取服务')
  assert.equal(transformed.includes('typeof ctx !== "undefined" && ctx && typeof ctx.get === "function"'), false, '不得再假设函数体内有 ctx')

  // ② 取真实 SupersededTurnErrors 函数体运行：props 带 storageUi 取用函数 ⇒ 委托**真实 client 共享服务**。
  const shared = {}
  const view = () => ({ phase: 'ready', view: { failureTarget: failureTarget(42) }, error: '' })
  const probe = sharedStorageUiProbe(view, shared)
  const body = extractFunctionText(transformed, 'function SupersededTurnErrors(props)')
  const runSuperseded = given => {
    let captured = null
    const cells = new Map()
    const effects = []
    let cursor = 0
    const cell = () => { const key = 'sup#' + cursor++; if (!cells.has(key)) cells.set(key, {}); return cells.get(key) }
    const fakeRoot = { closest: () => fakeRoot, querySelectorAll: () => [], append() {}, style: {}, ownerDocument: { createElement: () => ({ setAttribute() {}, remove() {}, style: {}, hidden: false }) } }
    const hooks = {
      useRef(initial) { const store = cell(); if (!('current' in store)) store.current = initial; return store },
      // 真 React 顺序：render 返回 element → commit（ref 赋值）→ 再跑 effect。所以先收着，ref 装好后再执行。
      useEffect(fn) { cell(); effects.push(fn) },
      useSyncExternalStore(subscribe, getSnapshot) { cell(); return getSnapshot() },
    }
    const props = Object.assign({
      sessionId: 'session-child',
      useSession: subscribe => subscribe({ running: false }),
      useChat: selector => selector({}),
      useInput: selector => selector({ draft: '' }),
    }, given)
    const liveView = {
      failureTarget: failureTarget(42),
      failureCleanupReason: '',
      suppressedDshErrorTurns: [],
      hiddenDshErrorTurns: [],
      staleDshErrorTurns: [],
      filteredFailureStreak: 0,
    }
    const fn = new Function('React', 'useLiveTavernView', 'latestTavernAssistantMessageId', 'createSupersededErrorProjection',
      'createTurnErrorControls', 'observeTurnErrorProjection', 'submitFailedTurnReplay', 'rpc', 'liveTavernView', 'tavernCoordination',
      'historyProjection', 'tavernErrorHub', 'tavernProviderRefusalNotice', 'setCandidatePanel', 'setRegenPanel', 'setCandidateGuidePanel',
      'window', body + '\nreturn SupersededTurnErrors')
    const Component = fn(
      { createElement: (type, p) => ({ type, props: p }), useRef: hooks.useRef, useEffect: hooks.useEffect, useSyncExternalStore: hooks.useSyncExternalStore },
      () => ({ view: liveView }), () => 'm1',
      () => ({ apply() {}, dispose() {} }), (root, options) => { captured = options; return { apply() {}, dispose() {} } },
      () => ({ disconnect() {} }), async () => {}, async () => ({}), { rebase() {}, invalidate() {} }, { invalidate() {} },
      { rolledBack() {} }, { report() {} }, () => '', () => {}, () => {}, () => {},
      { requestAnimationFrame: () => 1, cancelAnimationFrame() {}, MutationObserver: class { observe() {} disconnect() {} }, localStorage: { getItem: () => null, setItem() {} } })
    const element = Component(props)
    // commit：ref 先指向假容器（作者 effect 靠 closest 找 root），再执行 effect ⇒ createTurnErrorControls 被真实调用。
    if (element && element.props && element.props.ref) element.props.ref.current = fakeRoot
    cursor = 0
    while (effects.length) { const fn2 = effects.shift(); fn2() }
    return captured
  }

  // 执行施缝后的实际注册表达式，服务读取函数必须由注册闭包生成。
  const expressionStart = transformed.indexOf('React.createElement(SupersededTurnErrors')
  const expressionEnd = transformed.indexOf(' }))', expressionStart) + ' }))'.length
  assert.ok(expressionEnd > expressionStart)
  const expression = transformed.slice(expressionStart, expressionEnd)
  let lookups = 0
  const registered = new Function('React', 'SupersededTurnErrors', 'ctx', 'props', 'return ' + expression)(
    { createElement: (type, props) => ({ type, props }) }, Symbol('SupersededTurnErrors'),
    { sessions: {}, get(name) { assert.equal(name, 'tavernStorageUi'); lookups++; return probe.ui } },
    { sessionId: 'session-child' })
  assert.equal(lookups, 0, '注册渲染不提前执行清理或取用服务')
  const withService = runSuperseded(registered.props)
  assert.ok(withService, '必须产出 onPurge 控制选项')
  await withService.onPurge(42, failureTarget(42))
  assert.equal(probe.calls.request, 1, '必须走真实共享服务并发出一次 RPC（不是 dummy 算法）')
  assert.equal(probe.calls.wait, 1, 'normal 清理必须等同连接 wait')
  assert.equal(probe.calls.refresh, 1, 'wait 后必须定向 refresh')
  assert.equal(shared.lastArgs.failureTarget.turn, 42)
  assert.equal(lookups, 1, '实际注册表达式生成的读取函数在点击时取同一服务')

  // ③ 丢 props.storageUi ⇒ 零 RPC 且响亮拒绝（不得静默用别的通道清理）。
  const requestsBefore = probe.calls.request
  const withoutService = runSuperseded({ sessionId: 'session-child' })
  await assert.rejects(() => withoutService.onPurge(42, failureTarget(42)), /精简清理未接线/)
  assert.equal(probe.calls.request, requestsBefore, '缺服务必须零 RPC')

  // ④ turn-error-controls 侧只做 toggle/文案，不再插入 DOM 兜底。
  const turnSource = readCurrentAuthorSource('tavern-plugin/src/client/turn-error-controls.js')
  const turnOut = applyErrorPurgeTurnControlsTransform(turnSource)
  assert.equal(turnOut.includes('dsh-tavern-failure-fallback'), false, '不得再插入自有失败提示行')
  assert.equal(turnOut.includes('data-tavern-failure-cleanup'), false, '不得再写 DOM 兜底属性')
  assert.ok(turnOut.includes('options.onPurge'), '仍须保留 onPurge 接线')
})

function extractFunctionText(source, signature) {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, '必须能找到函数：' + signature)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error('函数体不闭合：' + signature)
}
