// V2 块机制本地维护：安装与卸载走同一条执行序列（预检 → 本次有限副本预演 → 精确停服 → 官方离线装/卸包 →
// 块施缝/撤缝 → 本次回读 → 按原方式启服 → 验收）。取消旧残留卸载链与旧原像恢复：
// 不恢复任何历史 before，只回滚**本次 capture**，且仅当现场仍等于本次 expected 才回写（第三方改过即拒）。
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, lstatSync, openSync, closeSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { redactStartupLine } from './startup-log.mjs'
import { maintenanceBudget, successBudgetMs } from './budget.mjs'
import { options, runtimeFor, assertTargetAllowed, packagePolicyArgs } from './target.mjs'
import { createDriver } from './driver.mjs'
import { describeError } from './environment.mjs'
import { sourceAccess, assertPackageSource, assertSourceUninstalled, rehearseSource, sameImage } from './source.mjs'
export { options, packagePolicyArgs }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function packageFiles(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (!Array.isArray(pkg.files)) throw Error('插件包未声明files')
  // 发行包内禁止 README.md（根 README 是仓库门面，曾被安装说明覆盖）：包文件只认中文安装指南，不认 README。
  const allowed = new Set(['package.json', ...(existsSync(path.join(root, 'INSTALL.zh-CN.md')) ? ['INSTALL.zh-CN.md'] : []), ...pkg.files.map(s => s.replace(/\/\*.*$/, ''))]), out = []
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

/** 统一结果骨架：install/uninstall 同形，便于回执比对。 */
function report(adapter, action, wasRunning, extra) {
  return {
    action, line: adapter.line, execution: adapter.execution,
    initialState: wasRunning ? 'running' : 'stopped', finalState: wasRunning ? 'running' : 'stopped',
    originalPlayabilityVerified: false, data: '保留，未访问/转换/删除', ...extra,
  }
}

export async function executeMaintenance({ action, adapter, driver, source, evidenceDir, progress = () => {}, budget = maintenanceBudget(), prepareEnv = false }) {
  const step = async (name, fn) => { budget.remaining(); progress(name); const value = await fn(); budget.remaining(); return value }
  let safeToRestore = false, stopAttempted = false, baseline = null, expected = null, operationBefore = null, sourceTouched = false, newProcess = null, result = null, state = null, validation = null
  try {
    // 显式 --prepare-env：预检前补环境（systemd 单元 VM 旗标），失败自动回滚并中止（旧"残留备份隔离"分支随旧机制退役）。
    if (prepareEnv && action === 'install') await step('环境预修：systemd单元VM旗标（显式 --prepare-env，备份可回滚）', () => driver.prepareEnvironment(action))
    state = await step('预检目标/本地运行时/装配（不复制依赖或存档、不认证）', () => driver.preflight(action))
    assertPackageSource(source, adapter, { allowRebase: action === 'install', operation: action })
    const wasRunning = state.wasRunning !== false
    if (state.noop) {
      if (action === 'uninstall') {
        if (source.cleanState()) {
          assertSourceUninstalled(source)
          validation = await step('幂等卸载检查；保留原运行状态', () => driver.verify(action, adapter, { existing: true }))
          return report(adapter, action, wasRunning, { changed: false, verified: true, verificationScope: wasRunning ? 'source-assembly-basic-health' : 'source-assembly-stopped', elapsedMs: Math.round(budget.elapsed()), ...validation })
        }
        // 包已不在装配中但源码仍带块记录：只撤源码（不走官方卸包，也不还原任何历史前像）。
        state = { ...state, noop: false, assemblySkip: true }
        progress('包已不在装配中：只按块记录撤源码接缝')
      } else {
        const plan = typeof adapter.inspectStandardSeamsPlan === 'function' ? adapter.inspectStandardSeamsPlan({ appDir: source.root }) : null
        if (plan?.needsReapply !== true) {
          if (!adapter.checkStandardSeams({ appDir: source.root }).ready) throw Error('现装接缝未ready')
          validation = await step('幂等安装检查；保留原运行状态', () => driver.verify(action, adapter, { existing: true }))
          return report(adapter, action, wasRunning, { changed: false, verified: true, verificationScope: wasRunning ? 'source-assembly-basic-health' : 'source-assembly-stopped', elapsedMs: Math.round(budget.elapsed()), ...validation })
        }
        state = { ...state, noop: false, reapply: true } // 同包已装但块需重接：跳过重装，只改源码
        progress('同包已装：跳过重装，只按块记录重接源码')
      }
    }
    // 无块、无记录、无旧标记：卸载只需移除装配，源码零写。
    const assemblyOnly = action === 'uninstall' && source.cleanState()
    if (assemblyOnly) progress('无块、无记录：卸载只撤装配（源码零写）')
    const rehearsal = assemblyOnly
      ? { before: source.capture(), expected: source.capture(), result: { assemblyOnly: true } }
      : await step('本次有限副本预演（只复制本次写集，不用任何旧原像资产）', () => rehearseSource(action, source, adapter, evidenceDir, () => budget.remaining()))
    baseline = rehearsal.before; expected = rehearsal.expected; result = rehearsal.result
    writeFileSync(path.join(evidenceDir, 'source-before.json'), JSON.stringify(baseline) + '\n', 'utf8')
    await step(wasRunning ? '重核目标并精确停止原实例' : '重核目标仍停止；不拉起', async () => {
      source.assertImage(baseline); await driver.assertIdentity()
      if (wasRunning) { stopAttempted = true; await driver.stop() }
      else await driver.assertStopped()
      safeToRestore = true
      // 停服期间 runtime disposer 可能按块记录撤缝（删记录＋撤作者行）：只接受"仍等于预演基准"或"等于本次撤缝投影"，
      // 并以**停后现场**作为实际写前恢复基准；其他一律拒（不粗暴 capture 就接受）。
      const stopped = source.capture()
      if (sameImage(stopped, baseline)) operationBefore = baseline
      else if (sameImage(stopped, rehearsal.cleaned || rehearsal.expected)) {
        operationBefore = stopped
        progress('停止后检测到运行时已按块记录撤缝：以停后现场为写前基准')
      } else throw Error('停止后源码既非预演基准也非本次撤缝投影：拒绝写入（疑似第三方改动）')
    })
    if (action === 'install') {
      if (driver.upgrading) await step('现装同包不同代：先移除旧装配再装新代（单命令内，失败仍按原装配/原状态恢复）', async () => { await driver.manage('uninstall'); await driver.manage('install') })
      else if (!state.reapply) await step('目标profile官方离线装包/回读', () => driver.manage('install'))
      else await step('同包已装且块需重接：跳过重装，只改源码块', async () => {})
      await step('作者未加载时块施缝（写前/写后各核一次停止态）', async () => {
        await driver.assertStopped() // CLI 侧先精确确证停止；随后给 apply 的同步断言只表达"已确证停止"，不是异步函数假 true
        sourceTouched = true // 语义＝"已尝试写源码"：在 apply 之前置位，失败一律走本次有限回滚
        // 不再隐式 protectIfBare（改块外源码属原件保护业务；主将纳入有归属区块后另行接入）
        adapter.applyStandardSeams({ appDir: source.root, allowRebase: true, assertStopped: () => true })
        await driver.assertStopped() // 写入期间被拉起即失败，交恢复路径处理
        if (!adapter.checkStandardSeams({ appDir: source.root }).ready) throw Error('块接缝未ready')
      })
    } else {
      if (!assemblyOnly) await step('按现场区块撤自有接缝（只改本次有限写集）', async () => {
        await driver.assertStopped()
        sourceTouched = true
        adapter.uninstallStandardSeams({ appDir: source.root, assertStopped: () => true })
        await driver.assertStopped()
      })
      if (!state.assemblySkip) await step('目标profile官方离线卸包/回读', () => driver.manage('uninstall'))
    }
    source.assertImage(expected, { installation: action === 'install' })
    if (wasRunning) newProcess = await step('按原方式恢复运行实例（不经迁移launcher）', () => driver.start())
    validation = await step(wasRunning ? '源码/装配/进程/HTTP基础健康（网页由用户确认）' : '源码/装配及停止态验收', () => driver.verify(action, adapter, { process: newProcess }))
    // 生命周期字段是本次维护的权威结论：seam 结果只以 seams 命名空间回报，避免它的 changed 覆盖维护结论（预演在已装副本上幂等时 changed=false）。
    return report(adapter, action, wasRunning, { changed: true, verified: true, verificationScope: wasRunning ? 'source-assembly-basic-health' : 'source-assembly-stopped', elapsedMs: Math.round(budget.elapsed()), ...validation, seams: result || null })
  } catch (error) {
    error.message = redactStartupLine(error.message)
    // 预算超时不放弃恢复；恢复不计入成功时间，也不作为成功返回。只有本次已走到停服/写入阶段才允许恢复。
    if (safeToRestore || stopAttempted) driver.beginRecovery?.()
    if (!safeToRestore && stopAttempted) {
      // 停止核验自身的失败不得顶掉初因。
      try { if (await driver.stoppedAfterError?.()) safeToRestore = true }
      catch (verify) { throw new AggregateError([error, verify], '维护失败且停止核验未完成；初因：' + describeError(error) + '；核验原因：' + redactStartupLine(verify.message) + '；不盲目重试') }
    }
    if (!safeToRestore) throw error
    try {
      progress('失败恢复：原装配＋本次源码前像；第三方改过的文件不回盖')
      if (newProcess) await driver.stopIfAlive(newProcess)
      else await driver.stopFailedStart?.()
      if (operationBefore) {
        await driver.restorePackage()
        if (driver.runtime?.windowsCli) await driver.assertStopped()
        // 先撤我们自己的 protect 写入（现场仍等于它的 after 才写），再按本次写前基准做有限回滚；
        // 只回滚本次写集、只在现场==本次 expected 时回写，第三方改过保留现场。
        try { /* protect 已不再隐式调用：无 undo 需要回滚 */ } catch { /* noop */ }
        if (sourceTouched) { source.restore(operationBefore, { expected }); source.syntax() }
        else progress('源码未写入：不执行源码回滚（只恢复装配与运行状态）')
      } else {
        // 失败发生在**源码基线捕获之前**（预检阶段就抛）：源码树与 profile 装配都一字未改，没有可恢复对象。
        progress('失败发生在源码基线之前：源码与装配未修改，无需恢复')
      }
      if (state?.wasRunning !== false) { const restored = await driver.start({ recovery: true }); await driver.verifyRecovery(restored) }
      else await driver.assertStopped()
    } catch (recovery) {
      throw new AggregateError([error, recovery], '维护失败且恢复未完成；初因：' + describeError(error) + '；恢复原因：' + redactStartupLine(recovery.message) + '；不盲目重试')
    }
    throw new Error('维护失败，已恢复原装配及原运行状态：' + describeError(error), { cause: error })
  }
}

/** CLI 与回归共用同一只读检查分支：证据副本可写，目标源码/profile 不写。 */
export async function checkMaintenance({ action, adapter, driver, source, evidenceDir, budget = maintenanceBudget() }) {
  const state = await driver.preflight(action)
  assertPackageSource(source, adapter, { allowRebase: action === 'install' })
  const base = { initialState: state.wasRunning ? 'running' : 'stopped', check: true, changed: false }
  if (action === 'uninstall' && source.cleanState()) {
    assertSourceUninstalled(source)
    budget.remaining()
    return { ...base, assemblyOnly: true, noop: state.noop, note: '无块、无记录：卸载只需移除装配（源码零写）', elapsedMs: Math.round(budget.elapsed()) }
  }
  const compatPlan = action === 'install' && state.noop ? adapter.inspectStandardSeamsPlan?.({ appDir: source.root }) : null
  const needsReapply = compatPlan?.needsReapply === true
  const inspection = state.noop && !needsReapply ? null : rehearseSource(action, source, adapter, evidenceDir, () => budget.remaining())
  budget.remaining()
  return { ...base, ...(needsReapply ? { needsReapply: true, repairAvailable: true, targetModified: false } : {}), ...(inspection?.result || {}), elapsedMs: Math.round(budget.elapsed()) }
}

// 失败也必须在前台 stdout 明确给出脱敏初因及结果路径，不能只留 stderr/恢复进度。
export function reportMaintenanceFailure(error, evidence, elapsedMs, output = console.log, reportDir = '') {
  const message = redactStartupLine(describeError(error)), resultFile = path.join(reportDir || evidence, 'result.json')
  writeFileSync(resultFile, JSON.stringify({ ok: false, elapsedMs, message }, null, 2) + '\n', 'utf8')
  output('维护失败：' + message)
  output('失败结果：' + resultFile)
  error.maintenanceReported = true
}
// 两层维护交接（前台/后台共用）：显式宿主路径必须一直传到实际执行器。
export function maintenanceChildArgs(entry, op, evidence, reportDir, elapsed) {
  return [entry, op.action, '--home', op.home, '--app', op.app, '--profile', op.profile,
    op.check ? '--check' : '--apply', '--internal', '--evidence', evidence, '--elapsed', String(elapsed),
    ...(op['desktop-app'] ? ['--desktop-app', op['desktop-app']] : []),
    ...(op.port ? ['--port', op.port] : []),
    ...(op['systemd-unit'] ? ['--systemd-unit', op['systemd-unit']] : []),
    ...(op['prepare-env'] ? ['--prepare-env'] : []),
    ...(op['report-dir'] ? ['--report-dir', reportDir] : [])]
}
export function runCli(url, adapter) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(url)) return
  const main = async () => {
    if (process.argv.includes('--help')) {
      console.log(`${adapter.packageName} 离线装卸（注释块机制；Windows/macOS/Linux/WSL2 CLI）\nnode deploy/maintenance.mjs install|uninstall [--home <已有安装目录>] [--desktop-app <嵌入式DSH Desktop安装根>] [--port <核对端口>] [--systemd-unit <既有单元>] [--prepare-env] [--check] [--background]\n默认apply；本地完整包不联网、不索取网页凭证、不复制依赖/存档。安装与卸载同一执行序列：预检→本次有限副本预演→精确停止→官方离线装/卸包→按块记录施缝/撤缝→本次回读→按原方式启服→验收；失败只回滚本次前像，第三方改过不回盖。\n块机制与旧机制不并存：现场存在旧记录（.tavern-seams.json/.tavern-legacy-view-seams.json/.tavern-save-ui-seam.json）或旧接缝代码但无块记录时直接拒绝，请先用旧版插件完成卸载。卸载无需旧恢复资产：无块无记录（撤净态）时只移除装配，源码零写。\nLinux/macOS运行中停止后按原方式恢复，原本停止则保持停止；Windows CLI/桌面不自动停启：请自行完整停止再装卸，成功后自行启动；运行/身份不明拒绝写入。包就绪后180秒成功预算；异常恢复独立处理。网页/真实玩法由用户确认。\nV2运行中目标须已带--experimental-vm-modules；默认不改启动配置。--prepare-env（仅install）显式授权补VM旗标（备份原unit、失败自动回滚）。四个解析依赖与acorn须离线可用，不补装宿主peer、不联网补依赖。`)
      return
    }
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) throw Error('不支持的平台：' + process.platform)
    const op = options(process.argv.slice(2)); assertTargetAllowed(op)
    // 原生 Windows 桌面与 CLI 都只维护停止态：各自验证实际宿主，绝不认领 POSIX 启停身份。
    if (process.platform === 'win32' && op.host === 'cli' && (op['systemd-unit'] || op['prepare-env'])) {
      throw Error('Windows CLI 不接管 systemd 或启动配置；请自行 dsh-tavern stop 后维护，不使用 --prepare-env')
    }
    // 每次Node交接的启动/import/目录识别也算入共享时间，不在worker入口重新从零计时。
    const budget = maintenanceBudget({ milliseconds: successBudgetMs(op.host), elapsed: Number(op.elapsed || 0) + performance.now() }), root = path.dirname(path.dirname(fileURLToPath(url))), runtime = runtimeFor(op)
    budget.remaining()
    packageFiles(root)
    const evidence = op.evidence ? path.resolve(op.evidence) : path.join(op.home, 'maintenance', adapter.packageName, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID())
    if (!evidence.startsWith(path.join(op.home, 'maintenance') + path.sep)) throw Error('维护输出不能位于业务目录')
    for (let p = evidence; p !== path.dirname(op.home); p = path.dirname(p)) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw Error('维护输出不允许符号链接')
    if (!op.internal && existsSync(evidence)) throw Error('维护输出目录须为本次新目录，不覆盖已有证据/执行器')
    mkdirSync(evidence, { recursive: true, mode: 0o700 })
    let reportDir = evidence
    if (op['report-dir']) {
      reportDir = path.resolve(op['report-dir'])
      if (!existsSync(reportDir) || !lstatSync(reportDir).isDirectory() || lstatSync(reportDir).isSymbolicLink()) throw Error('结果目录须为已存在的真实目录（不接受符号链接）：' + reportDir)
    }
    const reportFile = () => path.join(reportDir, 'result.json')
    if (!op.internal) {
      const staged = path.join(evidence, 'executor-package'); copyPackage(root, staged)
      budget.remaining()
      const args = maintenanceChildArgs(path.join(staged, 'deploy', 'maintenance.mjs'), op, evidence, reportDir, budget.elapsed())
      if (op.background) {
        // Windows 上 detached:true 的语义是"新控制台窗口"：必须显式隐藏，否则会弹出一串命令行窗口。
        const fd = openSync(path.join(evidence, 'job.log'), 'wx', 0o600), child = spawn(process.execPath, args, { cwd: op.app, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); closeSync(fd)
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); child.unref()
        console.log('维护已后台启动；PID=' + child.pid + '；结果=' + reportFile()); return
      }
      // 默认等待同一独立作业结果：Ctrl-C 或终端断开不会中断恢复，且用户能看到进度。
      const child = spawn(process.execPath, args, { cwd: op.app, detached: true, windowsHide: true, stdio: 'inherit' })
      const detach = () => { child.unref(); console.error('终端中断；维护/恢复继续。结果：' + reportFile()); process.exit(130) }
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
        writeFileSync(reportFile(), JSON.stringify({ ok: true, network: 'offline', ...result }, null, 2) + '\n', 'utf8')
        console.log(JSON.stringify({ ok: true, network: 'offline', ...result }))
        console.log('结果：' + reportFile())
      } catch (error) {
        reportMaintenanceFailure(error, evidence, Math.round(budget.elapsed()), console.log, reportDir)
        throw error
      }
    }, { waitMs: 0 })
  }
  main().catch(error => { if (!error.maintenanceReported) console.log('维护失败：' + redactStartupLine(describeError(error))); process.exitCode = 1 })
}
