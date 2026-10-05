// 只验证真实 client 的 React 桥、主题 CSS、RPC 与原生分叉调用契约；不联网、不读真实档。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { setImmediate } from 'node:timers/promises'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const original = { migrated: false, legacy: true, readonly: true, stamp: 'legacy:1:2', forked: false, pending: false }
const database = { migrated: true, legacy: false, readonly: false, stamp: 'sqlite:gen:1' }
const plan = { sourceChatId: 'chat-source', sourceSessionId: 'session-genuine', sourceRevision: 7, turn: 2, atSeq: 3, targetTitle: 'DB.原名' }
const claim = { ...plan, token: 'test-token', state: 'claimed' }
const target = 'session-target'
const norm = value => JSON.parse(JSON.stringify(value))
const sameDeps = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
const find = (node, type) => node?.type === type ? node : (node?.children || []).map(child => find(child, type)).find(Boolean)
const findAll = (node, type) => [...(node?.type === type ? [node] : []),
  ...(node?.children || []).flatMap(child => child && typeof child === 'object' ? findAll(child, type) : [])]
const text = node => typeof node === 'string' ? node : (node?.children || []).map(text).join('')
function harness(options = {}) {
  const trace = [], cells = [], effects = [], disposers = [], provided = new Map()
  let cursor = 0, tree, plugin, currentProps = { sessionId: 'session-source' }, status = { ...original, ...(options.status || {}) }
  let released = false
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() } },
    useState(initial) {
      const i = cursor++
      if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial }
      return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }]
    },
    useRef(initial) { const i = cursor++; if (!cells[i]) cells[i] = { current: initial }; return cells[i] },
    useCallback(callback) { cursor++; return callback },
    useEffect(effect, deps) {
      const i = cursor++, prev = cells[i]
      if (!prev || !sameDeps(prev.deps, deps)) effects.push(() => { prev?.cleanup?.(); cells[i] = { deps, cleanup: effect() } })
    },
  }
  const fetch = async (url, request) => {
    const method = url.split('/').at(-1), body = JSON.parse(request.body)
    assert.match(method, /^sqliteSave(Status|Prepare|Claim|Complete|Recover|Release)$/)
    assert.equal(request.method, 'POST'); assert.equal(request.headers['Content-Type'], 'application/json')
    assert.ok(request.signal instanceof AbortSignal)
    trace.push({ kind: method, body })
    if (method === 'sqliteSaveComplete' && options.completeDelay) await options.completeDelay
    if (options.failAt === method) return { ok: false, status: 409, json: async () => ({ ok: false, error: '测试拒绝：' + method }) }
    if (options.failStatusAfterRelease && method === 'sqliteSaveStatus' && released) {
      return { ok: false, status: 503, json: async () => ({ ok: false, error: '测试拒绝：状态刷新' }) }
    }
    let result
    if (method === 'sqliteSaveStatus') result = status
    if (method === 'sqliteSavePrepare') result = plan
    if (method === 'sqliteSaveClaim') { result = claim; status = { ...status, pending: true } }
    if (method === 'sqliteSaveComplete' || method === 'sqliteSaveRecover') {
      result = { ...database, sessionId: target, chatId: 'chat-target', ...options.complete }
      status = { ...status, forked: true, pending: false }
    }
    if (method === 'sqliteSaveRelease') {
      result = { released: true, ...options.release }
      released = true
      // 释放成功后服务端不再有记录：状态回到「只读原档、无任何分叉」。
      status = { ...original, ...(options.releaseStatus || {}) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, ...result }) }
  }
  const sessions = {
    async fork(args) {
      trace.push({ kind: 'fork', args: norm(args) })
      if (options.failAt === 'fork') throw new Error('测试拒绝：fork')
      return Object.hasOwn(options, 'target') ? options.target : target
    },
    async open(id) { trace.push({ kind: 'open', id }) },
    subagentAddress(id) { return id === 'session-child' ? { parentSessionId: 'session-source' } : undefined },
  }
  const ctx = {
    sessions: options.noFork ? { open: sessions.open } : sessions,
    get(name) { throw new Error('当前不消费未经rc.2核实的Client服务：' + name) },
    provide(name, value) { provided.set(name, value); disposers.push(() => provided.delete(name)) },
    effect(effect) { const dispose = effect(); assert.equal(typeof dispose, 'function'); disposers.push(dispose); return dispose },
    emit(name) { assert.equal(name, 'tavern-storage-ui/change') },
  }
  for (const key of ['remote', 'commands', 'slots']) Object.defineProperty(ctx, key, { get() { throw new Error('不得访问 ' + key) } })
  vm.runInNewContext(source, { AbortSignal, fetch, window: { __ModuleLoader__: { load(definition) {
    plugin = definition.factory(name => { assert.equal(name, 'react'); return React })
  } } } }, { timeout: 1000 })
  assert.deepEqual(Array.from(plugin.inject), ['sessions'])
  plugin.apply(ctx)
  const ui = provided.get('tavernStorageUi')
  assert.equal(ui.active, true)
  function render(props = currentProps) {
    currentProps = props
    const element = ui.renderSavePanel(props)
    if (!element) { tree = null; return tree }
    assert.equal(element.props.key, element.props.sessionId)
    cursor = 0; tree = element.type(element.props)
    while (effects.length) effects.shift()()
    return tree
  }
  return {
    trace, options, render,
    setStatus(next) { status = next },
    async settle() { await setImmediate(); return render() },
    button() { return find(tree, 'button') },
    buttons() { return findAll(tree, 'button') },
    text() { return text(tree) },
    tree() { return tree },
    ui,
    close() { for (const cell of cells) cell?.cleanup?.(); for (const dispose of disposers.reverse()) dispose() },
  }
}
assert.doesNotMatch(source, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, '配色不写死')
assert.doesNotMatch(source, /VariableViewer|sqliteVariablesQuery|conversation\.input\.dock|querySelector|MutationObserver/)
for (const state of [':hover', ':active', ':focus-visible', ':disabled']) assert.ok(source.includes(state))
assert.match(source, /var\(--dsw-alias-brand-primary\)/)

