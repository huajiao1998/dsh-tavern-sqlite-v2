// 定向回归：预检从未stop不得伪恢复；共用兜底失败保存初因并恢复原运行状态。
// install预检仍用最小桩；uninstall恢复用随包真实有限官方源码和真实adapter。
// 仅自建temp/合成driver，不真实停启服务、不碰数据库与用户存档。
// stop失败且assertStopped桩核为已停：源码装配尚未写，不重放不必要恢复，只恢复原进程。
// 源码已写后装配归档失败：有限源码逐字回滚、装配restore后恢复原进程并verifyRecovery。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { maintenanceBudget } from '../deploy/maintenance/budget.mjs'
import { executeMaintenance } from '../deploy/maintenance/runner.mjs'
import { STANDARD_RECORD } from '../deploy/maintenance/source.mjs'
import { maintenanceAdapter } from '../deploy/maintenance.mjs'
import { prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const INDEX = 'tavern-plugin/lib/index.js'
// 最小 adapter 桩：targets 只需满足真实 sourceAccess 的有限目标校验（入口 + 三条历史记录）。
const ADAPTER = Object.freeze({
  packageName: 'dsh-tavern-sqlite-v2', line: 'v2', execution: 'server-vm-esm',
  otherHostMarker: '[dsh-tavern-v1-storage-host:v1]',
  targets: [INDEX, 'tavern-plugin/lib/domain/storage-package.js', '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json'],
  applyStandardSeams: () => ({ changed: true }),
  checkStandardSeams: () => ({ ready: true }),
  uninstallStandardSeams: () => {},
})
// "本次从未 stop 就不得出现"的动作清单（driver + source 两侧）。
const RECOVERY_ACTIONS = ['stop', 'stopIfAlive', 'stopFailedStart', 'stoppedAfterError', 'restorePackage',
  'manage:install', 'manage:uninstall', 'start', 'verify', 'verifyRecovery', 'source:restore', 'source:syntax']

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-preflight-recovery-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-preflight-recovery-'), '只清自己的临时目录'); fs.rmSync(root, { recursive: true, force: true }) })
  const app = path.join(root, 'app')
  fs.mkdirSync(path.join(app, 'tavern-plugin/lib'), { recursive: true })
  const activeAdapter = options.withdrawnClean ? maintenanceAdapter : ADAPTER
  if (options.withdrawnClean) {
    // 真实作者源码只从 fixtures/comment-author-tree.mjs 取（env DSH_TAVERN_TEST_APP 优先）；缺来源即如实失败，不假造作者树、不造 catalog API。
    const prepared = prepareCommentAuthorTree()
    if (!prepared) throw new Error('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）：本用例需真实作者源码')
    t.after(() => prepared.cleanup())
    fs.cpSync(prepared.appDir, app, { recursive: true })
  } else fs.writeFileSync(path.join(app, INDEX), options.indexBody ?? '// 作者入口（测试桩，无任何接缝标记）\n', 'utf8')
  const evidenceDir = path.join(root, 'maintenance', ADAPTER.packageName, 'run-1')
  fs.mkdirSync(evidenceDir, { recursive: true })

  const events = [], progress = [], restores = [], startCalls = []
  const fixed = new Set([...activeAdapter.targets, STANDARD_RECORD, 'tavern-plugin/package.json'])
  const file = rel => { if (!fixed.has(rel)) throw new Error('不属于有限源码维护范围：' + rel); return path.resolve(app, rel) }
  const image = () => Object.fromEntries([...fixed].sort().map(rel => [rel, fs.existsSync(file(rel)) ? fs.readFileSync(file(rel)).toString('base64') : null]))
  const source = {
    root: app,
    file,
    // 新契约（assertPackageSource 2026-10-09 版）：targets/inspect/旧记录与接管闸都按最小桩提供——
    // inspect 只做行注释收集（本文件夹具的标记都在行注释里），其余闸在桩语义下恒为干净。
    targets: [...activeAdapter.targets],
    inspect(rel) { const target = file(rel); if (!fs.existsSync(target)) return null; const text = fs.readFileSync(target, 'utf8'); return { lineComments: text.split('\n').filter(line => line.trimStart().startsWith('//')).map(line => line.trim()) } },
    assertNoOldRecords() {},
    readRecord() { return null },
    blockPresence() { return [] },
    takeoverPresence() { return [] },
    cleanState() { return true },
    capture() { events.push('source:capture'); if (options.captureError) throw options.captureError; return image() },
    restore(value) {
      events.push('source:restore'); restores.push(value)
      for (const [rel, body] of Object.entries(value)) {
        const target = file(rel)
        if (body === null) { if (fs.existsSync(target)) fs.unlinkSync(target) } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(body, 'base64')) }
      }
    },
    assertImage(value) {
      events.push('source:assertImage')
      for (const [rel, body] of Object.entries(value)) {
        const target = file(rel), current = fs.existsSync(target) ? fs.readFileSync(target).toString('base64') : null
        if (current !== body) throw new Error('源码前像不匹配：' + rel)
      }
    },
    syntax() { events.push('source:syntax') },
  }
  const driver = {
    // 桌面版真实桩语义：目标确实已停止时 stoppedAfterError() 返回 true——旧逻辑正是靠它把预检失败当"可恢复"。
    stoppedAfterErrorReturn: true,
    calls: { stop: 0, stoppedAfterError: 0 },
    async preflight() { events.push('preflight'); if (options.preflightError) throw options.preflightError; return { noop: false, wasRunning: true, ...(options.withdrawnClean ? { withdrawnClean: true } : {}) } },
    async assertIdentity() { events.push('assertIdentity') },
    async assertStopped() { events.push('assertStopped') },
    async stop() { events.push('stop'); driver.calls.stop++; if (options.stopError) throw options.stopError; return { changed: true } },
    async stopIfAlive() { events.push('stopIfAlive') },
    async stopFailedStart() { events.push('stopFailedStart') },
    async stoppedAfterError() { driver.calls.stoppedAfterError++; events.push('stoppedAfterError'); return driver.stoppedAfterErrorReturn },
    beginRecovery() { events.push('beginRecovery') },
    async restorePackage() { events.push('restorePackage'); return { changed: true } },
    async manage(action) { events.push('manage:' + action); if (options.manageError) throw options.manageError; return {} },
    async manageResidual(action) { events.push('manageResidual:' + action); if (action === 'uninstall' && options.manageError) throw options.manageError; return {} },
    async start(startOptions = {}) { events.push('start'); startCalls.push(startOptions); return { pid: 4242 } },
    async verify() { events.push('verify'); return { basicHealthVerified: true } },
    async verifyRecovery() { events.push('verifyRecovery'); return { basicHealthVerified: true } },
  }
  const run = action => executeMaintenance({ action, adapter: activeAdapter, driver, source, evidenceDir, progress: text => progress.push(text), budget: maintenanceBudget({ milliseconds: 240000 }) })
  return { root, app, evidenceDir, events, progress, restores, startCalls, source, driver, run }
}
const recoveryActions = f => f.events.filter(name => RECOVERY_ACTIONS.includes(name))

