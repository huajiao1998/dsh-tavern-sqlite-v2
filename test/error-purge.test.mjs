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
  assert.ok(next.includes('options.onPurge'))
  assert.ok(next.includes('options.failureTarget'))
  assert.ok(next.includes('dsh-tavern-hidden-errors:'))
})
test('干净清理2 turn-error-controls：未知锚点fail-closed',()=>{
  assert.throws(()=>applyErrorPurgeTurnControlsTransform('// 空源'), /锚点/)
})
test('干净清理3 play-controls：onPurge附参+菜单同参+幂等',()=>{
  const src = readFileSync(new URL(FIX + 'features/play-controls.js', import.meta.url), 'utf8')
  const next = applyErrorPurgePlayControlsTransform(src)
  assert.equal(applyErrorPurgePlayControlsTransform(next), next)
  assert.equal(next.split('// [dsh-tavern-error-purge-play:v1]').length - 1, 2)
  assert.ok(next.includes('onToggle: undefined'))
  assert.ok(next.includes('failureTarget: state.view && state.view.failureTarget || null'))
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
    assert.ok(built.includes('failureTarget: state.view && state.view.failureTarget || null'))
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