// 挂载只读，完整状态到达前禁用；不可凭readonly独自判定。
const h = harness(); h.render(); assert.equal(h.button().props.disabled, true)
assert.match(h.button().props.className, /dsh-tavern-btn/)
assert.match(h.tree().props.className, /dsh-tavern-status-section/)
const firstPanel = h.ui.renderSavePanel({ sessionId: 'session-source' })
const switchedPanel = h.ui.renderSavePanel({ sessionId: 'session-switched' })
assert.equal(switchedPanel.props.sessionId, 'session-switched'); assert.notEqual(switchedPanel.props.key, firstPanel.props.key)
await h.settle(); assert.equal(h.button().props.disabled, false); assert.equal(h.trace.length, 1)
const staleClick = h.button().props.onClick
const clicked = staleClick(); const duplicate = staleClick()
h.render(); assert.equal(h.button().props.disabled, true)
await Promise.all([clicked, duplicate]); await h.settle()
assert.deepEqual(h.trace.map(row => row.kind), ['sqliteSaveStatus', 'sqliteSavePrepare', 'sqliteSaveClaim', 'fork', 'sqliteSaveComplete', 'open'])
assert.deepEqual(h.trace[3].args, { sessionId: plan.sourceSessionId, atSeq: plan.atSeq, increaseTitle: false })
assert.equal(h.trace[4].body.token, claim.token); assert.equal(h.trace[4].body.targetSessionId, target)
assert.equal(h.button().props.disabled, true); assert.match(h.text(), /已创建数据库分叉/)
h.close(); assert.equal(h.ui.active, false); assert.equal(h.ui.renderSavePanel({ sessionId: 'session-source' }), null)

for (const status of [database, { ...database, readonly: true }, { readonly: false }, { readonly: 'true' },
  { ...original, forked: true }, { ...original, pending: true }, { ...original, pending: undefined }, { ...original, legacy: undefined }]) {
  const x = harness({ status }); x.render(); await x.settle()
  if (status === database) assert.equal(x.tree(), null, '只有确证SQLite目标才隐藏')
  else assert.equal(x.button().props.disabled, true)
  assert.equal(x.trace.length, 1); x.close()
}

