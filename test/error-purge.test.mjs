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
      tavernCoordination.refresh(props.sessionId)
      return resp
    }
    await sessions.waitForTavernRollbackSync(rb.sync)
    setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null)
    liveTavernView.rebase(props.sessionId)
    tavernCoordination.refresh(props.sessionId)
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
  const deps = {rpc, sessions, state:{view:{failureTarget:ft}}, props:{sessionId:'s1', sessions}, setCandidatePanel:()=>{panels++}, setRegenPanel:()=>{panels++}, setCandidateGuidePanel:()=>{panels++}, liveTavernView:{invalidate:()=>{throw new Error('不应invalidate')}, rebase:()=>{rebased++}}, tavernCoordination:{invalidate:()=>{throw new Error('不应invalidate')}, refresh:()=>{refreshed++}}}
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
  const rpc = async ()=>{ rpcCalls++; return {view:{rolledBack:{alreadyClean:true,cleanedFailureTarget:{turn:7,operationId:'op1',branchId:'b1',revision:3}}}} }
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