test('preflight 抛合成拒绝：桌面已停止也不补证，不 stop/restore/start/verifyRecovery，初因原样抛出', async t => {
  const error = new Error('维护预检拒绝（合成初因）')
  const f = fixture(t, { preflightError: error })
  assert.equal(f.driver.stoppedAfterErrorReturn, true, '桩若被调用会返回 true——这正是把预检失败误当"可恢复"的陷阱')
  let thrown
  await assert.rejects(f.run('install'), value => { thrown = value; return true })
  assert.equal(thrown, error, '初因 Error 原样抛出（不包 AggregateError、不改写成"已恢复"）')
  assert.equal(thrown.message, '维护预检拒绝（合成初因）')
  assert.deepEqual(recoveryActions(f), [], '本次从未 stop：无任何恢复动作')
  assert.equal(f.driver.calls.stop, 0)
  assert.equal(f.driver.calls.stoppedAfterError, 0, '未尝试 stop 就不允许 stoppedAfterError 补证')
  assert.deepEqual(f.startCalls, [])
})

test('源码预演失败（capture 抛）：本次从未 stop 时不伪恢复，保留初因', async t => {
  const error = new Error('源码预演失败：有限源码捕获拒绝（测试桩）')
  const f = fixture(t, { captureError: error })
  let thrown
  await assert.rejects(f.run('install'), value => { thrown = value; return true })
  assert.equal(thrown, error, '初因 Error 原样抛出')
  assert.equal(thrown.message, '源码预演失败：有限源码捕获拒绝（测试桩）')
  assert.deepEqual(recoveryActions(f), [], '预演失败且从未 stop：不 stop/不恢复/不启动/不补证')
  assert.equal(f.driver.calls.stop, 0)
  assert.equal(f.driver.calls.stoppedAfterError, 0)
  assert.deepEqual(f.restores, [])
})