// 重载恢复只走持久冻结目标，不prepare/claim/native fork；未知SID仍禁。
for (const state of ['bound','created']) {
  const x=harness({status:{...original,pending:true,recoverable:true,targetInfo:{state,targetSessionId:target}}})
  x.render();await x.settle();assert.equal(x.button().props.disabled,false);assert.match(x.text(),/重试完成已有分叉/)
  await x.button().props.onClick();await x.settle();assert.deepEqual(x.trace.map(row=>row.kind),['sqliteSaveStatus','sqliteSaveRecover','open']);assert.equal(x.trace[1].body.targetSessionId,target);x.close()
}
for (const targetInfo of [{state:'claimed',targetSessionId:target},{state:'bound',targetSessionId:''},{state:'bound',targetSessionId:'session-source'}]) {
  const x=harness({status:{...original,pending:true,recoverable:true,targetInfo}});x.render();await x.settle();assert.equal(x.button().props.disabled,true);x.close()
}
// 分段失败不得open，也不自动fork；已知SID允许同token重试，未知SID禁再次创建。
for (const failAt of ['sqliteSaveStatus', 'sqliteSavePrepare', 'sqliteSaveClaim', 'fork', 'sqliteSaveComplete']) {
  const x = harness({ failAt }); x.render(); await x.settle()
  if (failAt !== 'sqliteSaveStatus') { await x.button().props.onClick(); await x.settle() }
  assert.match(x.text(), /测试拒绝/); assert.equal(x.trace.some(row => row.kind === 'open'), false)
  const forks = x.trace.filter(row => row.kind === 'fork').length
  if (failAt === 'fork') { assert.equal(x.button().props.disabled, true); await x.button().props.onClick(); assert.equal(x.trace.filter(row => row.kind === 'fork').length, forks) }
  if (failAt === 'sqliteSaveComplete') {
    assert.equal(x.button().props.disabled, false); assert.match(x.text(), /重试完成已有分叉/)
    x.options.failAt = undefined; await x.button().props.onClick(); await x.settle()
    assert.equal(x.trace.filter(row => row.kind === 'fork').length, 1)
    assert.equal(x.trace.filter(row => row.kind === 'sqliteSaveClaim').length, 1)
    assert.equal(x.trace.filter(row => row.kind === 'open').length, 1)
  }
  x.close()
}
for (const bad of ['', null, plan.sourceSessionId]) {
  const x = harness({ target: bad }); x.render(); await x.settle(); await x.button().props.onClick(); await x.settle()
  assert.match(x.text(), /独立的新会话/); assert.equal(x.button().props.disabled, true)
  assert.equal(x.trace.some(row => row.kind === 'sqliteSaveComplete'), false); x.close()
}
for (const complete of [{ stamp: 'author-native' }, { chatId: plan.sourceChatId }, { sessionId: plan.sourceSessionId }]) {
  const x = harness({ complete }); x.render(); await x.settle(); await x.button().props.onClick(); await x.settle()
  assert.match(x.text(), /未确认独立的数据库目标/); assert.equal(x.trace.some(row => row.kind === 'open'), false); x.close()
}
const child = harness(); child.render({ sessionId: 'session-child' }); await child.settle()
assert.equal(child.trace[0].body.sessionId, 'session-source'); child.close()
const missing = harness({ noFork: true }); missing.render(); await missing.settle(); await missing.button().props.onClick(); await missing.settle()
assert.equal(missing.trace.some(row => row.kind === 'sqliteSavePrepare'), false); missing.close()
// 卸载后在途complete回执不能打开会话（请求本身可能已经落盘，不虚构取消）。
let releaseComplete
const completeDelay = new Promise(resolve => { releaseComplete = resolve })
const inFlight = harness({ completeDelay }); inFlight.render(); await inFlight.settle()
const pendingClick = inFlight.button().props.onClick(); await setImmediate()
assert.equal(inFlight.trace.filter(row => row.kind === 'sqliteSaveComplete').length, 1)
inFlight.close(); releaseComplete(); await pendingClick
assert.equal(inFlight.trace.some(row => row.kind === 'open'), false)

// 卸载时即使旧handler仍被持有也不触发RPC/native fork。
const disposed = harness(); disposed.render(); await disposed.settle()
const oldHandler = disposed.button().props.onClick; disposed.close()
await oldHandler(); assert.equal(disposed.trace.length, 1)

// ---- 目标已删除（status: forked=true/pending=false/targetExists=false）→ 独立释放按钮，显式两次动作 ----
const orphanStatus = { ...original, forked: true, pending: false, targetExists: false,
  targetInfo: { state: 'complete', targetChatId: 'chat-old', targetSessionId: 'session-old' } }
