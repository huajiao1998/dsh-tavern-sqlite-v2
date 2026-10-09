// 干净清理错误前端变换：真实68215e夹具锚点+幂等+fail-closed+真实回调执行；不声称真实浏览器验收。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {applyErrorPurgeTurnControlsTransform,applyErrorPurgePlayControlsTransform} from '../deploy/error-purge-transform.mjs'
const FIX = '../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/src/client/'
test('干净清理1 turn-error-controls：toggle改清理+按钮改名+幂等',()=>{
  const src = readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8')
  const next = applyErrorPurgeTurnControlsTransform(src)
  assert.equal(applyErrorPurgeTurnControlsTransform(next), next)
  assert.equal(next.split('// [dsh-tavern-error-purge-turn:v1]').length - 1, 2)
  assert.ok(next.includes('干净清理错误'))
  assert.ok(next.includes('无法清理此错误'))
  assert.ok(next.includes("entry.toggle.title = purgeActive ? '' : (options.failureCleanupReason || '此错误不是当前可清理的最新失败轮')"))
  assert.ok(next.includes('options.onPurge'))
  assert.ok(next.includes('options.failureTarget'))
  assert.ok(next.includes('options.failureCleanupReason'))
  assert.ok(next.includes('entry.toggle.disabled = !purgeActive;'), '可清理资格必须每次 apply 双向写，目标后来活了能解除禁用')
  assert.ok(!next.includes('if (!purgeActive) entry.toggle.disabled = true;'), '禁止单向置禁用')
  assert.ok(next.includes('dsh-tavern-hidden-errors:'))
})
test('干净清理2 turn-error-controls：未知锚点fail-closed',()=>{
  assert.throws(()=>applyErrorPurgeTurnControlsTransform('// 空源'), /锚点/)
})
test('干净清理3 play-controls：onPurge附参+菜单同参+幂等',()=>{
  const src = readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8')
  const next = applyErrorPurgePlayControlsTransform(src)
  assert.equal(applyErrorPurgePlayControlsTransform(next), next)
  assert.equal(next.split('// [dsh-tavern-error-purge-play:v1]').length - 1, 3)
  assert.ok(next.includes('onToggle: undefined'))
  assert.ok(next.includes('const failureViewRef = React.useRef(state);'), 'SupersededTurnErrors 内须挂稳定 ref')
  assert.ok(next.includes('failureViewRef.current = state;'))
  assert.ok(next.includes('get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }'))
  assert.ok(next.includes("get failureCleanupReason() { return failureViewRef.current.view && failureViewRef.current.view.failureCleanupReason || '' }"))
  assert.ok(!next.includes('get failureTarget() { return state.view && state.view.failureTarget || null }'), '禁止闭包吃创建时快照')
  assert.ok(next.includes('const failureTargetKey = (function (view) {'), '键须自包含内联：拆分客户端单文件也会被本变换处理，不能引用 bundle 外符号')
  assert.ok(next.includes('target.rollbackId'), '键须含 pending 重试的 rollbackId')
  assert.ok(next.includes("[props.sessionId, revision, failureTargetKey]);"))
  assert.ok(!next.includes('[props.sessionId, revision]);'))
  assert.ok(next.includes('var current = failureViewRef.current.view;'))
  {
    const start = next.indexOf('function SupersededTurnErrors')
    const end = next.indexOf('// @include background-suppression.js', start)
    const body = next.slice(start, end)
    assert.ok(start > 0 && end > start, '须能定位真函数边界')
    assert.equal(body.split('const failureViewRef = React.useRef(state);').length - 1, 1)
    assert.equal(body.split('failureTargetKey').length - 1, 2, '键只在该函数内声明并用于依赖')
    assert.equal(next.split('const failureViewRef = React.useRef(state);').length - 1, 1, '注入不得外溢到其它函数')
  }
  assert.ok(next.includes('{ expectedTurn: turn, failureTarget: ft }'))
  assert.ok(next.includes('cleanedFailureTarget'))
  assert.ok(next.includes('alreadyClean'))
  assert.ok(next.includes('waitForTavernRollbackSync(rb.sync)'))
  assert.ok(next.includes('menuFailureTarget'))
  assert.ok(next.includes('当前没有可安全清理的失败目标'))
  assert.ok(!next.includes('expectedTurn: clearIncomplete ? null : targetTurn'))
  assert.ok(!next.includes('setFailedErrorVisibility", { sessionId: props.sessionId, turn: turn, hidden: hidden'))
})
test('干净清理4 play-controls：未知锚点fail-closed',()=>{
  assert.throws(()=>applyErrorPurgePlayControlsTransform('// 空源'), /锚点/)
})
// 真实回调执行：onPurge 附参+收据校验+同连接等待；失败保留、旧 target 零调用
function makeOnPurge(deps) {
  const {rpc, sessions, state, props, setCandidatePanel, setRegenPanel, setCandidateGuidePanel, liveTavernView, tavernCoordination} = deps
  return async (turn, failureTarget)=>{
    const ft = failureTarget || (state.view && state.view.failureTarget) || null
    if (!ft || !Number.isSafeInteger(turn) || turn < 1 || turn !== Number(ft.turn)) throw new Error('清理目标不是当前最新失败轮，拒绝清理')
    if (typeof sessions?.waitForTavernRollbackSync !== 'function') throw new Error('回退同步尚未接线')
    const resp = await rpc('rollbackTurn', {expectedTurn:turn, failureTarget:ft}, props.sessionId)
    const rb = resp && resp.view && resp.view.rolledBack
    if (!rb || !rb.cleanedFailureTarget) throw new Error('清理未确认目标失败轮，不更新本地状态')
    if (Number(rb.cleanedFailureTarget.turn) !== Number(ft.turn) || String(rb.cleanedFailureTarget.operationId) !== String(ft.operationId) || String(rb.cleanedFailureTarget.branchId) !== String(ft.branchId)) throw new Error('清理回执目标与请求不一致，拒绝更新')
    if (rb.alreadyClean === true) {
      liveTavernView.rebase(props.sessionId)
      tavernCoordination.refresh(props.sessionId)
      return resp
    }
    await sessions.waitForTavernRollbackSync(rb.sync)
    setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null)
    return resp
  }
}
test('干净清理5 onPurge真实执行：附参+同连接等待+成功路径', async ()=>{
  const ft = {chatId:'c1',sessionId:'s1',turn:7,branchId:'b1',revision:3,operationId:'op1'}
  const calls = []
  let waited = null
  const rpc = async (method, args, sid)=>{ calls.push([method,args,sid]); return {view:{rolledBack:{sync:{id:'r1'},cleanedFailureTarget:{turn:7,operationId:'op1',branchId:'b1'}}}} }
  const sessions = {waitForTavernRollbackSync: async (r)=>{ waited = r }}
  let panels = 0
  const deps = {rpc, sessions, state:{view:{failureTarget:ft}}, props:{sessionId:'s1', sessions}, setCandidatePanel:()=>{panels++}, setRegenPanel:()=>{panels++}, setCandidateGuidePanel:()=>{panels++}, liveTavernView:{invalidate:()=>{throw new Error('不应invalidate')}, rebase:()=>{throw new Error('不应rebase')}}, tavernCoordination:{invalidate:()=>{throw new Error('不应invalidate')}, refresh:()=>{throw new Error('不应refresh')}}}
  const onPurge = makeOnPurge(deps)
  const ret = await onPurge(7, ft)
  assert.deepEqual(calls[0], ['rollbackTurn', {expectedTurn:7, failureTarget:ft}, 's1'])
  assert.deepEqual(waited, {id:'r1'})
  assert.equal(panels, 3)
  assert.equal(ret.view.rolledBack.cleanedFailureTarget.turn, 7)
})
test('干净清理7 built组合：clientCoreWrites built含failureTarget/handler且语法', async ()=>{
  const {mkdtempSync, mkdirSync, writeFileSync: writeFs, readFileSync: readFs} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const path = (await import('node:path')).default
  const {spawnSync} = await import('node:child_process')
  const {clientCoreWrites} = await import('../deploy/client-seams.mjs')
  const fixRoot = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/', import.meta.url)
  const base = mkdtempSync(path.join(tmpdir(), 'tavern-error-purge-built-'))
  try {
    for (const rel of ['lib/client.js', 'src/client/main.js', 'src/client/turn-error-controls.js', 'src/client/features/play-controls.js', 'src/client/features/turn-history.js', 'src/client/ui/error-center.js', 'src/client/helper-resources.js', 'src/client/runtime/helper-bootstrap.js', 'src/client/runtime/helper-script-runtime.js', 'src/client/modules/tavern-coordination.js']) {
      const dst = path.join(base, 'tavern-plugin', rel)
      mkdirSync(path.dirname(dst), {recursive:true})
      writeFs(dst, readFileSync(new URL(rel, fixRoot), 'utf8'))
    }
    const writes = clientCoreWrites(base)
    const built = writes.get('tavern-plugin/lib/client.js')
    assert.ok(built.includes('干净清理错误'))
    assert.ok(built.includes('无法清理此错误'))
    assert.ok(built.includes('get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }'))
    assert.ok(built.includes("get failureCleanupReason() { return failureViewRef.current.view && failureViewRef.current.view.failureCleanupReason || '' }"))
    assert.ok(built.includes('const failureViewRef = React.useRef(state);'))
    assert.ok(built.includes('const failureTargetKey = (function (view) {'))
    assert.ok(built.includes('[props.sessionId, revision, failureTargetKey]);'))
    assert.ok(built.includes('entry.toggle.disabled = !purgeActive;'))
    assert.ok(built.includes('menuFailureTarget'))
    const tmp = path.join(base, 'check-built.mjs')
    writeFs(tmp, built)
    const r = spawnSync(process.execPath, ['--check', tmp], {encoding:'utf8'})
    assert.equal(r.status, 0, r.stderr)
  } finally {
    const {rmSync} = await import('node:fs')
    rmSync(base, {recursive:true, force:true})
  }
})
// 从真变换产物裁出真函数体执行：不手抄实现，锚点丢失即抛。
function extractFunction(source, header) {
  const start = source.indexOf(header)
  if (start < 0) throw new Error('裁函数失败：' + header)
  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error('函数体未闭合：' + header)
}
// 真产物里的 createTurnErrorControls（plain 函数、无 ESM 导出）：连同其产物头部一起取，不手抄实现。
// 模块外的自由符号（如 tavernProviderRefusalNotice）补空实现；产物内若自带同名定义会自然遮蔽它。
function realTurnErrorControls(transformedTurnControls) {
  const body = extractFunction(transformedTurnControls, 'function createTurnErrorControls(root, options)')
  const head = transformedTurnControls.slice(0, transformedTurnControls.indexOf(body))
  return (new Function('tavernProviderRefusalNotice', head + body + '\nreturn createTurnErrorControls'))(() => '')
}
// 目标身份夹具：pending 重试带 rollbackId、reason 走 view 的 failureCleanupReason。
function failureItem(turn, operationId, extra = {}) {
  return {chatId:'c1', sessionId:'s1', turn, branchId:'b1', revision:turn * 10, operationId, ...extra}
}
// 最小 DOM：够真 turn-error-controls 的 apply/onclick 跑完（不模拟无关浏览器行为）。
// 面板是通过 row.insertAdjacentElement('afterend', panel) 挂到 row 的父层，故记录在 root.appended。
function createFakeDom(rowTurn) {
  const doc = {createElement: tag => {
    const node = {tagName:String(tag).toUpperCase(), style:{display:''}, className:'', hidden:false, textContent:'', listeners:new Map(),
      children:[], attributes:{'data-chat-turn':String(rowTurn)}, removed:false, appended:[]}
    node.append = (...children) => { node.children.push(...children) }
    node.remove = () => { node.removed = true }
    node.insertAdjacentElement = (position, element) => { node.appended.push(element); return element }
    node.getAttribute = name => Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null
    node.setAttribute = (name, value) => { node.attributes[name] = String(value) }
    node.closest = () => null
    node.matches = () => false
    node.querySelector = () => null
    node.querySelectorAll = () => []
    node.addEventListener = (type, fn) => { if (!node.listeners.has(type)) node.listeners.set(type, []); node.listeners.get(type).push(fn) }
    node.click = () => { if (typeof node.onclick === 'function') node.onclick({type:'click'}); for (const fn of node.listeners.get('click') || []) fn({type:'click'}) }
    node.classList = {add: () => {}, remove: () => {}, contains: () => false}
    return node
  }}
  const row = doc.createElement('div')
  const root = {querySelectorAll: () => [row], contains: () => true, ownerDocument: doc, appended: []}
  row.insertAdjacentElement = (position, element) => { root.appended.push(element); return element }
  row.closest = selector => selector === '[data-conversation-scroll]' ? root : null
  // 面板内第 3 个子元素固定是 toggle（作者 append 顺序：label, details, toggle, replay, withdraw, rewind）
  const toggleOf = () => root.appended.at(-1).children[2]
  return {doc, row, root, toggleOf}
}
// 最小 React hook/effect harness：真函数 + hook slots 写回 hookSlots（ref 对象跨 render 稳定）
// + deps 比较后 cleanup/重建 + commit 前赋 ref。
function createSupersededHarness(source, dom, run) {
  const body = extractFunction(source, 'function SupersededTurnErrors(props)')
  const sandboxKeys = ['React','useLiveTavernView','latestTavernAssistantMessageId','createSupersededErrorProjection','createTurnErrorControls',
    'submitFailedTurnReplay','rpc','liveTavernView','tavernCoordination','historyProjection','tavernErrorHub','tavernProviderRefusalNotice',
    'observeTurnErrorProjection','setCandidatePanel','setRegenPanel','setCandidateGuidePanel','window']
  const sandbox = (new Function(...sandboxKeys, body + '\nreturn SupersededTurnErrors'))
  const captures = []
  const hookSlots = []
  const stores = []
  const DOM = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
  }
  let cursor = 0
  const put = (index, value) => { hookSlots[index] = value; return value }
  const React = {
    useRef(initial) { const index = cursor++; return put(index, hookSlots[index] || {value:{current:initial}}).value },
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = cursor++
      const slot = put(index, hookSlots[index] || {listeners:new Set()})
      slot.subscribe = subscribe
      slot.getSnapshot = getSnapshot
      slot.snapshot = slot.snapshot ?? getSnapshot()
      slot.pending = slot.snapshot
      if (!stores.includes(slot)) stores.push(slot)
      return slot.snapshot
    },
    useEffect(fn, deps) {
      const index = cursor++
      const slot = put(index, hookSlots[index] || {cleanup:null, deps:null, fn:null, runs:0})
      slot.fn = fn
      slot.deps = deps
      return slot.runs
    },
    createElement(type, props) { return {type, props, ref:props && props.ref || null} },
  }
  const sandboxEnv = {
    React,
    useLiveTavernView: () => run.currentState,
    latestTavernAssistantMessageId: () => 'm1',
    createSupersededErrorProjection: () => ({apply: () => {}, dispose: () => {}}),
    observeTurnErrorProjection: () => ({disconnect: () => {}}),
    createTurnErrorControls: (root, options) => { captures.push(options); run.created++; return {apply: () => {}, dispose: () => {}} },
    submitFailedTurnReplay: async () => {},
    rpc: (...args) => run.rpc(...args),
    liveTavernView: {invalidate: () => { run.invalidated++ }, rebase: () => { run.rebased++ }, setView: () => {}},
    tavernCoordination: {invalidate: () => {}, refresh: () => { run.refreshed++ }},
    historyProjection: {rolledBack: () => {}},
    tavernErrorHub: {report: (label, error) => { if (run.reported) run.reported.push([label, error]); else if (error) throw error }},
    tavernProviderRefusalNotice: () => '',
    setCandidatePanel: () => {}, setRegenPanel: () => {}, setCandidateGuidePanel: () => {},
    window: {...DOM, localStorage: {getItem: () => null, setItem: () => {}}},
  }
  function render(state) {
    cursor = 0
    // 订阅者通知：state 已换，但 effect 是否重建只由 deps 决定。
    for (const listener of run.listeners) listener(state)
    const element = sandbox(...sandboxKeys.map(key => sandboxEnv[key]))
      ({sessionId:'s1', sessions:run.sessions, useSession:subscribe => subscribe({running:false}), useChat:selector => selector({}), useInput:selector => selector({draft:''})})
    // commit：ref 在 effect 之前赋值（作者 closest 依赖它）
    if (element.ref) element.ref.current = dom.row
    for (const slot of stores) slot.snapshot = slot.getSnapshot()
    for (const slot of hookSlots) {
      if (!slot || !slot.fn) continue
      const first = slot.runs === 0
      const changed = !slot.deps || !slot.prevDeps || slot.deps.length !== slot.prevDeps.length
        || slot.deps.some((value, index) => !Object.is(value, slot.prevDeps[index]))
      if (first || changed) {
        if (slot.cleanup) { const cleanup = slot.cleanup; slot.cleanup = null; cleanup() }
        slot.cleanup = slot.fn() ?? null
        slot.runs++
      }
      slot.prevDeps = slot.deps ? [...slot.deps] : null
    }
    return element
  }
  return {render, captures, hookSlots, stores}
}
test('干净清理6 onPurge真实执行：alreadyClean分支+旧target零调用+失败保留', async ()=>{
  const ft = {chatId:'c1',sessionId:'s1',turn:7,branchId:'b1',revision:3,operationId:'op1'}
  let rpcCalls = 0, waited = 0, rebased = 0
  const rpc = async ()=>{ rpcCalls++; return {view:{rolledBack:{alreadyClean:true,cleanedFailureTarget:{turn:7,operationId:'op1',branchId:'b1'}}}} }
  const sessions = {waitForTavernRollbackSync: async ()=>{ waited++ }}
  const deps = {rpc, sessions, state:{view:{failureTarget:ft}}, props:{sessionId:'s1', sessions}, setCandidatePanel:()=>{}, setRegenPanel:()=>{}, setCandidateGuidePanel:()=>{}, liveTavernView:{rebase:()=>{rebased++}}, tavernCoordination:{refresh:()=>{rebased++}}}
  const onPurge = makeOnPurge(deps)
  await onPurge(7, ft)
  assert.equal(rpcCalls, 1)
  assert.equal(waited, 0)
  assert.equal(rebased, 2)
  await assert.rejects(onPurge(6, ft), /不是当前最新失败轮/)
  assert.equal(rpcCalls, 1)
  const badRpc = async ()=>{ throw new Error('后端拒绝：目标已变化') }
  const onPurgeBad = makeOnPurge({...deps, rpc: badRpc})
  await assert.rejects(onPurgeBad(7, ft), /后端拒绝/)
})
// 以下三条为真产物生命周期验收：真变换函数 + 稳定 hook slots + 真按钮 click。
test('干净清理8 前端生命周期：同身份不重建且getter活取；目标revision/rollbackId/reason变化必重建', ()=>{
  const src = readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8')
  const transformed = applyErrorPurgePlayControlsTransform(src)
  const dom = createFakeDom(7)
  const run = {currentState:null, listeners:[], sessions:{waitForTavernRollbackSync: async () => {}}, invalidated:0, rebased:0, refreshed:0, created:0,
    rpc: async () => ({view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget:{turn:7, operationId:'opA', branchId:'b1'}}}})}
  const harness = createSupersededHarness(transformed, dom, run)
  const view = (target, reason = '') => ({view:{failureTarget:target, failureCleanupReason:reason, suppressedDshErrorTurns:['7'], hiddenDshErrorTurns:['7'], staleDshErrorTurns:[], filteredFailureStreak:0, canRegenerate:false, canReplayFailedTurn:true, replayFailedTurn:7}})
  const targetA = failureItem(7, 'opA')
  run.currentState = view(targetA)
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 1, '首个 render 应建控件：marker ref 须在 effect 前就绪')
  assert.equal(harness.captures[0].failureTarget.turn, 7)
  assert.equal(harness.hookSlots.filter(slot => slot && slot.fn).length, 1, 'SupersededTurnErrors 只有一个 effect')
  // 同身份、新 state、新 target 对象：effect 不重建，但 getter 必须活取当前对象
  const targetA2 = failureItem(7, 'opA')
  run.currentState = view(targetA2)
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 1, '相同目标身份不得重建控制器')
  assert.equal(harness.captures[0].failureTarget, targetA2, '旧 options 的 getter 必须读 ref 当前视图，不得停在创建时快照')
  // revision 变化（同一 turn 的新存储版本）→ 必须重建
  const targetB = failureItem(7, 'opA', {revision:99})
  run.currentState = view(targetB)
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 2, '目标 revision 变化必须重建（旧凭据不得续用）')
  assert.equal(harness.captures[1].failureTarget, targetB)
  // rollbackId 变化（pending 重试身份）→ 必须重建
  const targetC = failureItem(7, 'opA', {rollbackId:'rb9'})
  run.currentState = view(targetC)
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 3, 'rollbackId 变化必须重建')
  // reason 变化 → 必须重建（按钮说明随之刷新）
  run.currentState = view(targetC, '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理')
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 4, 'failureCleanupReason 变化必须重建')
  assert.equal(harness.captures[3].failureCleanupReason, '当前失败缺少可靠发轮前基准或已不是最新尾部，不能安全清理')
})
test('干净清理9 真产物点击链：real onPurge 用 ref 当前目标发 RPC', async ()=>{
  const src = readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8')
  const transformed = applyErrorPurgePlayControlsTransform(src)
  const dom = createFakeDom(7)
  const calls = []
  let waited = null
  const reported = []
  const run = {currentState:null, listeners:[], sessions:{waitForTavernRollbackSync: async sync => { waited = sync }}, created:0, invalidated:0, rebased:0, refreshed:0, reported,
    rpc: async (method, args, sid) => { calls.push([method, args, sid]); const ft = args.failureTarget
      return {view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget:{turn:ft.turn, operationId:ft.operationId, branchId:ft.branchId}}}} }}
  const harness = createSupersededHarness(transformed, dom, run)
  const makeView = target => ({view:{failureTarget:target, failureCleanupReason:'', suppressedDshErrorTurns:['7'], hiddenDshErrorTurns:['7'], staleDshErrorTurns:[], filteredFailureStreak:0, canRegenerate:false, canReplayFailedTurn:true, replayFailedTurn:7}})
  run.currentState = makeView(failureItem(7, 'opA'))
  harness.render(run.currentState)
  // operationId 改变（身份键变化）触发重建；旧 options 也须通过稳定 ref 取得新目标
  const targetB = failureItem(7, 'opB')
  run.currentState = makeView(targetB)
  harness.render(run.currentState)
  const options = harness.captures[0]
  assert.equal(options.failureTarget, targetB)
  // 用真产物里的 createTurnErrorControls（来自同链变换的 turn-error-controls 单文件；含其模块级依赖）+ 最小 DOM 跑真实点击链
  const controls = realTurnErrorControls(applyErrorPurgeTurnControlsTransform(readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8')))(dom.root, options)
  controls.apply()
  const button = dom.toggleOf()
  assert.equal(button.disabled, false, '目标活跃时不得禁用')
  button.click()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(reported.map(entry => String(entry[1] && entry[1].message)), [], 'onError 不得被触发（否则清理链已中断）')
  assert.deepEqual(calls[0], ['rollbackTurn', {expectedTurn:7, failureTarget:targetB}, 's1'], 'onPurge 必须发送 ref 当前目标')
  assert.deepEqual(waited, {id:'r1'})
  controls.dispose()
})
test('干净清理10 真产物可清理资格双向：换目标再换回必须解除禁用', ()=>{
  const transformed = applyErrorPurgeTurnControlsTransform(readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8'))
  const dom = createFakeDom(7)
  const options = {sessionId:'s1', storage:{getItem: () => null, setItem: () => {}}, hiddenTurns:['7'], replayTurn:7,
    staleTurns:[], filteredStreak:0, canRewind:false,
    failureTarget:{turn:7, operationId:'opA', branchId:'b1', revision:70},
    failureCleanupReason:'', onPurge: async () => ({}), onError: () => {}}
  const controls = realTurnErrorControls(transformed)(dom.root, options)
  const toggle = () => dom.toggleOf()
  controls.apply()
  assert.equal(toggle().disabled, false, '目标活跃时可用')
  assert.equal(toggle().textContent, '干净清理错误')
  options.failureTarget = {turn:9, operationId:'opB', branchId:'b1', revision:90}
  options.failureCleanupReason = '不是最新失败'
  controls.apply()
  assert.equal(toggle().disabled, true, '目标不匹配时禁用')
  assert.equal(toggle().title, '不是最新失败')
  options.failureTarget = {turn:7, operationId:'opA', branchId:'b1', revision:71}
  options.failureCleanupReason = ''
  controls.apply()
  assert.equal(toggle().disabled, false, '目标恢复活跃必须解除禁用（原实现单向置 true 会永久卡死）')
  assert.equal(toggle().textContent, '干净清理错误')
  controls.dispose()
})