test('作者入口带另一功能线标记：真实源码预检停前拒绝，无恢复动作', async t => {
  const f = fixture(t, { indexBody: '// [dsh-tavern-v1-storage-host:v1] 另一功能线接缝\n' })
  let thrown
  await assert.rejects(f.run('install'), value => { thrown = value; return true })
  assert.match(thrown.message, /另一功能线接缝不能直接覆盖/)
  assert.ok(!/已恢复/.test(thrown.message), '预检拒绝不得改写成"已恢复"')
  assert.deepEqual(recoveryActions(f), [])
  assert.equal(f.driver.calls.stop, 0)
  assert.equal(f.driver.calls.stoppedAfterError, 0)
})

test('stop 部分失败但桩已停：不写源码装配，只恢复原应运行进程，保留初因', async t => {
  const error = new Error('原代停止未完成（PID 仍在退出或身份已变），未写装配/源码，不并起第二进程')
  const f = fixture(t, { withdrawnClean: true, stopError: error }), before=f.source.capture()
  let thrown
  await assert.rejects(f.run('uninstall'), value => { thrown = value; return true })
  assert.equal(thrown.cause, error, '原始失败不得被伪成功返回或丢失（经 cause 保留初因身份）')
  assert.ok(thrown.message.includes('已恢复原装配及原运行状态') && thrown.message.includes('原代停止未完成'), '包装信息必须含恢复事实与初因')
  assert.equal(f.driver.calls.stop,1)
  assert.equal(f.driver.calls.stoppedAfterError,1,'停止失败后由 stoppedAfterError 补证"确实已停"才允许恢复（runner 停止核验路由）')
  assert.ok(!f.events.includes('stopIfAlive'),'未启动新进程，不停第二实例')
  assert.ok(f.events.includes('stopFailedStart'))
  assert.ok(!f.events.some(name=>name.startsWith('manageResidual:')||name==='restorePackage'||name==='source:restore'))
  assert.equal(f.startCalls.length,1);assert.equal(f.startCalls[0].recovery,true)
  assert.ok(f.events.indexOf('start')<f.events.indexOf('verifyRecovery'))
  assert.deepEqual(f.source.capture(),before,'stop失败前没有源码/装配写入，原像逐字保留')
  assert.equal(fs.existsSync(path.join(f.evidenceDir,'residual-source-before.json')),false)
  assert.equal(f.restores.length,0)
})

test('既有失败路径（stop 已成功、残留装配失败）：回滚源码/装配并恢复原运行状态，不冒成功', async t => {
  const error = new Error('残留装配归档失败：合成故障')
  const f = fixture(t, { withdrawnClean: true, manageError: error }), before=f.source.capture()
  let thrown
  await assert.rejects(f.run('uninstall'), value => { thrown = value; return true })
  assert.equal(thrown.cause, error, '原始失败不得吞掉（经 cause 保留初因身份）')
  assert.ok(thrown.message.includes('已恢复原装配及原运行状态') && thrown.message.includes('残留装配归档失败'), '包装信息必须含恢复事实与初因')
  assert.equal(f.driver.calls.stop,1);assert.equal(f.driver.calls.stoppedAfterError,0,'stop 已成功：无需停止补证')
  const at=name=>f.events.indexOf(name)
  assert.ok(at('manage:uninstall')>=0&&at('manage:uninstall')<at('restorePackage'),'实际失败后才恢复装配')
  assert.ok(at('restorePackage')<at('start')&&at('start')<at('verifyRecovery'),'恢复装配后启动并验恢复')
  assert.equal(f.startCalls.length,1);assert.equal(f.startCalls[0].recovery,true)
  assert.deepEqual(f.source.capture(),before,'包括原入口字节在内，有限源码全部回滚')
  assert.ok(fs.existsSync(path.join(f.evidenceDir,'source-before.json')),'恢复材料必须保存')
})