const orphan = harness({ status: orphanStatus }); orphan.render(); await orphan.settle()
assert.equal(orphan.button().props.disabled, true, '释放前不得直接重新创建')
assert.equal(orphan.buttons().length, 2, '目标缺失时给出独立释放按钮')
const releaseButton = orphan.buttons()[1]
assert.notEqual(releaseButton, orphan.button())
assert.match(releaseButton.props.className, /dsh-sqlite-save__release-button/)
assert.match(text(releaseButton), /目标已删除，允许重新创建/)
assert.match(orphan.text(), /不会删除原生会话，也不会自动创建/)
assert.equal(orphan.trace.some(row => row.kind === 'fork'), false, '读到目标缺失不得自动 fork')
await releaseButton.props.onClick(); await orphan.settle()
assert.deepEqual(orphan.trace.map(row => row.kind), ['sqliteSaveStatus', 'sqliteSaveRelease', 'sqliteSaveStatus'])
// 释放只送 status 给出的目标身份（外加 sessionId），不送 token/plan。
assert.deepEqual(orphan.trace[1].body,
  { targetChatId: 'chat-old', targetSessionId: 'session-old', sessionId: 'session-source' })
assert.equal(orphan.trace.some(row => row.kind === 'fork'), false, '释放不代 fork')
assert.equal(orphan.trace.some(row => row.kind === 'sqliteSavePrepare'), false, '释放不代 prepare')
assert.match(orphan.text(), /已释放/)
assert.equal(orphan.buttons().length, 1, '释放成功后按钮消失，回到单一创建按钮')
assert.equal(orphan.button().props.disabled, false)
await orphan.button().props.onClick(); await orphan.settle()
assert.deepEqual(orphan.trace.map(row => row.kind), ['sqliteSaveStatus', 'sqliteSaveRelease', 'sqliteSaveStatus',
  'sqliteSavePrepare', 'sqliteSaveClaim', 'fork', 'sqliteSaveComplete', 'open'])
assert.equal(orphan.trace.filter(row => row.kind === 'fork').length, 1, '用户再次点击才 fork 一次')
orphan.close()

// 释放门 fail-closed：pending 未知/目标存在/不完整或非 complete 的 targetInfo 一律不给释放按钮。
const noRelease = [
  { ...orphanStatus, pending: true },
  { ...orphanStatus, pending: undefined },
  { ...orphanStatus, targetExists: undefined },
  { ...orphanStatus, targetExists: true },
  { ...orphanStatus, targetInfo: undefined },
  { ...orphanStatus, targetInfo: { state: 'claimed', targetChatId: 'chat-old', targetSessionId: 'session-old' } },
  { ...orphanStatus, targetInfo: { state: 'complete', targetChatId: '', targetSessionId: 'session-old' } },
  { ...orphanStatus, targetInfo: { state: 'complete', targetChatId: 'chat-old' } },
  { ...orphanStatus, migrated: true },
]
for (const status of noRelease) {
  const x = harness({ status }); x.render(); await x.settle()
  assert.equal(x.buttons().length, 1, '未知/pending/不完整目标信息不得放行释放')
  assert.equal(x.button().props.disabled, true); x.close()
}
const staleMissing = harness({ status: { ...orphanStatus, forked: false } })
staleMissing.render(); await staleMissing.settle()
assert.equal(staleMissing.buttons().length, 1, 'forked=false 不是释放场景，走正常创建')
assert.equal(staleMissing.button().props.disabled, false); staleMissing.close()

// 目标在本页创建之后才被删除：释放失败保留已 done 的本地尝试；释放成功才清，且始终不代 fork。
const late = harness(); late.render(); await late.settle()
await late.button().props.onClick(); await late.settle()
assert.equal(late.trace.filter(row => row.kind === 'fork').length, 1)
late.setStatus(orphanStatus); late.options.failAt = 'sqliteSaveRelease'
late.render({ sessionId: 'session-switched' }); await late.settle()
late.render({ sessionId: 'session-source' }); await late.settle()
assert.equal(late.buttons().length, 2, '重挂后仍按 status 给出释放按钮')
await late.buttons()[1].props.onClick(); await late.settle()
assert.match(late.text(), /测试拒绝/)
assert.equal(late.buttons().length, 2, '释放失败保留释放按钮与已 done 的本地尝试')
assert.equal(late.button().props.disabled, true, '释放失败不得清掉 done 尝试（它仍挡着重新创建）')
assert.equal(late.trace.filter(row => row.kind === 'fork').length, 1, '释放失败不代 fork')
late.options.failAt = undefined
await late.buttons()[1].props.onClick(); await late.settle()
assert.equal(late.buttons().length, 1)
assert.equal(late.button().props.disabled, false, '释放成功清掉 done 尝试后才能重新创建')
assert.equal(late.trace.filter(row => row.kind === 'fork').length, 1, '释放本身绝不 fork')
await late.button().props.onClick(); await late.settle()
assert.equal(late.trace.filter(row => row.kind === 'fork').length, 2, '用户第二次显式点击才创建新分叉')
late.close()

