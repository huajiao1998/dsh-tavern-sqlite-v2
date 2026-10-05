// 目标profile原地离线装卸；保留原运行状态，无认证、无依赖树副本。
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import { command, findProcess, readProcess, sameProcess, stripSecrets, waitExit, processAlive } from './process.mjs'
import { pause, maintenanceBudget } from './budget.mjs'
import { runtimeFor, packagePolicyArgs, assertTargetAllowed } from './target.mjs'
import { parseSystemdProperties, systemdOwner, assertSystemdTarget, assertSystemdUnchanged } from './systemd.mjs'
import { waitSystemdExecIdentity } from './start-identity.mjs'
import { STANDARD_RECORD } from './source.mjs'
import { AUTHOR_VERSION } from '../../lib/standard-host.js'
const family = ['dsh-tavern-storage-sqlite', 'dsh-tavern-storage-sqlite-v1', 'dsh-tavern-storage-sqlite-v2', 'dsh-tavern-sqlite-v1', 'dsh-tavern-sqlite-v2']
// V2精确允许的四个解析器依赖：分别是本行唯一允许的第三方依赖，未知一律拒绝，不放宽依赖政策。
const PARSER_DEPENDENCIES = ['json5', 'jsonrepair', 'lodash', 'yaml']
const json = p => JSON.parse(readFileSync(p, 'utf8'))
const profileState = dir => { const data = json(path.join(dir, 'package.json')); return { data, deps: data.dependencies || {}, bundles: data.dsh?.profile?.bundles || [] } }
export async function packageCommand(exe, args, { cwd, env, timeout = 20000 } = {}) {
  const child = spawn(exe, args, { cwd, env, detached: process.platform !== 'win32', stdio: 'inherit' })
  let timer, force, timedOut = false
  const signal = name => { try { if (process.platform === 'win32') child.kill(name); else process.kill(-child.pid, name) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  await new Promise((resolve, reject) => {
    child.once('spawn', () => { timer = setTimeout(() => { timedOut = true; signal('SIGTERM'); force = setTimeout(() => signal('SIGKILL'), 500) }, timeout) })
    child.once('error', error => { clearTimeout(timer); clearTimeout(force); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer); clearTimeout(force)
      if (timedOut) { signal('SIGKILL'); reject(Error('官方离线包管理超时；本次进程组已终止，进入恢复')) }
      else if (code !== 0) reject(Error('官方离线包管理失败：' + code + '；不自动联网或关闭供应链策略'))
      else resolve()
    })
  })
}
export function tcpOpen(port, host, timeout = 250) {
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host }), finish = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(timeout); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.once('timeout', () => finish(false))
  })
}
function properties(unit, timeout, runCommand = command) { return parseSystemdProperties(runCommand('systemctl', ['show', unit, ...['MainPID', 'Type', 'KillMode', 'ExecStart', 'WorkingDirectory', 'FragmentPath', 'Restart', 'ActiveState'].flatMap(key => ['-p', key])], { timeout })) }
export function basicHttpStatus(response) {
  return [200, 302, 303, 401, 403].includes(response.status)
}
// 启动方式判据：不改unit、不改NODE_OPTIONS；安装需要既有--experimental-vm-modules，其余动作不要求旗标。
export function assertLaunchMode(action, adapter, argv) {
  if (action !== 'install' || !adapter.requiresVmModules) return { required: false }
  if (!argv) throw Error('既有启动命令不可确证，拒绝在猜测旗标下安装')
  if (!argv.includes('--experimental-vm-modules')) throw Error('V2需要既有Node --experimental-vm-modules；不静默改启动命令')
  return { required: true }
}
export function createDriver(op, adapter, packageRoot, evidence, budget, { processFinder = findProcess, processReader = readProcess, runPackage = packageCommand, request = fetch, runtimeResolver = runtimeFor, runCommand = command, portOpen = tcpOpen, alive = processAlive } = {}) {
  const runtime = runtimeResolver(op), context = { ...op, ...runtime }, installed = path.join(op.profileDir, 'node_modules', adapter.packageName)
  let original, prior, unit, latest, stopSignalled = false, launch = 0, recovery = false, activeBudget = budget
  let originalDependencyBytes
  const env = { ...stripSecrets(process.env), DSH_HOME: op.home, DSH_TAVERN_CLI_HOME: op.home, pnpm_config_update_notifier: 'false', npm_config_offline: 'true', pnpm_config_offline: 'true' }
  const inspectUnit = () => properties(unit?.unit || op['systemd-unit'], activeBudget.remaining(2000), runCommand)
  const assertAssembly = action => {
    const state = profileState(op.profileDir), present = !!state.deps[adapter.packageName] && state.bundles.includes(adapter.packageName) && existsSync(installed)
    const other = deps => Object.fromEntries(Object.entries(deps).filter(([key]) => key !== adapter.packageName).sort(([a], [b]) => a.localeCompare(b)))
    if (JSON.stringify(other(state.deps)) !== JSON.stringify(other(prior.deps)) || JSON.stringify(state.bundles.filter(s => s !== adapter.packageName)) !== JSON.stringify(prior.bundles.filter(s => s !== adapter.packageName))) throw Error('装卸改变非目标依赖/bundle，拒绝成功')
    for(const [file,bytes]of Object.entries(originalDependencyBytes||{}))if(bytes&&(!existsSync(file)||!readFileSync(file).equals(bytes)))throw Error('官方操作改变既有非目标软件包，拒绝冒认单包安装成功')
    if (present !== (action === 'install')) throw Error('目标依赖/bundle/链接回读不一致')
    if (action === 'uninstall' && (state.deps[adapter.packageName] || state.bundles.includes(adapter.packageName) || existsSync(installed))) throw Error('卸载仍有装配残留')
    return state
  }
  async function manage(action, root = packageRoot) {
    await driver.assertStopped()
    await runPackage(original?.argv[0] || process.execPath, [runtime.cli, 'plugin', '--profile', op.profile, ...(action === 'install' ? ['add', 'file:' + root] : ['remove', adapter.packageName]), ...packagePolicyArgs()], { cwd: op.app, env, timeout: activeBudget.remaining(18000) })
    assertAssembly(action)
    if(action==='install'){
      const {samePackage}=await import('./runner.mjs')
      if(!samePackage(root,realpathSync(installed)))throw Error('官方安装后包字节不是选定本地代，拒绝成功')
    }
  }
  const driver = {
    runtime,
    async preflight(action) {
      assertTargetAllowed(op)
      const pkg = json(path.join(packageRoot, 'package.json'))
      if (pkg.name !== adapter.packageName) throw Error('维护入口与本地包身份不一致')
      // V2只允许精确四个解析器依赖；未知依赖一律拒绝，不放宽供应链政策。
      const declared = Object.keys(pkg.dependencies || {}).sort()
      if (JSON.stringify(declared) !== JSON.stringify([...PARSER_DEPENDENCIES].sort())) throw Error('V2依赖须精确为json5/jsonrepair/lodash/yaml；未知依赖拒绝安装')
      for(const peer of Object.keys(pkg.peerDependencies||{})){
        const manifest=path.join(op.home,'runtime','lib','node_modules',...peer.split('/'),'package.json')
        if(!existsSync(manifest)||json(manifest).version!=='0.1.5-rc.2')throw Error('既有宿主peer缺失/未适配：'+peer+'；不自动安装第二份宿主')
      }
      prior = profileState(op.profileDir)
      // 只留已有直接依赖的软件清单字节，不备份依赖目录；事后检查未升级其它包。
      originalDependencyBytes=Object.fromEntries(Object.keys(prior.deps).filter(name=>name!==adapter.packageName).map(name=>{const p=path.join(op.profileDir,'node_modules',...name.split('/'),'package.json');return [p,existsSync(p)?readFileSync(p):null]}))
      // family含旧三线与新v1/v2：写前阻止旧线/新线共装。
      for (const name of family) if (name !== adapter.packageName && (prior.deps[name] || prior.bundles.includes(name))) throw Error('另一版本线已安装，先用所属包卸载')
      const author = json(path.join(op.app, 'tavern-plugin', 'package.json'))
      if (author.name !== 'dsh-tavern-plugin' || author.version !== AUTHOR_VERSION) throw Error('作者版本未适配')
      const patch = readFileSync(path.join(op.profileDir, 'cordis.patch.yml'), 'utf8').replace(/^\s*#.*$/gm, '').trim()
      if (patch !== '[]' && patch !== '') throw Error('profile自定义patch非空，请先核冲突；不覆盖用户配置')
      original = processFinder(context)
      if (original) {
        assertTargetAllowed({ ...op, port: original.port })
        env.PATH = original.env.PATH
        // running：直接用准确original.argv核启动方式，不改unit/NODE_OPTIONS。
        assertLaunchMode(action, adapter, original.argv)
        // 使用酒馆原进程的Node做无数据的能力探测。
        const cgroupOwner = systemdOwner(original.cgroup || '')
        if (op['systemd-unit'] || cgroupOwner) {
          if (op['systemd-unit'] && cgroupOwner !== op['systemd-unit']) throw Error('指定systemd单元不拥有目标进程')
          unit = { unit: op['systemd-unit'] || cgroupOwner }
          unit = assertSystemdTarget({ unit: unit.unit, properties: inspectUnit(), cgroup: original.cgroup, identity: original })
        }
      } else if (op['systemd-unit']) {
        const state = inspectUnit()
        if (Number(state.MainPID) !== 0 || state.ActiveState !== 'inactive') throw Error('systemd不是明确停止态；拒绝伪装停止安装')
        unit = Object.freeze({ unit: op['systemd-unit'], argv: /argv\[\]=([^;]+) ;/.exec(state.ExecStart || '')?.[1]?.trim(), cwd: state.WorkingDirectory, fragment: state.FragmentPath, type: state.Type, killMode: state.KillMode, restart: state.Restart })
        if (unit.cwd !== op.app || !unit.argv?.includes(runtime.cli) || !unit.argv.includes('--profile ' + op.profile + ' ') || unit.type !== 'simple' || unit.killMode !== 'control-group') throw Error('停止态systemd单元目标不符')
        // stopped+systemd：从unit.argv拆词取准确启动命令，不改unit/NODE_OPTIONS。
        assertLaunchMode(action, adapter, unit.argv ? unit.argv.split(/\s+/).filter(Boolean) : null)
      }
      // 纯停止态没有待恢复启动命令：不改任何启动配置，安装后仍停止；将来启动仍须带VM旗标。
      // capability probe由原进程Node保持flag加入vm.SourceTextModule检测；--uninstall不要求该能力。
      const probe = action === 'install'
        ? "import vm from 'node:vm';import {DatabaseSync} from 'node:sqlite';import {zstdDecompressSync} from 'node:zlib';if(typeof vm.SourceTextModule!=='function')throw Error('缺少vm.SourceTextModule');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE probe(k INTEGER PRIMARY KEY) STRICT');db.close();if(typeof zstdDecompressSync!=='function')throw Error('缺少zstd')"
        : "import {DatabaseSync} from 'node:sqlite';import {zstdDecompressSync} from 'node:zlib';const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE probe(k INTEGER PRIMARY KEY) STRICT');db.close();if(typeof zstdDecompressSync!=='function')throw Error('缺少zstd')"
      await runPackage(original?.argv[0] || process.execPath, [...(action === 'install' && adapter.requiresVmModules ? ['--experimental-vm-modules'] : []), '--input-type=module', '-e', probe], { cwd: op.app, env, timeout: activeBudget.remaining(2500) })
      await runPackage('pnpm', ['--version'], { cwd: op.app, env, timeout: activeBudget.remaining(2500) })
      const present = !!prior.deps[adapter.packageName]
      if (present !== prior.bundles.includes(adapter.packageName) || present !== existsSync(installed)) throw Error('目标装配不完整，拒绝猜测')
      if (present) {
        if (json(path.join(installed, 'package.json')).name !== adapter.packageName) throw Error('现装包身份错误')
        const { copyPackage, samePackage } = await import('./runner.mjs')
        driver.recoveryPackage = samePackage(packageRoot, realpathSync(installed)) ? packageRoot : path.join(evidence, 'original-package')
        if (driver.recoveryPackage !== packageRoot) copyPackage(realpathSync(installed), driver.recoveryPackage)
        if (action === 'install' && driver.recoveryPackage !== packageRoot) throw Error('现装不同代；先用本地所属代卸载，不自动升级')
        if (!existsSync(path.join(op.app, STANDARD_RECORD))) throw Error('已装包但缺源码恢复记录')
      } else if (existsSync(path.join(op.app, STANDARD_RECORD))) throw Error('包不在但接缝在，拒绝认领')
      driver.wasRunning = !!original
      if (original) { context.port = original.port; context.host = original.host }
      // 不运行官方--dump-config，避免构造Host或自动扫描原档。
      return { noop: action === 'install' ? present : !present, wasRunning: !!original }
    },
    async assertIdentity() {
      const current = processFinder(context)
      if (original) sameProcess(original, current)
      else if (current) throw Error('停止态目标被其它操作启动，写前拒绝')
      if (unit) assertSystemdUnchanged(unit, inspectUnit())
    },
    async assertStopped() {
      if (processFinder(context)) throw Error('目标仍运行，拒绝修改包/源码')
      if (original && (await portOpen(original.port, ['::', '::1'].includes(original.host) ? '::1' : '127.0.0.1', activeBudget.remaining(250)))) throw Error('原监听端口仍被占用，拒绝写入/并起；不杀占用进程')
      if (unit) { const state = inspectUnit(); assertSystemdUnchanged(unit, state); if (Number(state.MainPID) || state.ActiveState !== 'inactive') throw Error('systemd未完全停止') }
    },
    async stop(target = original) {
      sameProcess(target, processReader(target.pid, context))
      if (unit) {
        const state = inspectUnit(); assertSystemdUnchanged(unit, state)
        if (Number(state.MainPID) !== target.pid) throw Error('systemd主PID已变化')
        stopSignalled = true
        runCommand('systemctl', ['stop', unit.unit], { timeout: activeBudget.remaining(7000) })
        await driver.assertStopped()
      } else {
        process.kill(target.pid, 'SIGTERM'); stopSignalled = true
        await waitExit(target, context, activeBudget.remaining(7000))
      }
    },
    async stoppedAfterError() {
      if (!stopSignalled) return false
      const until=Date.now()+activeBudget.remaining(7000)
      while(Date.now()<until){
        const item=processReader(original.pid,context)
        if(!item){if(alive(original.pid))throw Error('原PID仍活着但身份不符，不能冒认为停止');await driver.assertStopped();return true}
        sameProcess(original,item);await pause(50)
      }
      throw Error('原代停止未完成，未写装配/源码，不并起第二进程')
    },
    async stopIfAlive(target) {
      if (!latest && !target) return
      if (unit) {
        const state = inspectUnit(); assertSystemdUnchanged(unit, state)
        if (Number(state.MainPID)) {
          const item = processReader(Number(state.MainPID), context)
          if (!item || (latest && item.pid !== latest.pid) || (target && item.pid !== target.pid)) throw Error('恢复时systemd换PID，不追逐替代进程')
          if(target?.start)sameProcess(target,item)
          if(latest?.start)sameProcess(latest,item)
          if(JSON.stringify(item.argv)!==JSON.stringify(original.argv))throw Error('systemd恢复进程argv漂移')
          await driver.stop(item)
        } else runCommand('systemctl', ['stop', unit.unit], { timeout: activeBudget.remaining(7000) })
      } else if(target){
        const item=processReader(target.pid,context)
        if(!item){if(alive(target.pid))throw Error('本次新PID仍活着但身份不符，不改它正在使用的源码');return}
        if(target.start)sameProcess(target,item)
        else if(JSON.stringify(target.argv)!==JSON.stringify(item.argv)||target.cwd!==item.cwd)throw Error('未就绪新进程身份不符，拒绝停止')
        await driver.stop(item)
      }
    },
    async stopFailedStart() {
      if (!latest && unit) {
        const state=inspectUnit();assertSystemdUnchanged(unit,state)
        if (Number(state.MainPID)) { const item=processReader(Number(state.MainPID),context);if(!item)throw Error('恢复时管理器进程身份不明，保留源码不猜停止');latest=item }
      }
      await driver.stopIfAlive(latest)
    },
    manage,
    async restorePackage() {
      if (prior.deps[adapter.packageName]) await manage('install', driver.recoveryPackage || packageRoot)
      else if (profileState(op.profileDir).deps[adapter.packageName] || existsSync(installed)) await manage('uninstall')
      else assertAssembly('uninstall')
    },
    beginRecovery() { recovery = true; activeBudget = maintenanceBudget({ milliseconds: 90000 }) },
    async start() {
      if (!original) throw Error('目标原本停止，禁止拉起')
      await driver.assertStopped()
      if (unit) {
        runCommand('systemctl', ['start', unit.unit], { timeout: activeBudget.remaining(5000) })
        const pid = Number(inspectUnit().MainPID)
        if (!pid) throw Error('systemd未取得MainPID')
        latest = { ...original, pid, start: undefined }
        const item = await waitSystemdExecIdentity({ pid, budgetMs: activeBudget.remaining(3000), currentPid: () => { const s = inspectUnit(); assertSystemdUnchanged(unit, s); return s.MainPID }, probe: p => {
          const value = processReader(p, context)
          if (value && JSON.stringify(value.argv) !== JSON.stringify(original.argv)) throw Error('systemd启动参数漂移')
          return value
        } })
        latest = item
      } else {
        launch++
        const log = path.join(evidence, 'startup-' + launch + '.log')
        const sink = spawn(original.argv[0], [fileURLToPath(new URL('./startup-log.mjs', import.meta.url)), log, String(original.port)], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
        await new Promise((resolve, reject) => { sink.once('spawn', resolve); sink.once('error', reject) })
        const child = spawn(original.argv[0], original.argv.slice(1), { cwd: original.cwd, env: stripSecrets(original.env), detached: true, stdio: ['ignore', sink.stdin, sink.stdin] })
        try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }) }
        catch (error) { sink.stdin.destroy(); sink.kill(); throw error }
        latest = { ...original, pid: child.pid, start: undefined, log }
        child.unref(); sink.stdin.destroy(); sink.unref()
        const until = Date.now() + activeBudget.remaining(2500)
        while (Date.now() < until) {
          const item = processReader(child.pid, context)
          if (item) { latest = { ...item, log }; break }
          await pause(25)
        }
        if (!latest.start) throw Error('新进程身份未就绪')
      }
      return latest
    },
    async verify(action, _adapter, { process: item, existing = false } = {}) {
      assertAssembly(action)
      if (action === 'install' && !adapter.checkStandardSeams({ appDir: op.app }).ready) throw Error('完整源码接缝未ready')
      if (!original) { await driver.assertStopped(); return { runtimeVerified: false, state: 'stopped' } }
      const target = item || original, connectHost = ['::', '::1'].includes(target.host) ? '[::1]' : '127.0.0.1'
      while (true) {
        activeBudget.remaining()
        sameProcess(target, processReader(target.pid, context))
        if (unit) { const state = inspectUnit(); assertSystemdUnchanged(unit, state); if (Number(state.MainPID) !== target.pid) throw Error('systemd主PID变化') }
        if (target.log && existsSync(target.log) && /(?:Error:|failed to load|failed startup|旧档迁移完成|后台恢复历史对话失败)/.test(readFileSync(target.log, 'utf8'))) throw Error('本次启动出现错误/自动历史恢复')
        const response = await request(`http://${connectHost}:${target.port}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(activeBudget.remaining(750)) }).catch(() => null)
        if (response) { await response.body?.cancel(); if (basicHttpStatus(response)) break }
        if (existing) throw Error('现行HTTP不可达')
        await pause(Math.min(100, activeBudget.remaining()))
      }
      if (!recovery) budget.remaining()
      return { runtimeVerified: false, basicHealthVerified: true, state: 'running', webVerification: '待用户在已登录页面确认；未认证插件库存，不冒称功能验收' }
    },
    async verifyRecovery(target) { return driver.verify(prior.deps[adapter.packageName] ? 'install' : 'uninstall', adapter, { process: target }) },
  }
  return driver
}
