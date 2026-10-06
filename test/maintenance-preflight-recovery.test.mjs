// 定向回归：executeMaintenance 失败恢复的"本次是否真的尝试过 stop"分界。
// 只用最小 adapter/source/driver 桩 + 自有 temp 证据目录：不真实停启服务、不起外部进程、不碰数据库与真实存档。
// 语义（本次要固定的新约定）：
//   ① 只有本次确实调用过 driver.stop() 且它部分失败（safeToRestore 未置位）时，才用 stoppedAfterError() 补证；
//   ② preflight / 源码预检预演失败、本次从未 stop 时，不得调用 stop/stopIfAlive/stopFailedStart/restorePackage/
//      start/verify/verifyRecovery/stoppedAfterError，初因 Error 原样抛出；
//   ③ 真正 stop 部分失败且补证为真时，仍按既有路径恢复（restorePackage→source.restore→start→verifyRecovery），
//      恢复提示保留 stop 初因，且不另停第二实例；
//   ④ 既有失败（stop 已成功）的恢复提示仍如实。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { maintenanceBudget } from '../deploy/maintenance/budget.mjs'
import { executeMaintenance } from '../deploy/maintenance/runner.mjs'
import { STANDARD_RECORD } from '../deploy/maintenance/source.mjs'

const INDEX = 'tavern-plugin/lib/index.js'
// 最小 adapter 桩：targets 只需满足真实 sourceAccess 的有限目标校验（入口 + 三条历史记录）。
const ADAPTER = Object.freeze({
  packageName: 'dsh-tavern-sqlite-v2', line: 'v2', execution: 'server-vm-esm',
  otherHostMarker: '[dsh-tavern-v1-storage-host:v1]',
  targets: [INDEX, 'tavern-plugin/lib/domain/storage-package.js', '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json'],
  applyStandardSeams: () => ({ changed: true }),
  checkStandardSeams: () => ({ ready: true }),
  uninstallStandardSeams: () => {},
  uninstallAllSeams: () => ({ restored: [] }),
})
// "本次从未 stop 就不得出现"的动作清单（driver + source 两侧）。
const RECOVERY_ACTIONS = ['stop', 'stopIfAlive', 'stopFailedStart', 'stoppedAfterError', 'restorePackage',
  'manage:install', 'manage:uninstall', 'start', 'verify', 'verifyRecovery', 'source:restore', 'source:protect', 'source:syntax']

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-preflight-recovery-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-preflight-recovery-'), '只清自己的临时目录'); fs.rmSync(root, { recursive: true, force: true }) })
  const app = path.join(root, 'app')
  fs.mkdirSync(path.join(app, 'tavern-plugin/lib'), { recursive: true })
  fs.writeFileSync(path.join(app, INDEX), options.indexBody ?? '// 作者入口（测试桩，无任何接缝标记）\n', 'utf8')
  const evidenceDir = path.join(root, 'maintenance', ADAPTER.packageName, 'run-1')
  fs.mkdirSync(evidenceDir, { recursive: true })

  const events = [], progress = [], restores = [], startCalls = []
  const fixed = new Set([...ADAPTER.targets, STANDARD_RECORD, 'tavern-plugin/package.json'])
  const file = rel => { if (!fixed.has(rel)) throw new Error('不属于有限源码维护范围：' + rel); return path.resolve(app, rel) }
  const image = () => Object.fromEntries([...fixed].sort().map(rel => [rel, fs.existsSync(file(rel)) ? fs.readFileSync(file(rel)).toString('base64') : null]))
  const source = {
    root: app,
    file,
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
    protect() { events.push('source:protect') },
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
    async start(startOptions = {}) { events.push('start'); startCalls.push(startOptions); return { pid: 4242 } },
    async verify() { events.push('verify'); return { basicHealthVerified: true } },
    async verifyRecovery() { events.push('verifyRecovery'); return { basicHealthVerified: true } },
  }
  const run = action => executeMaintenance({ action, adapter: ADAPTER, driver, source, evidenceDir, progress: text => progress.push(text), budget: maintenanceBudget({ milliseconds: 240000 }) })
  return { root, app, evidenceDir, events, progress, restores, startCalls, source, driver, run }
}
const recoveryActions = f => f.events.filter(name => RECOVERY_ACTIONS.includes(name))

