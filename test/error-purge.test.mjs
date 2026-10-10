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
  // built/inline 布局（本夹具没有作者 wait 行）：追加 clearIncomplete 专用 wait+refresh；旧软视图行只包菜单内一处；不 double wait
  assert.equal(next.split('waitForTavernRollbackSync(result?.view?.rolledBack?.sync)').length - 1, 0, '本布局不得出现作者 wait 文本')
  assert.equal(next.split('await props.sessions.waitForTavernRollbackSync(result && result.view && result.view.rolledBack && result.view.rolledBack.sync);').length - 1, 1, 'clearIncomplete 专用 wait 恰一处（不 double wait）')
  assert.ok(next.includes('if (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) {'), 'alreadyClean 不等待')
  assert.equal(next.split('if (!clearIncomplete) historyProjection.rolledBack(props.sessionId, result && result.view);').length - 1, 1, '只包菜单内那一处软视图行（同文件另两处不动）')
  assert.equal(next.split('var targetCompare = function (ft, cft) {').length - 1, 2, '同一 targetCompare 文本面板/菜单各内联一次')
  assert.equal(next.split('targetCompare(').length - 1, 3, '调用恰 3 处：面板 old-ft 过期核对 + 面板回执核对 + 菜单回执核对')
  // 本布局（built/inline）的 clear-only guard 与回执必需：缺 sync / 缺回执都必须响亮失败，不静默越过
  assert.equal(next.split('if (clearIncomplete && typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行清理");').length - 1, 1, 'built/inline 需 clear-only sync guard（RPC 前）')
  assert.ok(next.includes("if (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.cleanedFailureTarget)) throw new Error('清理未确认目标失败轮，不更新本地状态');"), '清理场景缺回执必须 throw')
  assert.ok(next.includes('if (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) {'), 'clear-only wait 块以 alreadyClean 排除（normal 不动）')
  assert.ok(next.includes('await props.sessions.waitForTavernRollbackSync(result && result.view && result.view.rolledBack && result.view.rolledBack.sync);'), '正常等待一律 await（无 typeof 跳过）')
  assert.ok(!next.includes('typeof props.sessions?.waitForTavernRollbackSync === "function") await'), '禁止 if(typeof) 跳过等待')
  assert.ok(next.includes('清理目标已过期（与当前视图不一致）'), 'old ft 必须与当前视图目标做身份核对')
  assert.ok(next.includes('eventCount !== ft.endSeq + 1') && next.includes('native 不得带 operationId'), 'native 形状：eventCount=endSeq+1 且 operationId undefined')
})
test('干净清理4 play-controls：未知锚点fail-closed',()=>{
  assert.throws(()=>applyErrorPurgePlayControlsTransform('// 空源'), /锚点/)
})
// 与注入文本同义的本地比较器（测试 5/6 的镜像用；真产物断言见干净清理3/7/11/12/13）。
function targetCompare(ft, cft) {
  if (!ft || !cft || typeof ft !== 'object' || typeof cft !== 'object') return '目标缺失'
  const kindOf = value => value === 'native-only' ? 'native-only' : (value === undefined || value === 'body' ? 'body' : null)
  const ftKind = kindOf(ft.kind), cftKind = kindOf(cft.kind)
  if (ftKind === null || cftKind === null || ftKind !== cftKind) return 'kind 不一致'
  if (!Number.isSafeInteger(cft.turn) || Number(cft.turn) !== Number(ft.turn)) return 'turn 不一致'
  if (typeof ft.branchId !== 'string' || ft.branchId === '' || cft.branchId !== ft.branchId) return 'branchId 不一致'
  if (!Number.isSafeInteger(cft.revision) || !Number.isSafeInteger(ft.revision) || Number(cft.revision) !== Number(ft.revision)) return 'revision 不一致'
  if (ftKind === 'native-only') {
    if (ft.operationId !== undefined || cft.operationId !== undefined) return 'native 不得带 operationId'
    if (!Number.isSafeInteger(ft.endSeq) || ft.endSeq <= 0 || !Number.isSafeInteger(ft.eventCount) || ft.eventCount !== ft.endSeq + 1) return 'native 目标形状不合法'
    if (!Number.isSafeInteger(cft.endSeq) || cft.endSeq <= 0 || !Number.isSafeInteger(cft.eventCount) || cft.eventCount !== cft.endSeq + 1) return 'native 回执形状不合法'
    if (Number(cft.endSeq) !== Number(ft.endSeq) || Number(cft.eventCount) !== Number(ft.eventCount)) return 'native 身份不一致'
  } else if (typeof cft.operationId !== 'string' || cft.operationId === '' || cft.operationId !== ft.operationId) return 'operationId 不一致'
  if (typeof ft.chatId === 'string' && typeof cft.chatId === 'string' && cft.chatId !== ft.chatId) return 'chatId 不一致'
  if (typeof ft.sessionId === 'string' && typeof cft.sessionId === 'string' && cft.sessionId !== ft.sessionId) return 'sessionId 不一致'
  return ''
}
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
    const cft = rb.cleanedFailureTarget
    const mismatch = targetCompare(ft, cft)
    if (mismatch !== '') throw new Error('清理回执目标与请求不一致，拒绝更新：' + mismatch)
    if (rb.alreadyClean === true) {
      liveTavernView.rebase(props.sessionId)
      tavernCoordination.invalidate(props.sessionId) // 作者真接口（服务级 refresh 不存在）
      return resp
    }
    await sessions.waitForTavernRollbackSync(rb.sync)
    setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null)
    liveTavernView.rebase(props.sessionId)
    tavernCoordination.invalidate(props.sessionId)
    return resp
  }
}
test('干净清理5 onPurge真实执行：附参+同连接等待+成功路径（收据核 revision 并 rebase+refresh）', async ()=>{
  const ft = {chatId:'c1',sessionId:'s1',turn:7,branchId:'b1',revision:3,operationId:'op1'}
  const calls = []
  let waited = null
  const rpc = async (method, args, sid)=>{ calls.push([method,args,sid]); return {view:{rolledBack:{sync:{id:'r1'},cleanedFailureTarget:{turn:7,operationId:'op1',branchId:'b1',revision:3}}}} }
  const sessions = {waitForTavernRollbackSync: async (r)=>{ waited = r }}
  let panels = 0, rebased = 0, refreshed = 0
  const deps = {rpc, sessions, state:{view:{failureTarget:ft}}, props:{sessionId:'s1', sessions}, setCandidatePanel:()=>{panels++}, setRegenPanel:()=>{panels++}, setCandidateGuidePanel:()=>{panels++}, liveTavernView:{invalidate:()=>{throw new Error('不应invalidate')}, rebase:()=>{rebased++}}, tavernCoordination:{invalidate:()=>{refreshed++}}}
  const onPurge = makeOnPurge(deps)
  const ret = await onPurge(7, ft)
  assert.deepEqual(calls[0], ['rollbackTurn', {expectedTurn:7, failureTarget:ft}, 's1'])
  assert.deepEqual(waited, {id:'r1'})
  assert.equal(panels, 3)
  assert.equal(rebased, 1, '正常清理（等待同连接同步）后必须定向 rebase 重算下一目标')
  assert.equal(refreshed, 1)
  assert.equal(ret.view.rolledBack.cleanedFailureTarget.turn, 7, '成功路径必须回传已确认的目标')
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
    // built 实际消费者：core-host-transform:138 applyClientRollbackTransform → rollback-sync-author:58
    // 已把作者动作变换应用到 built ⇒ 作者 wait 在位（1）；purge 走“复用作者 wait + 改条件 + wait 后 rebase/refresh”。
    // 因此 clear 专用 wait / 软视图包裹 / clear-only guard 都不应出现（作者 NEXT 自带 guard，不重复）。
    assert.equal(built.split('waitForTavernRollbackSync(result?.view?.rolledBack?.sync)').length - 1, 1, 'built 沿用作者 wait（恰 1）')
    assert.equal(built.split('await props.sessions.waitForTavernRollbackSync(result && result.view && result.view.rolledBack && result.view.rolledBack.sync);').length - 1, 0, 'built 不得追加 clear 专用 wait（不 double wait）')
    assert.equal(built.split('if (!clearIncomplete) historyProjection.rolledBack(props.sessionId, result && result.view);').length - 1, 0, '作者变换已替换软视图行：本布局不再包一层')
    assert.equal(built.split('if (clearIncomplete && typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行清理");').length - 1, 0, 'built 不重复插 clear-only guard')
    assert.equal(built.split('回退已落盘，但宿主缺少同连接同步消费者；请重开页面').length - 1, 1, '作者 NEXT 自带同步消费者 guard（不重复）')
    // 护栏：wait 之后必须定向 rebase+refresh；清理场景缺回执必须 throw；正常等待不得 typeof 跳过
    assert.equal(built.split('alreadyClean === true)) await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync); if (clearIncomplete && result && result.view && result.view.rolledBack) { liveTavernView.rebase(props.sessionId); tavernCoordination.refresh(props.sessionId); }').length - 1, 1, 'wait 后必须定向 rebase+refresh（下一目标立刻重算）')
    assert.equal(built.split("if (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.cleanedFailureTarget)) throw new Error('清理未确认目标失败轮，不更新本地状态');").length - 1, 1, '清理场景缺回执必须 throw')
    assert.ok(!built.includes('typeof props.sessions?.waitForTavernRollbackSync === "function") await'), 'built 禁止 if(typeof) 跳过等待')
    assert.equal(built.split('var targetCompare = function (ft, cft) {').length - 1, 2, 'targetCompare 面板/菜单各一次')
    assert.equal(built.split('targetCompare(').length - 1, 3, 'built 布局：面板 2 处 + 菜单 1 处')
    // split 布局：作者 wait 在位 ⇒ 只改条件 + 定向重投影，不追加 clear 专用 wait / clear-only guard（不 double wait、不双 guard）
    const splitFeature = writes.get('tavern-plugin/src/client/features/play-controls.js')
    assert.ok(splitFeature, 'split 布局必须产出 features/play-controls.js')
    assert.equal(splitFeature.split('waitForTavernRollbackSync(result?.view?.rolledBack?.sync);').length - 1, 1, 'split 布局沿用作者 wait')
    assert.equal(splitFeature.split('await props.sessions.waitForTavernRollbackSync(result && result.view && result.view.rolledBack && result.view.rolledBack.sync);').length - 1, 0, 'split 布局不得追加 clear 专用 wait')
    assert.equal(splitFeature.split('if (clearIncomplete && typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行清理");').length - 1, 0, 'split 布局作者 guard 已在位：不得重复插 clear-only guard')
    assert.equal(splitFeature.split('targetCompare(').length - 1, 3, 'split 布局调用同为 3 处')
    assert.ok(splitFeature.includes('if (!(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) await props.sessions.waitForTavernRollbackSync'))
    assert.ok(splitFeature.includes('if (clearIncomplete && result && result.view && result.view.rolledBack) { liveTavernView.rebase(props.sessionId); tavernCoordination.refresh(props.sessionId); }'), 'split 布局：wait 后 clearIncomplete 才定向 rebase+refresh')
    assert.equal(splitFeature.split('回退同步尚未接线或尚未就绪，未执行回退').length - 1, 1, 'split 布局作者 guard 在 RPC 前恰 1')
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
    // 真协调服务可注入（run.tavernCoordination，如 18）；缺省只给作者真接口确有的 invalidate。
    // **不提供 refresh**：作者 EventModule 只导出 getSnapshot/setView/subscribe/invalidate，
    // 给假 refresh 会遮蔽线上 `tavernCoordination.refresh is not a function`（2026-10-10 现场）。
    tavernCoordination: run.tavernCoordination || {invalidate: () => { run.refreshed++ }},
    historyProjection: {rolledBack: () => {}},
    tavernErrorHub: {report: (label, error) => { if (run.reported) run.reported.push([label, error]); else if (error) throw error }},
    tavernProviderRefusalNotice: () => '',
    setCandidatePanel: () => {}, setRegenPanel: () => {}, setCandidateGuidePanel: () => {},
    window: {...DOM, localStorage: {getItem: () => null, setItem: () => {}}},
  }
  function render(state, registeredProps) {
    cursor = 0
    // 订阅者通知：state 已换，但 effect 是否重建只由 deps 决定。
    for (const listener of run.listeners) listener(state)
    // 可选 registeredProps：把**真注册语句产出的 element props** 原样喂组件（不断开注册→props 链）；缺省保持旧行为。
    const props = registeredProps || {sessionId:'s1', sessions:run.sessions, useSession:subscribe => subscribe({running:false}), useChat:selector => selector({}), useInput:selector => selector({draft:''})}
    const element = sandbox(...sandboxKeys.map(key => sandboxEnv[key]))(props)
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
  const rpc = async ()=>{ rpcCalls++; return {view:{rolledBack:{alreadyClean:true,cleanedFailureTarget:{turn:7,operationId:'op1',branchId:'b1',revision:3}}}} }
  const sessions = {waitForTavernRollbackSync: async ()=>{ waited++ }}
  const deps = {rpc, sessions, state:{view:{failureTarget:ft}}, props:{sessionId:'s1', sessions}, setCandidatePanel:()=>{}, setRegenPanel:()=>{}, setCandidateGuidePanel:()=>{}, liveTavernView:{rebase:()=>{rebased++}}, tavernCoordination:{invalidate:()=>{rebased++}}}
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
    rpc: async () => ({view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget:{turn:7, operationId:'opA', branchId:'b1', revision:70}}}})}
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
      return {view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget:{turn:ft.turn, operationId:ft.operationId, branchId:ft.branchId, revision:ft.revision}}}} }}
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
// native-only 43（terminal guard error、无 op/无基准）→ 物理清 → 下一目标 42（body）：
// 真产物 harness（同 component refs/effect）+ 真 turn-error-controls 按钮，按钮必须先 43 再 42。
test('干净清理11 native-only 43 清理链：收据核 endSeq/eventCount、sync 后 rebase+refresh、按钮 43→42', async ()=>{
  const play = applyErrorPurgePlayControlsTransform(readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8'))
  const turnControls = applyErrorPurgeTurnControlsTransform(readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8'))
  const dom43 = createFakeDom(43)
  const calls = []
  const waited = []
  const run = {currentState:null, listeners:[], sessions:{waitForTavernRollbackSync: async sync => { waited.push(sync) }}, created:0, invalidated:0, rebased:0, refreshed:0, reported:[],
    rpc: async (method, args, sid) => { calls.push([method, args, sid]); const ft = args.failureTarget
      return {view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget: ft.kind === 'native-only'
        ? {kind:'native-only', chatId:ft.chatId, sessionId:ft.sessionId, turn:ft.turn, branchId:ft.branchId, revision:ft.revision, endSeq:ft.endSeq, eventCount:ft.eventCount}
        : {turn:ft.turn, operationId:ft.operationId, branchId:ft.branchId, revision:ft.revision}}}} }}
  const harness = createSupersededHarness(play, dom43, run)
  const view = target => ({view:{failureTarget:target, failureCleanupReason:'', suppressedDshErrorTurns:['43'], hiddenDshErrorTurns:[], staleDshErrorTurns:[], filteredFailureStreak:0, canRegenerate:false, canReplayFailedTurn:false, replayFailedTurn:null}})
  const native43 = {chatId:'c1', sessionId:'s1', kind:'native-only', turn:43, branchId:'b1', revision:91, endSeq:494, eventCount:495}
  run.currentState = view(native43)
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 1)
  const options43 = harness.captures[0]
  const controls43 = realTurnErrorControls(turnControls)(dom43.root, options43)
  controls43.apply()
  assert.equal(dom43.toggleOf().disabled, false, 'native-only 43 必须可清理')
  assert.equal(dom43.toggleOf().textContent, '干净清理错误')
  await options43.onPurge(43, native43)
  assert.deepEqual(calls[0], ['rollbackTurn', {expectedTurn:43, failureTarget:native43}, 's1'])
  assert.deepEqual(waited, [{id:'r1'}], '必须等待同连接同步回执')
  assert.equal(run.rebased, 1, '正常清理后必须定向 rebase，令下一目标立刻重算')
  assert.equal(run.refreshed, 1)
  // 43 清完：同一 harness/refs 换新视图 → 目标变 42（body），按钮随目标切到 42，旧 43 行不再可清理
  const body42 = failureItem(42, 'op42', {revision:91})
  run.currentState = view(body42)
  harness.render(run.currentState)
  assert.equal(harness.captures.at(-1).failureTarget, body42, 'ref 活取新视图：43 之后必须换成 42')
  const dom42 = createFakeDom(42)
  const controls42 = realTurnErrorControls(turnControls)(dom42.root, harness.captures.at(-1))
  controls42.apply()
  assert.equal(dom42.toggleOf().disabled, false, '43 清完后 42 必须立刻可清理')
  const stale43 = realTurnErrorControls(turnControls)(dom43.root, harness.captures.at(-1))
  stale43.apply()
  assert.equal(dom43.toggleOf().disabled, true, '43 已清理：旧错误行不得再可清理')
  await harness.captures.at(-1).onPurge(42, body42)
  assert.deepEqual(calls[1], ['rollbackTurn', {expectedTurn:42, failureTarget:body42}, 's1'])
  assert.equal(run.rebased, 2)
  assert.equal(run.refreshed, 2)
  controls43.dispose(); controls42.dispose(); stale43.dispose()
})
// 收据形状：body 认 operationId 非空串、native 认 endSeq/eventCount 安全整数；kind+turn+branch+revision exact；
// 任何不合法（含 undefined 互相恒等）都必须拒更新，且零等待/零 rebase/零 refresh。
test('干净清理12 收据形状不合格一律拒更新（native 缺 endSeq/eventCount、kind 反转、漂移、undefined 恒等）', async ()=>{
  const play = applyErrorPurgePlayControlsTransform(readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8'))
  const native43 = {chatId:'c1', sessionId:'s1', kind:'native-only', turn:43, branchId:'b1', revision:91, endSeq:494, eventCount:495}
  const view = target => ({view:{failureTarget:target, failureCleanupReason:'', suppressedDshErrorTurns:['43'], hiddenDshErrorTurns:[], staleDshErrorTurns:[], filteredFailureStreak:0, canRegenerate:false, canReplayFailedTurn:false, replayFailedTurn:null}})
  const runCase = async (label, receipt, target) => {
    const dom = createFakeDom(Number(target.turn))
    const waited = []
    const run = {currentState:null, listeners:[], sessions:{waitForTavernRollbackSync: async sync => { waited.push(sync) }}, created:0, invalidated:0, rebased:0, refreshed:0,
      rpc: async () => ({view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget:receipt}}})}
    const harness = createSupersededHarness(play, dom, run)
    run.currentState = view(target)
    harness.render(run.currentState)
    await assert.rejects(harness.captures[0].onPurge(Number(target.turn), target), /清理回执目标与请求不一致|清理未确认目标失败轮/, label)
    assert.equal(waited.length, 0, label + '：拒更新时不得等待同连接同步')
    assert.equal(run.rebased + run.refreshed, 0, label + '：拒更新时不得 rebase/refresh')
  }
  const receipt = extra => ({kind:'native-only', chatId:'c1', sessionId:'s1', turn:43, branchId:'b1', revision:91, endSeq:494, eventCount:495, ...extra})
  await runCase('缺 endSeq', receipt({endSeq:undefined}), native43)
  await runCase('缺 eventCount', receipt({eventCount:undefined}), native43)
  await runCase('endSeq 漂移', receipt({endSeq:493}), native43)
  await runCase('eventCount 漂移', receipt({eventCount:494}), native43)
  await runCase('kind 反转（body 形状且 operationId 缺失）', {turn:43, branchId:'b1', revision:91}, native43)
  await runCase('revision 漂移', receipt({revision:92}), native43)
  await runCase('turn 漂移', receipt({turn:42}), native43)
  await runCase('branchId 漂移', receipt({branchId:'b2'}), native43)
  await runCase('chatId 漂移', receipt({chatId:'c9'}), native43)
  // body 侧：收据只回 turn/branch/revision（operationId undefined）不得因 String(undefined) 恒等而放行
  const body42 = failureItem(42, 'op42', {revision:91})
  await runCase('body 收据 operationId 缺失', {turn:42, branchId:'b1', revision:91}, body42)
  // kind 未知值（既非 native-only 也非 undefined/body）一律拒，不得当成 body 放行
  await runCase('未知 kind 值（native）', {kind:'native', chatId:'c1', sessionId:'s1', turn:43, branchId:'b1', revision:91, endSeq:494, eventCount:495}, native43)
  await runCase('未知 kind 值（rollback）', receipt({kind:'rollback'}), native43)
  await runCase('body 目标收到未知 kind 收据', {kind:'foo', turn:42, operationId:'op42', branchId:'b1', revision:91}, body42)
})
// 目标身份 key：kind/endSeq/eventCount 任一变化或 kind 反转都必须重建控件（否则按钮停在旧目标）。
test('干净清理13 目标身份键含 kind/endSeq/eventCount：native 身份变化必重建、同身份不重建', ()=>{
  const transformed = applyErrorPurgePlayControlsTransform(readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8'))
  assert.ok(transformed.includes('field(target.kind)') && transformed.includes('field(target.endSeq)') && transformed.includes('field(target.eventCount)'), '身份键必须含 native 字段')
  const dom = createFakeDom(43)
  const run = {currentState:null, listeners:[], sessions:{waitForTavernRollbackSync: async () => {}}, created:0, invalidated:0, rebased:0, refreshed:0, rpc: async () => ({})}
  const harness = createSupersededHarness(transformed, dom, run)
  const view = target => ({view:{failureTarget:target, failureCleanupReason:'', suppressedDshErrorTurns:['43'], hiddenDshErrorTurns:[], staleDshErrorTurns:[], filteredFailureStreak:0, canRegenerate:false, canReplayFailedTurn:false, replayFailedTurn:null}})
  const native43 = {chatId:'c1', sessionId:'s1', kind:'native-only', turn:43, branchId:'b1', revision:91, endSeq:494, eventCount:495}
  run.currentState = view(native43)
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 1)
  const sameIdentity = {...native43}
  run.currentState = view(sameIdentity)
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 1, '相同 native 身份不得重建控制器')
  assert.equal(harness.captures[0].failureTarget, sameIdentity, 'getter 必须活取 ref 当前视图')
  run.currentState = view({...native43, endSeq:495})
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 2, 'endSeq 变化必须重建')
  run.currentState = view({...native43, endSeq:495, eventCount:496})
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 3, 'eventCount 变化必须重建')
  run.currentState = view(failureItem(42, 'op42', {revision:91}))
  harness.render(run.currentState)
  assert.equal(harness.captures.length, 4, 'kind 反转（native→body）必须重建，按钮不得停在 43')
})
// 增强 DOM：querySelectorAll 必须按选择器区分（不对任何选择器都返回同一行）；原生错误行可被物理移除（模拟 sync 后投影变化）。
function createFallbackDom(nativeTurns) {
  const all = []
  const appended = []
  // data-chat-turn 写入计数：同值 setAttribute 也生 MutationRecord（作者 observeTurnErrorProjection watch 该属性 ⇒ 会每帧 rAF→apply 回环）。
  const attrWrites = {chatTurn: 0}
  function makeNode(tag, attributes = {}) {
    const node = {tagName:String(tag).toUpperCase(), style:{display:''}, className:'', hidden:false, textContent:'', listeners:new Map(),
      attributes:{...attributes}, removed:false, appended:[], children:[]}
    node.append = (...children) => { node.children.push(...children) }
    node.remove = () => { node.removed = true; const index = all.indexOf(node); if (index >= 0) all.splice(index, 1) }
    node.insertAdjacentElement = (position, element) => { node.appended.push(element); appended.push(element); return element }
    node.getAttribute = name => Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null
    node.setAttribute = (name, value) => { if (name === 'data-chat-turn') attrWrites.chatTurn += 1; node.attributes[name] = String(value) }
    node.closest = () => null
    node.matches = () => false
    node.querySelector = () => null
    node.querySelectorAll = () => []
    node.addEventListener = (type, fn) => { if (!node.listeners.has(type)) node.listeners.set(type, []); node.listeners.get(type).push(fn) }
    node.click = () => { const out = typeof node.onclick === 'function' ? node.onclick({type:'click'}) : undefined; for (const fn of node.listeners.get('click') || []) fn({type:'click'}); return out }
    node.classList = {add: () => {}, remove: () => {}, contains: () => false}
    return node
  }
  const doc = {createElement: tag => { const node = makeNode(tag); all.push(node); return node }}
  const natives = (nativeTurns || []).map(turn => {
    const row = makeNode('div', {'data-chat-flow-kind':'turn-error', 'data-chat-turn':String(turn)})
    all.push(row)
    return row
  })
  const root = {querySelectorAll: selector => selector === '[data-chat-flow-kind="turn-error"]' ? natives.filter(row => !row.removed) : [],
    contains: node => all.includes(node), children: [], append: (...children) => { root.children.push(...children) }, ownerDocument: doc}
  // harness 把组件 ref 指向 dom.row，作者 effect 由它 closest('[data-conversation-scroll]') 拿容器。
  const row = makeNode('div')
  row.closest = selector => selector === '[data-conversation-scroll]' ? root : null
  return {doc, row, root, natives, appended, attrWrites,
    panelOf: row => row.appended.at(-1),
    toggleOf: row => row.appended.at(-1).children[2],
    fallbackRows: () => [...new Set(all.filter(node => node.getAttribute && node.getAttribute('data-tavern-failure-cleanup') !== null && !node.removed))],
    removeNative: turn => { const row = natives.find(item => item.getAttribute('data-chat-turn') === String(turn)); if (row) row.remove() }}
}
// 无原生错误行的失败轮（aborted 42）：43 清后（原生 43 行随 sync 物理消失）插件自有提示行必须出现并走真 onPurge 链
// （RPC 带 42 + ref 当前目标、收据核、同连接等待、rebase+refresh）；目标变 null/无效即移除；同轮已有原生行不重复；dispose 清净。
test('干净清理14 无原生错误行的失败42提示：43清后42可点，成功41及dispose清净', async ()=>{
  const play = applyErrorPurgePlayControlsTransform(readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8'))
  const turnControls = applyErrorPurgeTurnControlsTransform(readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8'))
  assert.ok(turnControls.includes('data-tavern-failure-cleanup'), '产物必须含自有提示行属性')
  assert.ok(turnControls.includes('请清理本轮后继续'), '产物必须含提示文案')
  const dom = createFallbackDom([43])
  const calls = []
  const waited = []
  const run = {currentState:null, listeners:[], sessions:{waitForTavernRollbackSync: async sync => { waited.push(sync) }}, created:0, invalidated:0, rebased:0, refreshed:0, reported:[],
    rpc: async (method, args, sid) => { calls.push([method, args, sid]); const ft = args.failureTarget
      return {view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget: ft.kind === 'native-only'
        ? {kind:'native-only', chatId:ft.chatId, sessionId:ft.sessionId, turn:ft.turn, branchId:ft.branchId, revision:ft.revision, endSeq:ft.endSeq, eventCount:ft.eventCount}
        : {turn:ft.turn, operationId:ft.operationId, branchId:ft.branchId, revision:ft.revision}}}}}}
  const harness = createSupersededHarness(play, dom, run)
  const view = target => ({view:{failureTarget:target, failureCleanupReason:'', suppressedDshErrorTurns:[], hiddenDshErrorTurns:[], staleDshErrorTurns:[], filteredFailureStreak:0, canRegenerate:false, canReplayFailedTurn:false, replayFailedTurn:null}})
  const native43 = {chatId:'c1', sessionId:'s1', kind:'native-only', turn:43, branchId:'b1', revision:91, endSeq:494, eventCount:495}
  const body42 = failureItem(42, 'op42', {revision:91})
  // ① 43 有真实原生错误行：原控件**真点击**走完 RPC（收据按 native 形状），且不得重复造提示行
  run.currentState = view(native43)
  harness.render(run.currentState)
  const controls = realTurnErrorControls(turnControls)(dom.root, harness.captures.at(-1))
  controls.apply()
  assert.equal(dom.toggleOf(dom.natives[0]).textContent, '干净清理错误', '43 原生行必须用原控件')
  assert.equal(dom.fallbackRows().length, 0, '同轮已有可见原生行：不得重复造提示')
  await dom.toggleOf(dom.natives[0]).click()
  assert.deepEqual(calls[0], ['rollbackTurn', {expectedTurn:43, failureTarget:native43}, 's1'], '43 点击必须真发 RPC')
  assert.deepEqual(waited, [{id:'r1'}], '必须等待同连接同步回执')
  assert.equal(run.rebased, 1, '清理成功后必须定向 rebase')
  assert.equal(run.refreshed, 1)
  assert.equal(dom.fallbackRows().length, 0, '43 走原控件：不得另造提示')
  // ② 物理清掉 43（原生行随 sync 消失）→ 目标 42：**同一控制器**按活 getter 换目标 ⇒ 造 42 提示并真点击
  dom.removeNative(43)
  assert.equal(dom.root.querySelectorAll('[data-chat-flow-kind="turn-error"]').length, 0)
  run.currentState = view(body42)
  harness.render(run.currentState)
  assert.equal(harness.captures.at(-1).failureTarget, body42, 'options 必须活取 ref 当前目标')
  controls.apply()
  const prompts = dom.fallbackRows()
  assert.equal(prompts.length, 1, '42 无原生错误行：必须出现插件自有提示行')
  assert.equal(prompts[0].getAttribute('data-chat-turn'), '42')
  assert.equal(prompts[0].getAttribute('data-chat-flow-kind'), null, '不得冒充 data-chat-flow-kind=turn-error')
  assert.equal(prompts[0].textContent, '第42轮未完成，请清理本轮后继续。')
  assert.equal(dom.toggleOf(prompts[0]).disabled, false, '提示行的清理按钮必须可点')
  assert.equal(dom.toggleOf(prompts[0]).textContent, '干净清理错误')
  // 同 target 重复 apply 不得重复写 data-chat-turn：同值 setAttribute 也生 MutationRecord，而作者的
  // observeTurnErrorProjection 正 watch 该属性 ⇒ 否则会变成每帧 rAF→apply→写属性的回环（idle 也烧帧）。
  controls.apply()
  controls.apply()
  assert.equal(dom.attrWrites.chatTurn, 1, '同 target 重复 apply 不得再写 data-chat-turn')
  assert.equal(dom.fallbackRows().length, 1, '提示行必须仍只有一条')
  assert.equal(dom.fallbackRows()[0], prompts[0], '提示行必须是同一节点（不得重建）')
  await dom.toggleOf(prompts[0]).click()
  assert.deepEqual(calls[1], ['rollbackTurn', {expectedTurn:42, failureTarget:body42}, 's1'], '42 提示行必须走同一 RPC 控件')
  assert.deepEqual(waited, [{id:'r1'}, {id:'r1'}], '第二次清理也必须等同步回执')
  assert.equal(run.rebased, 2)
  assert.equal(run.refreshed, 2)
  assert.equal(dom.attrWrites.chatTurn, 1, '点击内部 apply 也不得再写 data-chat-turn 属性')
  // ③ 目标变无效（turn 0）：同一控制器必须移除提示行与面板
  run.currentState = view({...body42, turn:0})
  harness.render(run.currentState)
  controls.apply()
  assert.equal(dom.fallbackRows().length, 0, '无效目标不得造提示行')
  assert.equal(prompts[0].removed, true, '旧提示行 DOM 必须真删')
  assert.equal(dom.panelOf(prompts[0]).removed, true, '旧提示行面板必须一并移除')
  // ④ 回到 42 再造提示，随后目标 null（成功清理落到 41、无失败目标）：必须移除
  run.currentState = view(body42)
  harness.render(run.currentState)
  controls.apply()
  const again = dom.fallbackRows()
  assert.equal(again.length, 1, '回到 42 必须再造提示行（同控制器复用）')
  run.currentState = view(null)
  harness.render(run.currentState)
  controls.apply()
  assert.equal(dom.fallbackRows().length, 0, '目标 null（成功落到 41）必须移除提示行')
  assert.equal(again[0].removed, true)
  assert.equal(dom.panelOf(again[0]).removed, true)
  // ⑤ 同轮已有原生行（42 行回到页面）：不得重复造提示。前提必须真是 ft42——活 getter 若读到 null，这一支根本不成立。
  run.currentState = view(body42)
  harness.render(run.currentState)
  assert.equal(harness.captures.at(-1).failureTarget, body42, '⑤ 前提：活 getter 必须读到 42')
  const domNative42 = createFallbackDom([42])
  const native42Controls = realTurnErrorControls(turnControls)(domNative42.root, harness.captures.at(-1))
  native42Controls.apply()
  assert.equal(domNative42.fallbackRows().length, 0, '同轮原生行可见：不得造重复提示')
  assert.equal(domNative42.toggleOf(domNative42.natives[0]).disabled, false, '42 原生行本身可清理')
  // ⑥ 原生行被宿主隐藏（hidden）但仍是最新目标 ⇒ 同轮没有可见原生行，仍须给出可点提示
  const domHidden43 = createFallbackDom([43])
  domHidden43.natives[0].hidden = true
  run.currentState = view(native43)
  harness.render(run.currentState)
  const hiddenControls = realTurnErrorControls(turnControls)(domHidden43.root, harness.captures.at(-1))
  hiddenControls.apply()
  assert.equal(domHidden43.fallbackRows().length, 1, '原生行被隐藏时仍须给出提示行')
  assert.equal(domHidden43.fallbackRows()[0].getAttribute('data-chat-turn'), '43')
  // ⑦ dispose 清净：面板与 DOM 行都清，owned 不残留
  run.currentState = view(body42)
  harness.render(run.currentState)
  const domDispose = createFallbackDom([])
  const controlsDispose = realTurnErrorControls(turnControls)(domDispose.root, harness.captures.at(-1))
  controlsDispose.apply()
  const disposedPrompt = domDispose.fallbackRows()[0]
  assert.ok(disposedPrompt, 'dispose 前提示行应在位')
  controlsDispose.dispose()
  assert.equal(domDispose.fallbackRows().length, 0, 'dispose 必须移除提示行')
  assert.equal(disposedPrompt.removed, true)
  assert.equal(domDispose.panelOf(disposedPrompt).removed, true, 'dispose 必须一并移除面板')
  controls.dispose(); native42Controls.dispose(); hiddenControls.dispose()
})
// 从真产物裁出 dock 注册**语句**（不是回调片段）：整条 ctx.effect(() => slots.inject(name, () => slots.register(meta, render)), label)
// 执行它才能同时核「注册元数据」与「真回调产出的元素 props」；锚点丢失/不唯一即抛，不手抄替代实现。
function extractDockRegisterStatement(source, label) {
  const hits = source.split(label).length - 1
  if (hits === 0) throw new Error('裁注册语句失败：找不到注册说明 ' + label)
  if (hits !== 1) throw new Error('裁注册语句失败：注册说明不唯一（' + hits + ' 次）' + label)
  const at = source.indexOf(label)
  const start = source.lastIndexOf('ctx.effect(', at)
  if (start < 0) throw new Error('裁注册语句失败：注册说明之前没有 ctx.effect(')
  const stop = source.indexOf(');', at)
  if (stop < 0) throw new Error('裁注册语句失败：注册语句未闭合')
  const statement = source.slice(start, stop + 2)
  // 混合 OLD+NEW / 重复注册：一次注册说明里必须恰好一次 register、恰好一次 SupersededTurnErrors 引用。
  const registers = statement.split('slots.register(').length - 1
  if (registers !== 1) throw new Error('裁注册语句失败：注册调用不为 1（' + registers + '）')
  const superseded = statement.split('SupersededTurnErrors').length - 1
  if (superseded !== 1) throw new Error('裁注册语句失败：SupersededTurnErrors 引用不为 1（' + superseded + '）')
  return statement
}
// 真注册语句 + 只观测的 React/slots/ctx 桩：执行语句，从 wrapper 已记录的结果返回（不在 new Function 内引用外部变量）。
// 本用例只验证「注册注入」；不做卸载验收，故不收集/断言 disposer（slots.inject 桩不是真卸载通道）。
function runDockRegister(source, label, { sessions, components }) {
  const statement = extractDockRegisterStatement(source, label)
  const registered = []
  const ctx = { sessions, effect: fn => { fn(); return () => {} } }
  const slots = { inject: (name, fn) => { fn(); return { name } }, register: (meta, render) => { registered.push({ meta, render }); return { meta } } }
  // 只记录 element props；Fragment 用独立标记，便于按 type 找子元素。
  const React = { Fragment: Symbol('React.Fragment'), createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const names = Object.keys(components)
  new Function('ctx', 'slots', 'React', ...names, statement)(ctx, slots, React, ...names.map(name => components[name]))
  return { registered, statement, ctx }
}
// 精确取出产物里某一处调用的**原文**（括号配平；要求唯一命中）——用于只替换这一处，不用全局删除正则。
function callText(source, prefix) {
  const hits = source.split(prefix).length - 1
  if (hits === 0) throw new Error('取注册调用失败：找不到 ' + prefix)
  if (hits !== 1) throw new Error('取注册调用失败：不唯一（' + hits + ' 次）' + prefix)
  const at = source.indexOf(prefix)
  let depth = 0
  for (let i = source.indexOf('(', at); i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')' && --depth === 0) return source.slice(at, i + 1)
  }
  throw new Error('取注册调用失败：括号未闭合 ' + prefix)
}
// 递归收集 element 树里指定 type 的元素（createElement 的 rest children 形状）。
function elementsOfType(element, type, out = []) {
  if (!element || typeof element !== 'object') return out
  if (element.type === type) out.push(element)
  if (Array.isArray(element.children)) for (const child of element.children) elementsOfType(child, type, out)
  const nested = element.props && element.props.children
  if (Array.isArray(nested)) for (const child of nested) elementsOfType(child, type, out)
  return out
}
// 干净清理17（根因回归）：作者 dock 注册把 sessions 丢了 ——
//   play-controls.js:1382 React.createElement(SupersededTurnErrors, Object.assign({}, props, { key: props.sessionId }))
// 旁侧 CandidateQuestion/CandidateDockActions 显式带 sessions: ctx.sessions（:1370/:1374-1375/:1384）。
// 后果：SupersededTurnErrors→turn-error-controls 的 props 无 sessions ⇒ 清理守卫在 RPC 前抛（server/clientReady 都 true 也发不出清理）。
// 本用例执行**真实注册语句**（React/slots/ctx 桩只观测 element props）并复用真产物控件回调，覆盖：源码与 built 的注册注入、
// 注入后能发 rpc/wait/rebase、缺同步消费者时零 rpc 不删。每个场景用全新输入，不共享可变现场。
test('干净清理17 真实注册为失败提示控件注入同步服务', async ()=>{
  const LABEL = '"dsh-tavern: candidate question panel"'
  let waited = null
  // 同步服务桩：记录收到的 sync 回执；身份即 ctx.sessions（注册注入与 run.sessions 必须是同一对象）。
  const SESSIONS = { waitForTavernRollbackSync: async sync => { waited = sync }, subagentAddress: () => null }
  const types = { SupersededTurnErrors: Symbol('SupersededTurnErrors'), TurnHistoryProjection: Symbol('TurnHistoryProjection'), CandidateQuestion: Symbol('CandidateQuestion') }
  // 原始 slot props 刻意不含 sessions：复现作者 Object.assign({}, props, {key}) 丢字段的现场。
  const slotProps = () => ({ sessionId: 's1', useSession: subscribe => subscribe({running:false}), useChat: selector => selector({}), useInput: selector => selector({draft:''}) })
  // 产物：split＝真功能文件直接产物；built＝同链施缝的内联产物（现场部署形态，含作者 guard 与 clear-only guard）。
  const direct = applyErrorPurgePlayControlsTransform(readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8'))
  const {mkdtempSync, mkdirSync, writeFileSync: writeFs, readFileSync: readFs, rmSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const path = (await import('node:path')).default
  const {clientCoreWrites} = await import('../deploy/client-seams.mjs')
  const fixRoot = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/', import.meta.url)
  const base = mkdtempSync(path.join(tmpdir(), 'tavern-error-purge-reg17-'))
  try {
    for (const rel of ['lib/client.js', 'src/client/main.js', 'src/client/turn-error-controls.js', 'src/client/features/play-controls.js', 'src/client/features/turn-history.js', 'src/client/ui/error-center.js', 'src/client/helper-resources.js', 'src/client/runtime/helper-bootstrap.js', 'src/client/runtime/helper-script-runtime.js', 'src/client/modules/tavern-coordination.js']) {
      const dst = path.join(base, 'tavern-plugin', rel)
      mkdirSync(path.dirname(dst), {recursive:true})
      writeFs(dst, readFs(new URL(rel, fixRoot), 'utf8'))
    }
    const built = clientCoreWrites(base).get('tavern-plugin/lib/client.js')

    // 真注册语句 → 只观测的 element props（① 与 ②/③ 共用同一份，② 用它喂组件，不断开注册→props 链）。
    const registeredPropsOf = product => {
      const dock = runDockRegister(product, LABEL, { sessions: SESSIONS, components: types })
      assert.equal(dock.registered.length, 1, '对话 dock 必须注册一次 candidate question panel')
      assert.equal(dock.registered[0].meta.id, 'dsh-tavern-question', '注册元数据不变')
      assert.equal(dock.registered[0].meta.name, 'conversation.input.dock', '注册槽位不变')
      const tree = dock.registered[0].render(slotProps())
      const superseded = elementsOfType(tree, types.SupersededTurnErrors)
      assert.equal(superseded.length, 1, '注册回调必须创建 SupersededTurnErrors 元素')
      assert.equal(elementsOfType(tree, types.TurnHistoryProjection).length, 1, '同回调的其它元素身份不变')
      assert.equal(elementsOfType(tree, types.CandidateQuestion)[0].props.sessions, SESSIONS, '旁证：CandidateQuestion 本就显式传 sessions')
      return { dock, tree, superseded, props: superseded[0].props }
    }

    // ① 注册注入（fresh，split 与 built 双路径都核）：SupersededTurnErrors 元素必须拿到 ctx.sessions
    const splitCase = registeredPropsOf(direct)
    const builtCase = registeredPropsOf(built)
    for (const [layout, item] of [['split', splitCase], ['built', builtCase]]) {
      assert.equal(item.props.sessions, SESSIONS, layout + '：根因——SupersededTurnErrors 元素必须注入 ctx.sessions（原实现丢字段）')
    }
    // ④ 变换接线与锚点合同（**产品级**，不用 helper 自测）：幂等；旧 marker 但注册缺 sessions 必须重接；锚点被删/重复 NEW/混合 OLD+NEW 必须 fail-closed
    assert.equal(applyErrorPurgePlayControlsTransform(direct), direct, '幂等：二次施缝必须字节不变')
    const OLD_REGISTRATION = 'React.createElement(SupersededTurnErrors, Object.assign({}, props, { key: props.sessionId }))' // 作者原样（fixture play-controls.js:1382）
    const NEW_REGISTRATION = callText(direct, 'React.createElement(SupersededTurnErrors') // 从产物精确取该处调用原文
    assert.notEqual(NEW_REGISTRATION, OLD_REGISTRATION, '前提：产物该处注册必须已改成带 sessions 的新形态')
    assert.ok(built.includes(NEW_REGISTRATION), '前提：built 产物同处注册文本与 split 一致')
    const legacy = direct.replace(NEW_REGISTRATION, OLD_REGISTRATION) // 只替这一处，不动旁控件 sessions
    assert.notEqual(legacy, direct, '前提：旧形态替换必须命中（NEW 文本须与产物一致）')
    const rejoined = applyErrorPurgePlayControlsTransform(legacy)
    assert.equal(registeredPropsOf(rejoined).props.sessions, SESSIONS, '旧 marker 但注册缺 sessions：必须重接（不得只凭标记早 return）')
    assert.equal(applyErrorPurgePlayControlsTransform(rejoined), rejoined, '重接后仍幂等')
    // fail-closed 一律由**产品变换**报错（marker 原样保留，不做撤标记前置）
    const refusal = fn => { try { fn(); return null } catch (error) { return String((error && error.message) || error || '') } }
    for (const [label, mutate] of [
      ['该处注册调用被删（锚点 0）', text => text.replace(NEW_REGISTRATION, '')],
      ['重复 NEW 注册调用', text => text + '\n' + NEW_REGISTRATION],
      ['混合 OLD+NEW 注册调用', text => text + '\n' + OLD_REGISTRATION],
    ]) {
      const message = refusal(() => applyErrorPurgePlayControlsTransform(mutate(direct)))
      assert.ok(message !== null && message !== '', label + '：产品变换必须 fail-closed 抛错（保留 marker 原样）')
    }

    // ② 42 无原生错误行（真提示行）＋真注册 props 喂组件：真按钮 await click 即走完 rpc/等 sync/rebase+refresh
    const view = target => ({view:{failureTarget:target, failureCleanupReason:'', suppressedDshErrorTurns:[], hiddenDshErrorTurns:[], staleDshErrorTurns:[], filteredFailureStreak:0, canRegenerate:false, canReplayFailedTurn:true, replayFailedTurn:42}})
    const dom = createFallbackDom([])
    const calls = []
    const run = { currentState: null, listeners: [], sessions: SESSIONS, created: 0, invalidated: 0, rebased: 0, refreshed: 0, reported: [],
      rpc: async (method, args, sid) => { calls.push([method, args, sid])
        return {view:{rolledBack:{sync:{id:'r1'}, cleanedFailureTarget:{turn:args.failureTarget.turn, operationId:args.failureTarget.operationId, branchId:args.failureTarget.branchId, revision:args.failureTarget.revision}}}} } }
    const harness = createSupersededHarness(built, dom, run)
    const target = failureItem(42, 'op42')
    run.currentState = view(target)
    harness.render(run.currentState, builtCase.props) // 真注册产出的 props（含 ctx.sessions），不用手填
    const options = harness.captures.at(-1)
    assert.equal(options.failureTarget, target, '真产物控件必须拿到当前 42 目标')
    const controls = realTurnErrorControls(applyErrorPurgeTurnControlsTransform(readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8')))(dom.root, options)
    controls.apply()
    const prompts = dom.fallbackRows()
    assert.equal(prompts.length, 1, '42 无原生错误行：必须出现插件自有提示行')
    assert.equal(prompts[0].textContent, '第42轮未完成，请清理本轮后继续。')
    assert.equal(prompts[0].getAttribute('data-chat-flow-kind'), null, '不得冒充 data-chat-flow-kind=turn-error')
    assert.equal(dom.toggleOf(prompts[0]).disabled, false, '注入 sessions 后提示按钮必须可点')
    await dom.toggleOf(prompts[0]).click()
    assert.deepEqual(run.reported, [], 'onError 不得被触发（否则清理链已中断）')
    assert.deepEqual(calls[0], ['rollbackTurn', {expectedTurn:42, failureTarget:target}, 's1'], '注入的 props.sessions 必须让清理发出 RPC')
    assert.deepEqual(waited, {id:'r1'}, '必须等待同连接同步回执')
    assert.equal(run.rebased, 1, 'sync 等待后必须定向 rebase')
    assert.equal(run.refreshed, 1)
    controls.dispose()
    assert.equal(dom.fallbackRows().length, 0, 'dispose 后提示行必须清净')

    // ③ 负例（在**同一真注册 props** 上故意删/破坏 sessions，每次全新输入）：零 RPC、零局部更新，且暴露“同步未接线/未就绪”
    const negatives = [
      ['sessions 被删（原实现丢字段形态）', props => { const copy = {...props}; delete copy.sessions; return copy }],
      ['sessions 在但缺 waitForTavernRollbackSync（同步未接线）', props => ({...props, sessions: {}})],
    ]
    for (const [label, mutate] of negatives) {
      const domNoSync = createFallbackDom([])
      const nocalls = []
      const runNoSync = { currentState: null, listeners: [], sessions: SESSIONS, created: 0, invalidated: 0, rebased: 0, refreshed: 0, reported: [],
        rpc: async (...args) => { nocalls.push(args); throw new Error('缺同步时必须零 RPC') } }
      const harnessNoSync = createSupersededHarness(built, domNoSync, runNoSync)
      const targetNoSync = failureItem(42, 'op42')
      runNoSync.currentState = view(targetNoSync)
      harnessNoSync.render(runNoSync.currentState, mutate(builtCase.props))
      const controlsNoSync = realTurnErrorControls(applyErrorPurgeTurnControlsTransform(readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8')))(domNoSync.root, harnessNoSync.captures.at(-1))
      controlsNoSync.apply()
      const promptsNoSync = domNoSync.fallbackRows()
      assert.equal(promptsNoSync.length, 1, label + '：真提示行必须仍在（只在派发时受阻）')
      // 作者控件把异步失败交给 options.onError；若实现改为同步抛，本处接住 → 两种暴露路径都算，但必须恰好一次。
      let thrown = null
      try { await domNoSync.toggleOf(promptsNoSync[0]).click() } catch (error) { thrown = error }
      assert.equal(nocalls.length, 0, label + '：必须零 RPC（不删不改）')
      assert.equal(runNoSync.rebased, 0, label + '：零 RPC 就不得 rebase')
      assert.equal(runNoSync.refreshed, 0, label + '：零 RPC 就不得 refresh')
      assert.equal(runNoSync.reported.length + (thrown ? 1 : 0), 1, label + '：失败必须恰好暴露一次（onError 或同步抛）')
      if (runNoSync.reported.length === 1) assert.equal(runNoSync.reported[0][0], '保存错误提示状态失败', label + '：走作者 onError 时标签须与现场截图同名')
      const surfaced = runNoSync.reported.length === 1
        ? String(runNoSync.reported[0][1] && runNoSync.reported[0][1].message)
        : String(thrown && thrown.message)
      assert.match(surfaced, /尚未接线|未就绪/, label + '：必须暴露“同步未接线/未就绪”而不是静默')
      controlsNoSync.dispose()
    }
  } finally {
    rmSync(base, {recursive:true, force:true})
  }
})
// 干净清理18（真协调服务接缝，2026-10-10 线上 `tavernCoordination.refresh is not a function`）：
//   作者 EventModule 只导出 getSnapshot/setView/subscribe/invalidate（服务级 refresh 不存在），清理回执后必须走 invalidate；
//   真模块再触发该 sid 连接 handle.refresh 推下一状态帧。用真工厂文本 + 真 built 注册链 + 真控件 click，不挂任何 refresh 桩。
test('干净清理18 真协调服务：清理回执后定向失效并刷新下一状态', async ()=>{
  const LABEL = '"dsh-tavern: candidate question panel"'
  const coordinationText = readFileSync(new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/src/client/modules/tavern-coordination.js', import.meta.url), 'utf8')
  const createCoordination = new Function(coordinationText + '\nreturn createTavernCoordinationEventModule;')() // 真工厂（该文件无 export）
  const transports = new Map()
  const service = createCoordination({connect: (sid, handlers) => {
    const item = {id: sid, refresh: 0, close: 0, frames: []}
    transports.set(sid, item)
    return {refresh: () => { item.refresh += 1; const frame = {cleanable: false, turn: null, reason: ''}; item.frames.push(frame); handlers.message(frame) }, close: () => { item.close += 1 }, supersede: () => {}}
  }})
  assert.equal(typeof service.invalidate, 'function', '真模块必须暴露 invalidate')
  assert.equal(Object.hasOwn(service, 'refresh'), false, '真模块不得暴露服务级 refresh（线上 TypeError 来源）')
  service.subscribe('s1', () => {})
  service.subscribe('s2', () => {})
  service.setView('s1', {cleanable: true, turn: 42, reason: ''})
  service.setView('s2', {cleanable: true, turn: 9, reason: ''})
  const baseline = {s1: transports.get('s1').refresh, s2: transports.get('s2').refresh}
  const {mkdtempSync, mkdirSync, writeFileSync: writeFs, readFileSync: readFs, rmSync} = await import('node:fs')
  const {tmpdir} = await import('node:os')
  const path = (await import('node:path')).default
  const {clientCoreWrites} = await import('../deploy/client-seams.mjs')
  const fixRoot = new URL('../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/', import.meta.url)
  const base = mkdtempSync(path.join(tmpdir(), 'tavern-error-purge-coord18-'))
  try {
    for (const rel of ['lib/client.js', 'src/client/main.js', 'src/client/turn-error-controls.js', 'src/client/features/play-controls.js', 'src/client/features/turn-history.js', 'src/client/ui/error-center.js', 'src/client/helper-resources.js', 'src/client/runtime/helper-bootstrap.js', 'src/client/runtime/helper-script-runtime.js', 'src/client/modules/tavern-coordination.js']) {
      const dst = path.join(base, 'tavern-plugin', rel)
      mkdirSync(path.dirname(dst), {recursive: true})
      writeFs(dst, readFs(new URL(rel, fixRoot), 'utf8'))
    }
    const built = clientCoreWrites(base).get('tavern-plugin/lib/client.js')
    assert.ok(built.includes('tavernCoordination.invalidate('), '清理链必须调用作者真接口 invalidate')
    assert.ok(!built.includes('tavernCoordination.refresh('), '清理链不得调用不存在的服务级 refresh')
    // ⑤ 旧私有版本迁移（仅文本级、不改产品）：**只把 paired 的 `liveTavernView.rebase(props.sessionId); tavernCoordination.invalidate(props.sessionId);` 翻回旧 refresh**
    //    （作者另外 5 处 invalidate 不动，绝不全局 split）；施缝后必须全迁回且与真产物逐字一致/幂等；混合 2old+2new 不得重复；额外 stray 必须 fail-closed。
    const PAIRED_NEW = /liveTavernView\.rebase\(props\.sessionId\);(\s*)tavernCoordination\.invalidate\(props\.sessionId\);/g
    const PAIRED_OLD = /liveTavernView\.rebase\(props\.sessionId\);(\s*)tavernCoordination\.refresh\(props\.sessionId\);/g
    const countPairs = (text, pattern) => (text.match(pattern) || []).length
    assert.equal(countPairs(built, PAIRED_NEW), 4, '真产物必须恰有 4 处 paired rebase+invalidate')
    assert.equal(countPairs(built, PAIRED_OLD), 0, '真产物不得残留 paired 旧 refresh')
    let flipped = 0
    const legacyProduct = built.replace(PAIRED_NEW, (_all, whitespace) => { flipped += 1; return 'liveTavernView.rebase(props.sessionId);' + whitespace + 'tavernCoordination.refresh(props.sessionId);' })
    assert.equal(flipped, 4, 'legacy 构造必须恰好翻回 4 处 paired（实际 ' + flipped + '）')
    assert.equal(countPairs(legacyProduct, PAIRED_OLD), 4, 'legacy 必须＝4 处旧 paired')
    assert.equal(countPairs(legacyProduct, PAIRED_NEW), 0, 'legacy 不得残留新 paired')
    assert.equal(legacyProduct.split('tavernCoordination.invalidate(').length - 1, built.split('tavernCoordination.invalidate(').length - 1 - 4, 'legacy 只少 4 处 paired invalidate（作者其它 5 处不动）')
    const migrated = applyErrorPurgePlayControlsTransform(legacyProduct)
    assert.equal(countPairs(migrated, PAIRED_OLD), 0, '迁移后不得残留旧 paired refresh')
    assert.equal(countPairs(migrated, PAIRED_NEW), 4, '迁移后必须恢复 4 处 paired invalidate')
    assert.equal(migrated, built, '迁移后必须与真产物逐字一致（strict same product）')
    assert.equal(applyErrorPurgePlayControlsTransform(migrated), migrated, '再 apply 必须幂等')
    let mixedSeen = 0
    const mixed = legacyProduct.replace(PAIRED_OLD, (_all, whitespace) => { mixedSeen += 1; return mixedSeen <= 2 ? 'liveTavernView.rebase(props.sessionId);' + whitespace + 'tavernCoordination.invalidate(props.sessionId);' : _all })
    assert.equal(mixedSeen, 4, '混合输入必须命中 4 处旧 paired')
    assert.equal(countPairs(mixed, PAIRED_NEW), 2, '混合输入＝2 new + 2 old')
    const mixedOut = applyErrorPurgePlayControlsTransform(mixed)
    assert.equal(countPairs(mixedOut, PAIRED_OLD), 0, '混合输入也必须全部迁移')
    assert.equal(countPairs(mixedOut, PAIRED_NEW), 4, '混合输入不得产生重复 paired')
    assert.equal(mixedOut, built, '混合迁移结果必须与真产物逐字一致')
    let unpairedError = null
    try { applyErrorPurgePlayControlsTransform(built + '\n\t\t\tif (ready) tavernCoordination.refresh(props.sessionId);\n') } catch (error) { unpairedError = error }
    assert.ok(unpairedError instanceof Error, '额外 unpaired stray refresh 必须 fail-closed')
    assert.match(String(unpairedError.message), /归属|唯一|配对|paired|不明确|refresh/, 'fail-closed 原因必须指明归属不明确')
    const types = {SupersededTurnErrors: Symbol('SupersededTurnErrors'), TurnHistoryProjection: Symbol('TurnHistoryProjection'), CandidateQuestion: Symbol('CandidateQuestion')}
    const slotProps = () => ({sessionId: 's1', useSession: s => s({running: false}), useChat: s => s({}), useInput: s => s({draft: ''})})
    let waitCount = 0
    const sessions = {waitForTavernRollbackSync: async sync => { waitCount += 1; return sync }, subagentAddress: () => null}
    const dock = runDockRegister(built, LABEL, {sessions, components: types})
    const props = elementsOfType(dock.registered[0].render(slotProps()), types.SupersededTurnErrors)[0].props
    const controlsSource = applyErrorPurgeTurnControlsTransform(readFileSync(new URL(FIX + 'turn-error-controls.js', import.meta.url), 'utf8'))
    const target = failureItem(42, 'op42')
    const receiptOf = cleaned => ({view: {rolledBack: {sync: {id: 'r1'}, ...(cleaned ? {cleanedFailureTarget: cleaned} : {})}}})
    const caseRun = async (label, respond) => {
      const dom = createFallbackDom([])
      const calls = []
      const waitBefore = waitCount
      // 每 case 独立观测窗口：delta 必须相对**本 case 开始前**的 SSE 计数，不能用全局 baseline（否则累计）。
      const caseBaseline = {s1: transports.get('s1').refresh, s2: transports.get('s2').refresh}
      const run = {currentState: null, listeners: [], sessions, created: 0, invalidated: 0, rebased: 0, refreshed: 0, reported: [], tavernCoordination: service,
        rpc: async (method, args, sid) => { calls.push([method, args, sid]); return respond() }}
      const harness = createSupersededHarness(built, dom, run)
      run.currentState = {view: {failureTarget: target, failureCleanupReason: '', suppressedDshErrorTurns: [], hiddenDshErrorTurns: [], staleDshErrorTurns: [], filteredFailureStreak: 0, canRegenerate: false, canReplayFailedTurn: true, replayFailedTurn: 42}}
      harness.render(run.currentState, props)
      const controls = realTurnErrorControls(controlsSource)(dom.root, harness.captures.at(-1))
      controls.apply()
      const prompt = dom.fallbackRows()[0]
      assert.ok(prompt, label + '：必须有真提示行')
      let thrown = null
      try { await dom.toggleOf(prompt).click() } catch (error) { thrown = error }
      controls.dispose()
      const delta = {s1: transports.get('s1').refresh - caseBaseline.s1, s2: transports.get('s2').refresh - caseBaseline.s2}
      return {label, dom, calls, run, waited: waitCount - waitBefore, thrown, delta}
    }
    // ① 正常清理：rpc 1 / 等 sync 1 / rebase 1 / 真 invalidate→s1 handle.refresh 1 / s2 0 / 下一状态帧 / 不毁视图 / 无 onError
    const ok = await caseRun('正常清理', () => receiptOf({turn: target.turn, operationId: target.operationId, branchId: target.branchId, revision: target.revision}))
    assert.deepEqual(ok.calls[0], ['rollbackTurn', {expectedTurn: 42, failureTarget: target}, 's1'])
    assert.equal(ok.waited, 1, '正常清理必须等同连接同步')
    assert.equal(ok.run.rebased, 1, '收据核通过后必须定向 rebase')
    assert.equal(ok.run.reported.length, 0, '成功路径不得触发作者 onError（保存错误提示状态失败）')
    assert.equal(ok.run.invalidated, 0, '不得用 liveTavernView.invalidate 毁掉新视图')
    assert.deepEqual(ok.delta, {s1: 1, s2: 0}, '只失效本档 sid：s1 连接 refresh 1、s2 仍 0')
    assert.deepEqual(service.getSnapshot('s1').view, {cleanable: false, turn: null, reason: ''}, '下一状态必须来自真服务帧')
    assert.equal(ok.thrown, null, '正常清理不得抛（线上即此处 TypeError）')
    // ② alreadyClean：真实收据形状＝`rolledBack.alreadyClean=true`（目标本身不含 alreadyClean）⇒ 不等 sync，但仍 rebase + 真 invalidate
    const clean = await caseRun('alreadyClean', () => ({view: {rolledBack: {alreadyClean: true, sync: {id: 'r1'}, cleanedFailureTarget: {turn: target.turn, operationId: target.operationId, branchId: target.branchId, revision: target.revision}}}}))
    assert.equal(clean.waited, 0, 'alreadyClean 不等待')
    assert.equal(clean.run.rebased, 1, 'alreadyClean 仍需 rebase')
    assert.deepEqual(clean.delta, {s1: 1, s2: 0}, 'alreadyClean 仍须定向失效')
    // ③ RPC 失败：零失效、零 rebase、经作者 onError 上报，且不得返回成功
    const failed = await caseRun('RPC 失败', () => { throw new Error('RPC 语法失败') })
    assert.deepEqual(failed.delta, {s1: 0, s2: 0}, 'RPC 失败不得失效/刷新')
    assert.equal(failed.run.rebased, 0, 'RPC 失败不得 rebase')
    assert.equal(failed.run.reported.length + (failed.thrown ? 1 : 0), 1, '失败必须恰好暴露一次')
    if (failed.run.reported.length === 1) assert.equal(failed.run.reported[0][0], '保存错误提示状态失败', '作者 onError 标签')
    // ④ 收据不匹配：同③（不冒认成功、不失效）
    const mismatch = await caseRun('收据不匹配', () => receiptOf({turn: 42, operationId: 'other-op', branchId: target.branchId, revision: target.revision}))
    assert.deepEqual(mismatch.delta, {s1: 0, s2: 0}, '收据不匹配不得失效/刷新')
    assert.equal(mismatch.run.rebased, 0, '收据不匹配不得 rebase')
    assert.equal(mismatch.run.reported.length + (mismatch.thrown ? 1 : 0), 1, '收据不匹配必须暴露一次')
  } finally {
    rmSync(base, {recursive: true, force: true})
  }
})
