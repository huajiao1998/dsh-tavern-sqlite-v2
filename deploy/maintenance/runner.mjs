// V2复用V1本地优先安装器：原profile离线装卸，原运行状态保留，60秒成功预算。
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync, openSync, closeSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { redactStartupLine } from './startup-log.mjs'
import { maintenanceBudget, successBudgetMs } from './budget.mjs'
import { options, runtimeFor, assertTargetAllowed, packagePolicyArgs } from './target.mjs'
import { createDriver } from './driver.mjs'
import { sourceAccess, assertPackageSource, assertSourceUninstalled, rehearseSource, finishSourceUninstall, finishRecoveredSourceUninstall, commitRecoveredPreimage, STANDARD_RECORD } from './source.mjs'
import { findLegacyLeftovers, quarantineLeftovers, leftoverDecision, describeError } from './environment.mjs'
export { options, packagePolicyArgs }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function packageFiles(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (!Array.isArray(pkg.files)) throw Error('插件包未声明files')
  const allowed = new Set(['package.json', ...(existsSync(path.join(root, 'README.md')) ? ['README.md'] : []), ...pkg.files.map(s => s.replace(/\/\*.*$/, ''))]), out = []
  function walk(rel) {
    const file = path.resolve(root, rel)
    if (!file.startsWith(path.resolve(root) + path.sep) || rel.includes('..') || rel.split(path.sep).includes('node_modules')) throw Error('包文件路径越界')
    if (!existsSync(file)) throw Error('本地包不完整：' + rel)
    const st = lstatSync(file)
    if (st.isSymbolicLink()) throw Error('本地插件包不允许外部链接')
    if (st.isDirectory()) for (const name of readdirSync(file)) walk(path.join(rel, name))
    else if (st.isFile()) out.push(rel)
    else throw Error('插件包含特殊文件')
  }
  for (const rel of allowed) { if (rel.includes('*')) throw Error('未支持的files声明'); walk(rel) }
  return [...new Set(out)].sort()
}
export function samePackage(left, right) {
  const files = packageFiles(left), other = packageFiles(right)
  return JSON.stringify(files) === JSON.stringify(other) && files.every(rel => hash(readFileSync(path.join(left, rel))) === hash(readFileSync(path.join(right, rel))))
}
export function copyPackage(from, to) {
  for (const rel of packageFiles(from)) {
    const dst = path.resolve(to, rel)
    if (!dst.startsWith(path.resolve(to) + path.sep)) throw Error('插件复制目的越界')
    mkdirSync(path.dirname(dst), { recursive: true }); copyFileSync(path.resolve(from, rel), dst)
  }
  return JSON.parse(readFileSync(path.join(from, 'package.json'), 'utf8'))
}
export async function executeMaintenance({ action, adapter, driver, source, evidenceDir, progress = () => {}, budget = maintenanceBudget(), prepareEnv = false }) {
  const step = async (name, fn) => { budget.remaining(); progress(name); const value = await fn(); budget.remaining(); return value }
  let safeToRestore = false, stopAttempted = false, baseline, rehearsal, newProcess, result, state, validation
  try {
    // 显式--prepare-env：预检前补环境（systemd单元VM旗标），失败自动回滚并中止。
    if (prepareEnv) await step('环境预修：systemd单元VM旗标（显式--prepare-env，备份可回滚）', () => driver.prepareEnvironment(action))
    state = await step('预检目标/本地运行时/装配（不复制依赖或存档、不认证）', () => driver.preflight(action))
    assertPackageSource(source, adapter)
    // 旧代维护残留备份：仅对非noop的install构成障碍（uninstall/noop时它们是当前安装的自管产物，
    // 卸载由"确切备份归档"收口）——无授权即拒（列清单），有授权隔离到证据目录（只移不删）。
    const leftovers = findLegacyLeftovers(source.root)
    const decision = leftoverDecision({ action, noop: state.noop, prepareEnv, found: leftovers.length })
    if (decision === 'refuse') throw Error('目标树存在旧代维护备份（' + leftovers.length + ' 个，如 ' + leftovers[0] + '）：拒绝猜测覆盖；加 --prepare-env 可自动隔离到维护证据目录（只移动不删除）')
    if (decision === 'quarantine') {
      const moved = quarantineLeftovers(source.root, path.join(evidenceDir, 'leftovers'))
      progress('环境预修：已隔离旧代备份 ' + moved.length + ' 个 → ' + path.join(evidenceDir, 'leftovers'))
      if (findLegacyLeftovers(source.root).length) throw Error('隔离后仍检出血统残留，拒绝继续')
    }
    const wasRunning = state.wasRunning !== false
    if (state.noop) {
      if (action === 'install' && !adapter.checkStandardSeams({ appDir: source.root }).ready) throw Error('现装接缝未ready')
      if (action === 'uninstall') assertSourceUninstalled(source)
      // 同版安装也必须证明可卸载，不能用ready把污染前像静默留给下一次卸载。
      const removable = action === 'install' ? await step('幂等安装：验证卸载前像恢复链', () => rehearseSource('uninstall', source, adapter, evidenceDir, () => budget.remaining())) : null
      let undo
      try {
        if (removable?.recovery) undo = commitRecoveredPreimage(source, removable)
        validation = await step('幂等检查；保留原运行状态', () => driver.verify(action, adapter, { existing: true }))
      } catch (error) { undo?.(); throw error }
      return { changed: !!removable?.recovery, action, line: adapter.line, initialState: wasRunning ? 'running' : 'stopped', finalState: wasRunning ? 'running' : 'stopped', elapsedMs: Math.round(budget.elapsed()), verified: true, verificationScope: wasRunning ? 'source-assembly-basic-health' : 'source-assembly-stopped', originalPlayabilityVerified: false, ...validation, ...(removable?.recovery ? { preimageRecovery: removable.recovery.provenance, sourceMetadataRepaired: true } : {}), data: '保留，未访问/转换/删除' }
    }
    // 只预演有限程序源码接缝，不创建第二套profile/node_modules或业务树。
    if (action === 'uninstall' && state.withdrawnClean) {
      // 宿主退出已撤缝：源码即作者原像，无恢复材料可演；protect幂等后重验零接管标记。
      rehearsal = await step('宿主退出已撤缝：重验源码为作者原像（无恢复材料）', () => {
        source.protect(); source.syntax(); assertSourceUninstalled(source)
        const image = source.capture()
        return { before: image, expected: image, withdrawnClean: true }
      })
    } else {
      rehearsal = await step('有限源码接缝预检及恢复材料', () => rehearseSource(action, source, adapter, evidenceDir, () => budget.remaining()))
    }
    baseline = rehearsal.before
    writeFileSync(path.join(evidenceDir, 'source-before.json'), JSON.stringify(baseline) + '\n', 'utf8')
    await step(wasRunning ? '重核目标并精确停止原实例' : '重核目标仍停止；不拉起', async () => {
      source.assertImage(baseline); await driver.assertIdentity()
      if (wasRunning) { stopAttempted = true; await driver.stop() }
      else await driver.assertStopped()
      safeToRestore = true
    })
    if (action === 'install') {
      await step('目标profile官方离线装包/回读', () => driver.manage('install'))
      await step('作者未加载时接入插件接缝', () => { source.protect(); adapter.applyStandardSeams({ appDir: source.root }); if (!adapter.checkStandardSeams({ appDir: source.root }).ready) throw Error('接缝未ready') })
    } else if (state.withdrawnClean) {
      // 退出撤缝态：源码已是作者原像（disposer撤净），无接缝可卸，仅移除装配；原档与数据库不动。
      await step('卸载装配（源码已为作者原像，无接缝可卸）；保留原档和数据库', () => { assertSourceUninstalled(source) })
      await step('目标profile官方离线卸包/回读', () => driver.manage('uninstall'))
      result = { outcome: { withdrawnClean: true, restored: [], mainRestored: [], hadMainManifest: false }, archived: [], data: '用户数据未访问、未删除、未转换', protection: '独立原件保护保留' }
    } else {
      const raw = baseline[STANDARD_RECORD], record = raw ? JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) : null
      await step('卸载自有接缝；保留原档和数据库', () => { result = rehearsal.recovery ? finishRecoveredSourceUninstall(source, adapter, record, rehearsal, path.join(evidenceDir, 'source-archives')) : finishSourceUninstall(source, adapter, record, path.join(evidenceDir, 'source-archives')) })
      source.assertImage(rehearsal.expected)
      await step('目标profile官方离线卸包/回读', () => driver.manage('uninstall'))
    }
    source.assertImage(rehearsal.expected, { installation: action === 'install' })
    if (wasRunning) newProcess = await step('按原方式恢复运行实例（不经迁移launcher）', () => driver.start())
    validation = await step(wasRunning ? '源码/装配/进程/HTTP基础健康（网页由用户确认）' : '源码/装配及停止态验收', () => driver.verify(action, adapter, { process: newProcess }))
    return { changed: true, action, line: adapter.line, execution: adapter.execution, initialState: wasRunning ? 'running' : 'stopped', finalState: wasRunning ? 'running' : 'stopped', elapsedMs: Math.round(budget.elapsed()), verified: true, verificationScope: wasRunning ? 'source-assembly-basic-health' : 'source-assembly-stopped', originalPlayabilityVerified: false, ...validation, ...(result || {}), data: '保留，未访问/转换/删除' }
  } catch (error) {
    error.message = redactStartupLine(error.message)
    // 预算超时不放弃恢复；恢复不计入成功时间，也不作为成功返回。
    // 只有本次已走到停服/写入阶段才允许恢复；原本停止不等于被本次停掉。
    if (safeToRestore || stopAttempted) driver.beginRecovery?.()
    if (!safeToRestore && stopAttempted) {
      // 停止核验自身的失败不得顶掉初因（188实测：恢复路径秒抛把真正的stop超时完全藏掉）。
      try { if (await driver.stoppedAfterError?.()) safeToRestore = true }
      catch (verify) { throw new AggregateError([error, verify], '维护失败且停止核验未完成；初因：' + describeError(error) + '；核验原因：' + redactStartupLine(verify.message) + '；不盲目重试') }
    }
    if (safeToRestore) {
      try {
        progress('失败恢复：原装配/源码及原运行状态；不盲目重试')
        if (newProcess) await driver.stopIfAlive(newProcess)
        else await driver.stopFailedStart?.()
        if (baseline) {
          await driver.restorePackage()
          source.restore(baseline)
          if (!baseline[STANDARD_RECORD]) source.protect()
          source.syntax()
        } else {
          // 失败发生在**源码基线捕获之前**（预检阶段就抛）：源码树与 profile 装配都一字未改，
          // 没有可恢复的对象；早期版本在这里拿 undefined 去 source.restore ⇒
          // "Cannot convert undefined or null to object"（真机实测踩到）。
          progress('失败发生在源码基线之前：源码与装配未修改，无需恢复')
        }
        if (state?.wasRunning !== false) { const restored = await driver.start({ recovery: true }); await driver.verifyRecovery(restored) }
        else await driver.assertStopped()
      } catch (recovery) {
        throw new AggregateError([error, recovery], '维护失败且恢复未完成；初因：' + error.message + '；恢复原因：' + redactStartupLine(recovery.message) + '；不盲目重试')
      }
      throw new Error('维护失败，已恢复原装配及原运行状态：' + describeError(error), { cause: error })
    }
    throw error
  }
}
// CLI 与回归共用同一只读检查分支：证据副本可写，目标源码/profile不写。
export async function checkMaintenance({ action, adapter, driver, source, evidenceDir, budget = maintenanceBudget() }) {
  const state = await driver.preflight(action); assertPackageSource(source, adapter)
  if (state.noop && action === 'uninstall') assertSourceUninstalled(source)
  const inspection = state.noop && action === 'uninstall' ? null
    : state.withdrawnClean && action === 'uninstall' ? { result: { withdrawnClean: true, note: '宿主退出已撤缝：源码即作者原像，卸载仅移除装配' } }
    : rehearseSource(state.noop ? 'uninstall' : action, source, adapter, evidenceDir, () => budget.remaining())
  const result = { initialState: state.wasRunning ? 'running' : 'stopped', ...(inspection?.result || {}), ...(inspection?.recovery ? { repairAvailable: true, targetModified: false } : {}), leftovers: findLegacyLeftovers(source.root), elapsedMs: Math.round(budget.elapsed()), check: true, changed: false }
  budget.remaining()
  return result
}
// 失败也必须在前台 stdout 明确给出脱敏初因及结果路径，不能只留 stderr/恢复进度。
export function reportMaintenanceFailure(error, evidence, elapsedMs, output = console.log) {
  const message = redactStartupLine(describeError(error)), resultFile = path.join(evidence, 'result.json')
  writeFileSync(resultFile, JSON.stringify({ ok: false, elapsedMs, message }, null, 2) + '\n', 'utf8')
  output('维护失败：' + message)
  output('失败结果：' + resultFile)
  error.maintenanceReported = true
}
export function runCli(url, adapter) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(url)) return
  const main = async () => {
    if (process.argv.includes('--help')) {
      console.log(`${adapter.packageName} 离线装卸（macOS/Linux/WSL2 CLI；作者2.5.0/DSH rc.2）\nnode deploy/maintenance.mjs install|uninstall [--home <已有安装目录>] [--port <核对端口>] [--systemd-unit <既有单元>] [--prepare-env] [--check] [--background]\n默认apply；本地完整包不联网、不索取网页凭证、不复制依赖/存档。运行中停止后按原方式恢复；原本停止则保持停止。包就绪后60秒成功预算；异常恢复独立处理。网页/真实玩法由用户确认。\nV2运行中目标须已带--experimental-vm-modules；默认不改启动配置。--prepare-env（仅install）显式授权两件环境预修：①systemd单元ExecStart补VM旗标（备份原unit、失败自动回滚）；②旧代维护残留备份隔离到证据目录（只移动不删除）。四个解析依赖须离线可用，不补装宿主peer、不联网补依赖。`)
      return
    }
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw Error('不支持的平台：' + process.platform)
    const op = options(process.argv.slice(2)); assertTargetAllowed(op)
    // 原生 Windows 目前只放行**桌面版**（Electron，宿主标记 .dsh-tavern-local.json）：
    // 它的停/启不由安装器接管（只做存在性判定＋提示用户从托盘退出），装包走桌面版自己的 CLI。
    // Windows **CLI 版**需要把服务停/启交还作者的生命周期命令，该通路尚未接线——明确拒绝，不猜测。
    if (process.platform === 'win32' && op.host !== 'desktop') {
      throw Error('原生 Windows 仅支持酒馆桌面版（data/harness 布局）；Windows CLI 版安装通路尚未接线，拒绝猜测')
    }
    // 每次Node交接的启动/import/目录识别也算入共享时间，不在worker入口重新从零计时。
    const budget = maintenanceBudget({ milliseconds: successBudgetMs(op.host), elapsed: Number(op.elapsed || 0) + performance.now() }), root = path.dirname(path.dirname(fileURLToPath(url))), runtime = runtimeFor(op)
    budget.remaining()
    packageFiles(root)
    const evidence = op.evidence ? path.resolve(op.evidence) : path.join(op.home, 'maintenance', adapter.packageName, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID())
    if (!evidence.startsWith(path.join(op.home, 'maintenance') + path.sep)) throw Error('维护输出不能位于业务目录')
    for (let p = evidence; p !== path.dirname(op.home); p = path.dirname(p)) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw Error('维护输出不允许符号链接')
    if(!op.internal && existsSync(evidence))throw Error('维护输出目录须为本次新目录，不覆盖已有证据/执行器')
    mkdirSync(evidence, { recursive: true, mode: 0o700 })
    if (!op.internal) {
      const staged = path.join(evidence, 'executor-package'); copyPackage(root, staged)
      budget.remaining()
      const args = [path.join(staged, 'deploy', 'maintenance.mjs'), op.action, '--home', op.home, '--app', op.app, '--profile', op.profile, op.check ? '--check' : '--apply', '--internal', '--evidence', evidence, '--elapsed', String(budget.elapsed()), ...(op.port ? ['--port', op.port] : []), ...(op['systemd-unit'] ? ['--systemd-unit', op['systemd-unit']] : []), ...(op['prepare-env'] ? ['--prepare-env'] : [])]
      if (op.background) {
        // Windows 上 detached:true 的语义是"新控制台窗口"（POSIX 才是脱离会话）——必须显式隐藏，
        // 否则用户会看到一连串弹出的命令行窗口。后台模式仍需 detached 以在父进程退出后继续。
        const fd = openSync(path.join(evidence, 'job.log'), 'wx', 0o600), child = spawn(process.execPath, args, { cwd: op.app, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); closeSync(fd)
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref()
        console.log('维护已后台启动；PID=' + child.pid + '；结果=' + path.join(evidence, 'result.json')); return
      }
      // 默认等待同一独立作业结果；Ctrl-C或终端断开不会中断恢复，且用户能看到进度。
      // **Windows 上保持 detached + windowsHide**：detached 让子进程有自己的（隐藏）控制台，
      // 父终端的 Ctrl-C 不会传给它（恢复不中断——这是本路径的既有承诺）；windowsHide 隐藏
      // 新控制台（否则就是用户实测的"不停弹命令行窗口"）；输出经 stdio:inherit 仍显示在本窗口。
      const child = spawn(process.execPath, args, { cwd: op.app, detached: true, windowsHide: true, stdio: 'inherit' })
      const detach = () => { child.unref(); console.error('终端中断；维护/恢复继续。结果：' + path.join(evidence, 'result.json')); process.exit(130) }
      process.once('SIGINT', detach); process.once('SIGTERM', detach)
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
      process.removeListener('SIGINT', detach); process.removeListener('SIGTERM', detach); process.exitCode = code ?? 1; return
    }
    const { withFileLock } = await import(runtime.atomicUrl)
    await withFileLock(path.join(op.home, 'maintenance', op.profile + '-plugin-operation'), async () => {
      const source = sourceAccess(op.app, adapter.targets), driver = createDriver(op, adapter, root, evidence, budget)
      const progress = text => console.log(Math.round(budget.elapsed()) + 'ms ' + text)
      try {
        let result
        if (op.check) result = await checkMaintenance({ action: op.action, adapter, driver, source, evidenceDir: evidence, budget })
        else result = await executeMaintenance({ action: op.action, adapter, driver, source, evidenceDir: evidence, progress, budget, prepareEnv: !!op['prepare-env'] })
        writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ ok: true, network: 'offline', ...result }, null, 2) + '\n', 'utf8')
        console.log(JSON.stringify({ ok: true, network: 'offline', ...result }))
        console.log('结果：' + path.join(evidence, 'result.json'))
      } catch (error) {
        reportMaintenanceFailure(error, evidence, Math.round(budget.elapsed()))
        throw error
      }
    }, { waitMs: 0 })
  }
  main().catch(error => { if (!error.maintenanceReported) console.log('维护失败：' + redactStartupLine(describeError(error))); process.exitCode = 1 })
}