test('preflight 抛"现装不同代"：桌面已停止也不补证，不 stop/restore/start/verifyRecovery，初因原样抛出', async t => {
  const error = new Error('现装不同代；先用本地所属代卸载，不自动升级')
  const f = fixture(t, { preflightError: error })
  assert.equal(f.driver.stoppedAfterErrorReturn, true, '桩若被调用会返回 true——这正是把预检失败误当"可恢复"的陷阱')
  let thrown
  await assert.rejects(f.run('install'), value => { thrown = value; return true })
  assert.equal(thrown, error, '初因 Error 原样抛出（不包 AggregateError、不改写成"已恢复"）')
  assert.equal(thrown.message, '现装不同代；先用本地所属代卸载，不自动升级')
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

test('stop 部分失败且补证为真：按既有路径真恢复、保留 stop 初因、不另停第二实例', async t => {
  const error = new Error('原代停止未完成（PID 仍在退出或身份已变），未写装配/源码，不并起第二进程')
  const f = fixture(t, { withdrawnClean: true, stopError: error })
  let thrown
  await assert.rejects(f.run('uninstall'), value => { thrown = value; return true })
  assert.match(thrown.message, /^维护失败，已恢复原装配及原运行状态：/)
  assert.match(thrown.message, /原代停止未完成/, '恢复提示保留 stop 初因')
  assert.equal(thrown.cause, error)
  assert.equal(f.driver.calls.stop, 1, '本次只尝试过一次 stop；恢复不另停第二实例')
  assert.ok(!f.events.includes('stopIfAlive'), '未起过新进程，不走 stopIfAlive')
  for (const name of ['stoppedAfterError', 'stopFailedStart', 'restorePackage', 'source:restore', 'start', 'verifyRecovery']) {
    assert.ok(f.events.includes(name), 'stop 部分失败仍须按既有路径恢复：' + name)
  }
  assert.equal(f.startCalls.length, 1)
  assert.equal(f.startCalls[0].recovery, true, '恢复启动须显式 recovery')
  assert.equal(f.restores.length, 1)
  assert.deepEqual(f.restores[0], f.source.capture(), '恢复写入的就是停前基线')
  // 同一探针在这里必须全部命中：证明前三例的"无恢复动作"断言不是空集/写错事件名。
  assert.deepEqual([...new Set(recoveryActions(f))].sort(),
    ['restorePackage', 'source:protect', 'source:restore', 'source:syntax', 'start', 'stop', 'stopFailedStart', 'stoppedAfterError', 'verifyRecovery'])
})

test('既有失败路径（stop 已成功、装包失败）：恢复并如实提示，不冒称成功', async t => {
  const error = new Error('官方离线卸包失败：1；不自动联网或关闭供应链策略')
  const f = fixture(t, { withdrawnClean: true, manageError: error })
  let thrown
  await assert.rejects(f.run('uninstall'), value => { thrown = value; return true })
  assert.match(thrown.message, /^维护失败，已恢复原装配及原运行状态：/)
  assert.match(thrown.message, /官方离线卸包失败/)
  assert.equal(thrown.cause, error)
  assert.equal(f.driver.calls.stop, 1)
  assert.equal(f.driver.calls.stoppedAfterError, 0, 'stop 已成功（safeToRestore 已置位），无需补证')
  const at = name => f.events.indexOf(name)
  assert.ok(at('manage:uninstall') >= 0 && at('manage:uninstall') < at('restorePackage'), '先失败再恢复')
  assert.ok(at('restorePackage') < at('start') && at('start') < at('verifyRecovery'), '恢复顺序：装包→源码→启动→复验')
  assert.equal(f.restores.length, 1)
})