// 释放已成功但随后的状态刷新失败：不谎称失败，也不留着释放按钮挡住重新创建。
const refreshFail = harness({ status: orphanStatus, failStatusAfterRelease: true })
refreshFail.render(); await refreshFail.settle()
await refreshFail.buttons()[1].props.onClick(); await refreshFail.settle()
assert.match(refreshFail.text(), /已释放/)
assert.equal(refreshFail.buttons().length, 1)
assert.equal(refreshFail.button().props.disabled, false)
assert.equal(refreshFail.trace.filter(row => row.kind === 'fork').length, 0, '刷新失败也不代 fork')
refreshFail.close()

// 对账：服务端已无记录（forked=false/pending=false）时只清**已成功完成**的本地尝试。
const settled = harness(); settled.render(); await settled.settle()
await settled.button().props.onClick(); await settled.settle()
assert.equal(settled.trace.filter(row => row.kind === 'fork').length, 1)
settled.setStatus({ ...original })
settled.render({ sessionId: 'session-switched' }); await settled.settle()
settled.render({ sessionId: 'session-source' }); await settled.settle()
assert.equal(settled.button().props.disabled, false, '已 done 的陈旧尝试被对账清掉')
assert.equal(settled.trace.filter(row => row.kind === 'fork').length, 1, '对账绝不代 fork')
await settled.button().props.onClick(); await settled.settle()
assert.equal(settled.trace.filter(row => row.kind === 'fork').length, 2)
settled.close()
// 未完成（有 SID）的尝试不被对账清掉：只补 complete 收口，不重新 claim/fork。
const unfinished = harness({ failAt: 'sqliteSaveComplete' })
unfinished.render(); await unfinished.settle(); await unfinished.button().props.onClick(); await unfinished.settle()
unfinished.setStatus({ ...original })
unfinished.render({ sessionId: 'session-switched' }); await unfinished.settle()
unfinished.render({ sessionId: 'session-source' }); await unfinished.settle()
assert.equal(unfinished.button().props.disabled, false, '未完成尝试保留 → 允许重试收口')
unfinished.options.failAt = undefined
await unfinished.button().props.onClick(); await unfinished.settle()
assert.equal(unfinished.trace.filter(row => row.kind === 'fork').length, 1, '重试不重新 fork')
assert.equal(unfinished.trace.filter(row => row.kind === 'sqliteSaveClaim').length, 1, '重试不重新 claim')
assert.equal(unfinished.trace.filter(row => row.kind === 'open').length, 1)
unfinished.close()
// 无 SID 的未知尝试同样不被对账清掉：按钮保持禁用，且点击不发任何 RPC。
const unknownAttempt = harness({ failAt: 'fork' })
unknownAttempt.render(); await unknownAttempt.settle(); await unknownAttempt.button().props.onClick(); await unknownAttempt.settle()
assert.match(unknownAttempt.text(), /操作结果尚未确认/)
unknownAttempt.setStatus({ ...original })
unknownAttempt.render({ sessionId: 'session-switched' }); await unknownAttempt.settle()
unknownAttempt.render({ sessionId: 'session-source' }); await unknownAttempt.settle()
assert.equal(unknownAttempt.button().props.disabled, true, '无 SID 的未知尝试不得被对账清掉')
assert.match(unknownAttempt.text(), /操作结果尚未确认/)
const beforeUnknown = unknownAttempt.trace.length
await unknownAttempt.button().props.onClick(); await unknownAttempt.settle()
assert.equal(unknownAttempt.trace.length, beforeUnknown, '未知尝试不许再发任何 RPC')
unknownAttempt.close()
console.log('client-manual-fork：React服务桥/主题状态/变量入口取消/确证SQLite隐藏/旧档禁用/claim单次fork/同SID重试与失败拦截/目标缺失显式释放与done对账通过（离线契约，非页面验收）')
