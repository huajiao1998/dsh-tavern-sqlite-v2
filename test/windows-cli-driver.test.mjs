// WinCLI（原生 Windows CLI）停止态驱动回归：5 条新断言，全合成夹具，不接触实机/真实 SDK/存档，
// 不启真实进程、不跑真实能力探针或包管理（presence/runPackage 全为 fake），不联网、不递归。
// 2026-10-07：createWindowsCliDriver 与旧 createDesktopDriver 同签名
//   (op, adapter, packageRoot, evidence, budget, { runtime, presence, runPackage, logger })
// runtime.windowsCli = { root: home/runtime, appDir: home/runtime, peerRoot: home/runtime/node_modules, cliEntry }
// 只跑本文件：node tools/run-plugin-gate.mjs --file test/windows-cli-driver.test.mjs --pattern 'WinCLI driver:'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { createWindowsCliDriver, createDriver } from '../deploy/maintenance/driver.mjs'
import { copyPackage } from '../deploy/maintenance/runner.mjs'
import { windowsCliTavernProcesses } from '../deploy/maintenance/process.mjs'
import { maintenanceBudget } from '../deploy/maintenance/budget.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'

const product = fileURLToPath(new URL('../', import.meta.url))
const peers = Object.keys(JSON.parse(readFileSync(path.join(product, 'package.json'), 'utf8')).peerDependencies)
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe'
const linkValue = value => 'link:' + value.split(path.sep).join('/')
// 合成 adapter：只把"源码接缝就绪"换成可切换的断言，其余字段逐字沿用真实维护适配器（不造作者源码）。
const seams = ready => ({ ...adapter, checkStandardSeams: () => ({ ready }) })
const read = file => readFileSync(file)
// 运行中：真实归属函数 + 注入的只读进程清单（不查真机进程表）。
const runningPresence = context => windowsCliTavernProcesses(context, { list: () => [{ pid: 4321, exe: NODE_EXE, argv: 'node "' + context.windowsCli.cliEntry + '" --profile tavern' }] })
// 合法非空 profile 用户层覆盖（与酒馆/本插件无关，无秘密）：旧预检按"非空"拒绝维护；新契约只要求维护不改写它。
// 生效行形状取自真实 patch 行列表（注释行会被剥掉，故必须留非注释行，才是真正的回归输入）。
const USER_PATCH = [
  '# 用户自有覆盖：与酒馆/本插件无关；维护不得改写或删除',
  '- id: user-local-preference',
  '  disabled: false',
  ''
].join('\n')
/** 目录字节快照（文件内容 + 链接字面目标）：证明源码/SDK/装配零改。 */
function image(root) {
  const out = {}
  const walk = rel => {
    for (const item of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const next = rel ? rel + '/' + item.name : item.name
      if (item.isSymbolicLink()) out[next] = 'link:' + readlinkSync(path.join(root, next))
      else if (item.isDirectory()) walk(next)
      else out[next] = readFileSync(path.join(root, next)).toString('base64')
    }
  }
  if (existsSync(root)) walk('')
  return out
}
function fixture(t, { installed = 'none', withPeers = true, presence = () => [], runPackage } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'v2-wincli-driver-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-wincli-driver-')); rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), app = path.join(home, 'apps', 'dsh-tavern'), profileDir = path.join(home, 'profiles', 'tavern')
  const evidence = path.join(home, 'maintenance', adapter.packageName, 'wincli-1')
  const runtimeRoot = path.join(home, 'runtime'), peerRoot = path.join(runtimeRoot, 'node_modules')
  const cliEntry = path.join(peerRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(profileDir, { recursive: true }); mkdirSync(evidence, { recursive: true }); mkdirSync(runtimeRoot, { recursive: true })
  // 作者树只有 package（接缝就绪由合成 adapter 断言；不从零造作者源码）
  mkdirSync(path.join(app, 'tavern-plugin'), { recursive: true })
  writeFileSync(path.join(app, 'tavern-plugin', 'package.json'), JSON.stringify({ name: 'dsh-tavern-plugin', version: AUTHOR_VERSION }) + '\n', 'utf8')
  // 合成私有 SDK：宿主 peer 清单 + 哨兵字节；cliEntry 只是假入口字符串，永不执行
  if (withPeers) for (const peer of peers) {
    const dir = path.join(peerRoot, ...peer.split('/')); mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: peer, version: '0.1.5-rc.2' }) + '\n', 'utf8')
    writeFileSync(path.join(dir, 'index.js'), '// 合成 SDK 哨兵 ' + peer + '\n', 'utf8')
  }
  const installedDir = path.join(profileDir, 'node_modules', adapter.packageName)
  const profile = { name: 'dsh-profile-tavern', dependencies: { keep: '1' }, dsh: { profile: { bundles: ['keep'] } }, settings: { preserve: true } }
  if (installed === 'noop') { // 现装本代 + 源码干净态（新机制无旧记录；无块无记录即 withdrawnClean）⇒ 幂等路径
    copyPackage(product, installedDir)
    profile.dependencies[adapter.packageName] = linkValue(installedDir)
    profile.dsh.profile.bundles.push(adapter.packageName)
  } else if (installed === 'generation') { // 旧安装代：字节与待装包不同 ⇒ 预检抓恢复材料
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(path.join(installedDir, 'package.json'), JSON.stringify({ name: adapter.packageName, version: '0.2.2', files: ['package.json', 'marker.txt'] }, null, 2) + '\n', 'utf8')
    writeFileSync(path.join(installedDir, 'marker.txt'), '合成旧安装代\n', 'utf8')
    profile.dependencies[adapter.packageName] = linkValue(installedDir)
    profile.dsh.profile.bundles.push(adapter.packageName)
  } else if (installed === 'broken') { // 坏旧包：只有 manifest，无 vendor/lib，bundle 项缺失
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(path.join(installedDir, 'package.json'), JSON.stringify({ name: adapter.packageName, version: '0.2.2' }) + '\n', 'utf8')
    profile.dependencies[adapter.packageName] = 'file:old-broken'
  }
  const profileFile = path.join(profileDir, 'package.json')
  const profileBytes = Buffer.from(JSON.stringify(profile, null, 2) + '\n', 'utf8')
  writeFileSync(profileFile, profileBytes)
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  const runtime = { windowsCli: { root: runtimeRoot, appDir: runtimeRoot, peerRoot, cliEntry } }
  // 冻结包源：WinCLI 装包路径逐字比较「选定本地代 ↔ 链接后包字节」（driver L441）。若夹具直接用工作区
  // 实时树，全量并行时其他测试对该树的写会落在 copy 与比较之间造成竞态；此处在夹具内复制一份作为唯一包源。
  const packageRoot = path.join(root, 'product')
  copyPackage(product, packageRoot)
  const probes = [], warnings = []
  const capture = runPackage || (async (exe, args, options) => { probes.push({ exe, args, options }); return '' })
  const make = ({ adapter: chosen = seams(true), presence: find = presence, evidence: dir = evidence, check = false } = {}) => createWindowsCliDriver(
    { home, app, profile: 'tavern', profileDir, host: 'cli', action: 'install', check },
    chosen, packageRoot, dir, maintenanceBudget({ milliseconds: 120000 }),
    { runtime, presence: find, runPackage: capture, logger: { warn: (...args) => warnings.push(args.join(' ')) } })
  return { root, home, app, profileDir, profileFile, profileBytes, evidence, runtimeRoot, peerRoot, cliEntry, installedDir, probes, warnings, make }
}

test('WinCLI verify: 最后验收重核停止，维护中用户重启不伪报stopped', async t => {
  const f = fixture(t)
  let items = []
  const driver = f.make({ presence: () => items })
  await driver.preflight('uninstall', { residual: true })
  const before = read(f.profileFile)
  assert.equal((await driver.verify('uninstall')).state, 'stopped')
  items = [{ pid: 71 }]
  await assert.rejects(driver.verify('uninstall'), /正在运行/)
  assert.deepEqual(read(f.profileFile), before)
  assert.deepEqual(f.probes, [])
})

test('WinCLI parents: plugins父junction越界在进程查询及任何写入前拒绝', async t => {
  const f = fixture(t), foreign = path.join(f.root, '外部目录'), parent = path.join(f.home, 'plugins')
  mkdirSync(foreign, { recursive: true })
  const sentinel = path.join(foreign, '别的用户文件.txt')
  writeFileSync(sentinel, '不可改', 'utf8')
  symlinkSync(foreign, parent, process.platform === 'win32' ? 'junction' : 'dir')
  const before = read(f.profileFile)
  const driver = f.make({ presence: () => { throw Error('父链接拒绝必须在查询前') } })
  await assert.rejects(driver.manage('install'), /装配父目录为链接/)
  assert.deepEqual(read(f.profileFile), before)
  assert.equal(read(sentinel).toString('utf8'), '不可改')
  assert.deepEqual(f.probes, [])
})

test('WinCLI factory: 公共入口选择CLI停态驱动而不冒认Desktop或落入POSIX', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t)
  const runtime = { windowsCli: { root: f.runtimeRoot, appDir: f.runtimeRoot, peerRoot: f.peerRoot, cliEntry: f.cliEntry } }
  const driver = createDriver({ home: f.home, app: f.app, profileDir: f.profileDir, profile: 'tavern', host: 'cli' },
    seams(true), product, f.evidence, maintenanceBudget(), { runtimeResolver: () => runtime })
  assert.equal(driver.host, 'cli')
  assert.equal(driver.runtime, runtime)
  assert.equal(typeof driver.manageResidual, 'function')
  assert.equal(driver.original, undefined)
  assert.deepEqual(f.probes, [], '构造不运行能力探针或进程枚举')
})

test('WinCLI driver: 目标运行或身份不明时写前拒绝，check 如实 running，不进 stop/start', async t => {
  const f = fixture(t, { installed: 'noop', presence: runningPresence })
  const driver = f.make({ check: true })
  await assert.rejects(f.make().preflight('install'), /正在运行/, 'apply须连幂等路径也拒绝运行中写入')
  const appBefore = image(f.app), profileBefore = read(f.profileFile)
  assert.equal(driver.host, 'cli', 'WinCLI 驱动不得冒认桌面宿主')
  const state = await driver.preflight('install') // check 分支：只读预检，允许开着酒馆
  assert.equal(state.runningNow, true, 'check 必须如实报 running，不当停止态')
  assert.equal(state.host, 'cli')
  assert.equal(state.noop, false, '新机制：源码干净态（withdrawnClean）按首装重建，不再判 noop')
  assert.equal(state.withdrawnClean, true, '无旧记录无块 ⇒ withdrawnClean')
  await assert.rejects(driver.assertIdentity(), /正在运行/, '运行中写前必须拒绝（含 noop 路径）')
  assert.deepEqual(image(f.app), appBefore); assert.deepEqual(read(f.profileFile), profileBefore)
  assert.equal(existsSync(path.join(f.home, 'plugins', adapter.packageName)), false, '拒绝时不得写私有包目录')
  assert.equal((await driver.stop()).changed, false, 'WinCLI 不代停')
  assert.ok(await driver.start() == null, 'WinCLI 不代启')
  const unknown = fixture(t, { presence: () => { throw Error('CIM 查询失败') } })
  const unknownDriver = unknown.make(), unknownProfile = read(unknown.profileFile)
  await assert.rejects(unknownDriver.preflight('install'), /CIM 查询失败/, '身份不明必须 fail closed，不得当停止态')
  await assert.rejects(unknownDriver.assertIdentity(), /CIM 查询失败/)
  assert.deepEqual(read(unknown.profileFile), unknownProfile)
  assert.equal(existsSync(path.join(unknown.home, 'plugins', adapter.packageName)), false)
  assert.equal(unknown.probes.length, 0, '查询失败须在探针/包管理之前就拒绝')
})

test('WinCLI driver: 装卸不动原依赖/bundle与SDK源码，本包junction与宿主peer同物理且不投影profile农场', async t => {
  const f = fixture(t)
  const driver = f.make()
  const appBefore = image(f.app), sdkBefore = image(f.runtimeRoot)
  const state = await driver.preflight('install')
  assert.equal(state.noop, false); assert.equal(state.runningNow, false)
  await driver.manage('install')
  const installDir = path.join(f.home, 'plugins', adapter.packageName), junction = path.join(f.profileDir, 'node_modules', adapter.packageName)
  const profile = JSON.parse(read(f.profileFile).toString('utf8'))
  assert.equal(profile.dependencies.keep, '1', '非目标依赖必须原样')
  assert.equal(profile.dependencies[adapter.packageName], linkValue(installDir))
  assert.deepEqual(profile.dsh.profile.bundles, ['keep', adapter.packageName])
  assert.deepEqual(profile.settings, { preserve: true })
  assert.ok(lstatSync(junction).isSymbolicLink(), '本包必须以 junction 挂进 profile')
  assert.equal(realpathSync(junction), realpathSync(installDir))
  assert.deepEqual(read(path.join(junction, 'package.json')), read(path.join(product, 'package.json')), '装配字节＝选定本地代')
  for (const peer of peers) {
    const leaf = path.join(installDir, 'node_modules', ...peer.split('/'))
    assert.ok(lstatSync(leaf).isSymbolicLink(), '宿主 peer 必须链接，不复制第二份：' + peer)
    assert.equal(realpathSync(leaf), realpathSync(path.join(f.peerRoot, ...peer.split('/'))), 'peer 必须指向同一物理 SDK：' + peer)
  }
  assert.equal(existsSync(path.join(f.profileDir, '.dsh-module-fallback')), false, 'WinCLI 不投影全 profile 农场')
  assert.deepEqual(image(f.app), appBefore, '装卸不得改作者/SDK 源码')
  assert.deepEqual(image(f.runtimeRoot), sdkBefore)
  const verified = await driver.verify('install', seams(true), {})
  assert.equal(verified.host, 'cli'); assert.equal(verified.state, 'stopped'); assert.equal(verified.runtimeVerified, false)
  await driver.manage('uninstall')
  const after = JSON.parse(read(f.profileFile).toString('utf8'))
  assert.deepEqual(after.dependencies, { keep: '1' }); assert.deepEqual(after.dsh.profile.bundles, ['keep'])
  assert.deepEqual(after.settings, { preserve: true })
  assert.equal(existsSync(junction), false); assert.equal(existsSync(installDir), false)
  assert.deepEqual(image(f.app), appBefore); assert.deepEqual(image(f.runtimeRoot), sdkBefore)
})

test('WinCLI driver: 合法非空profile覆盖不再拒绝预检，install/uninstall真实链逐字保留该文件', async t => {
  const f = fixture(t)
  const patchFile = path.join(f.profileDir, 'cordis.patch.yml')
  writeFileSync(patchFile, USER_PATCH, 'utf8')
  const patchBytes = read(patchFile)
  const driver = f.make()
  const installState = await driver.preflight('install') // 旧实现：非空 patch 在此抛"profile自定义patch非空"
  assert.equal(installState.noop, false)
  assert.ok(f.probes.length >= 2, '预检仍走既有能力探针调用路径（外部执行沿用桩），未被新分支短路')
  await driver.manage('install')
  assert.deepEqual(read(patchFile), patchBytes, '安装真实链不得改写用户层 patch')
  const uninstallState = await driver.preflight('uninstall')
  assert.equal(uninstallState.noop, false)
  await driver.manage('uninstall')
  assert.deepEqual(read(patchFile), patchBytes, '卸载真实链不得改写/删除用户层 patch')
  assert.deepEqual(JSON.parse(read(f.profileFile).toString('utf8')).dsh.profile.bundles, ['keep'], '目标 bundle 撤净（沿用原装配语义）')
  // 停态护栏沿用：同一非空覆盖现场下，运行中写前仍拒绝（未被新逻辑旁路）。
  await assert.rejects(f.make({ presence: runningPresence }).preflight('install'), /正在运行/)
  assert.deepEqual(read(patchFile), patchBytes)
})

test('WinCLI driver: 工厂路由只认注入的目标平台，不静默回退POSIX', t => {
  // 只构造驱动读 descriptor/host，不做 preflight/manage（createDriver 不转发 presence，WinCLI 预检会查真实进程表）。
  const f = fixture(t)
  const op = { home: f.home, app: f.app, profile: 'tavern', profileDir: f.profileDir, host: 'cli', action: 'install' }
  const winRuntime = { windowsCli: { root: f.runtimeRoot, appDir: f.runtimeRoot, peerRoot: f.peerRoot, cliEntry: f.cliEntry } }
  const posixRuntime = { cli: path.join(f.home, 'runtime', 'bin', 'dsh'), cliEntries: [] }
  const base = { processFinder: () => null, runPackage: async () => '', runCommand: () => '' }
  const budget = () => maintenanceBudget({ milliseconds: 120000 })
  // ① 显式 win32（不论宿主）：走 WinCLI；缺 windowsCli 描述符时按强护栏抛错——绝不回退 POSIX
  assert.throws(() => createDriver(op, seams(true), product, f.evidence, budget(), { ...base, platform: 'win32', runtimeResolver: () => posixRuntime }), /运行时描述缺失/)
  const win = createDriver(op, seams(true), product, f.evidence, budget(), { ...base, platform: 'win32', runtimeResolver: () => winRuntime })
  assert.equal(win.host, 'cli', '显式 win32 必须走 WinCLI 驱动')
  // ② 显式 linux：POSIX 夹具可正常构造（不需要 windowsCli 描述符）
  const posix = createDriver(op, seams(true), product, f.evidence, budget(), { ...base, platform: 'linux', runtimeResolver: () => posixRuntime })
  assert.equal(typeof posix.manage, 'function')
  assert.notEqual(posix.host, 'cli', '显式 linux 不得被当成 WinCLI')
  // ③ 不注入 platform（生产默认）：本平台 win32 时同样走 WinCLI 且同样强护栏，不因缺 layout 回退 POSIX
  if (process.platform === 'win32') {
    assert.throws(() => createDriver(op, seams(true), product, f.evidence, budget(), { ...base, runtimeResolver: () => posixRuntime }), /运行时描述缺失/)
    assert.equal(createDriver(op, seams(true), product, f.evidence, budget(), { ...base, runtimeResolver: () => winRuntime }).host, 'cli')
  } else {
    assert.equal(typeof createDriver(op, seams(true), product, f.evidence, budget(), { ...base, runtimeResolver: () => posixRuntime }).manage, 'function')
  }
  // ④ desktop 优先且始终要求 desktop 描述符（与平台注入无关）
  const desktopOp = { ...op, host: 'desktop' }
  assert.throws(() => createDriver(desktopOp, seams(true), product, f.evidence, budget(), { ...base, platform: 'win32', runtimeResolver: () => winRuntime }), /运行时描述缺失/)
})
test('WinCLI driver: 模拟 adapter verify 失败后 restorePackage 恢复旧安装代或未安装', async t => {
  // ① 操作前已装旧代：验收失败 ⇒ 恢复预检抓下的旧代字节与装配
  const f = fixture(t, { installed: 'generation' })
  const driver = f.make()
  const oldManifest = read(path.join(f.installedDir, 'package.json')), oldMarker = read(path.join(f.installedDir, 'marker.txt'))
  assert.equal((await driver.preflight('uninstall')).noop, false)
  assert.ok(driver.recoveryPackage && driver.recoveryPackage.startsWith(f.evidence), '旧代须归档成恢复材料，不覆盖包源')
  assert.deepEqual(read(path.join(driver.recoveryPackage, 'package.json')), oldManifest)
  assert.deepEqual(read(path.join(driver.recoveryPackage, 'marker.txt')), oldMarker)
  await driver.manage('uninstall')
  assert.equal(existsSync(f.installedDir), false)
  driver.verify = async () => { throw Error('合成验收失败') } // 模拟 adapter 验收失败
  await assert.rejects(driver.verify('uninstall', seams(true), {}), /合成验收失败/)
  await driver.restorePackage()
  assert.deepEqual(read(path.join(f.installedDir, 'package.json')), oldManifest, '旧安装代必须字节还原')
  assert.deepEqual(read(path.join(f.installedDir, 'marker.txt')), oldMarker)
  const restored = JSON.parse(read(f.profileFile).toString('utf8'))
  assert.equal(restored.dependencies[adapter.packageName], linkValue(f.installedDir))
  assert.deepEqual(restored.dsh.profile.bundles, ['keep', adapter.packageName])
  // ② 操作前未安装：adapter 验收（源码接缝）失败 ⇒ restorePackage 回到未安装
  const clean = fixture(t)
  const cleanDriver = clean.make({ adapter: seams(false) }) // 该驱动认的 adapter 就是验收失败的那个
  assert.equal((await cleanDriver.preflight('install')).noop, false)
  await cleanDriver.manage('install')
  const cleanDir = path.join(clean.home, 'plugins', adapter.packageName)
  assert.ok(existsSync(cleanDir))
  await assert.rejects(cleanDriver.verify('install', seams(false), {}), /完整源码接缝未ready/)
  await cleanDriver.restorePackage()
  const back = JSON.parse(read(clean.profileFile).toString('utf8'))
  assert.deepEqual(back.dependencies, { keep: '1' }); assert.deepEqual(back.dsh.profile.bundles, ['keep'])
  assert.equal(existsSync(cleanDir), false)
  assert.equal(existsSync(path.join(clean.profileDir, 'node_modules', adapter.packageName)), false)
})

test('WinCLI driver: 恢复查询失败只告警、不代启动、子进程环境无 Electron 且 NodeWorker 探针调用②代码', async t => {
  const poison = { ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', NPM_CONFIG_RUNTIME: 'electron', npm_config_target: '32.0.0', npm_config_disturl: 'https://electronjs.org/headers' }
  const before = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]))
  Object.assign(process.env, poison)
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  const f = fixture(t)
  const driver = f.make()
  await driver.preflight('install')
  assert.ok(f.probes.length >= 2, '能力探针必须经 fake runPackage 调用（不启真实进程）')
  const worker = f.probes.find(call => /node:worker_threads/.test(String(call.args[call.args.length - 1])))
  assert.ok(worker, 'NodeWorker 能力探针（②）必须被调用')
  assert.match(String(worker.args[worker.args.length - 1]), /SourceTextModule/, '②代码须在 Worker 内取 vm.SourceTextModule')
  for (const call of f.probes) {
    assert.match(String(call.exe), /node(?:\.exe)?$/i, '子进程必须用 Node 启动')
    const env = call.options.env
    assert.deepEqual(Object.keys(env).filter(key => /electron/i.test(key)), [], '子进程环境不得带 Electron（大小写无关）')
    assert.deepEqual(Object.keys(env).filter(key => /^npm_config_(?:runtime|target|disturl)$/i.test(key)), [], 'WinCLI 不得给 npm/pnpm 的 Electron 目标旗标')
    assert.equal(env.DSH_HOME, f.home); assert.equal(env.DSH_TAVERN_CLI_HOME, f.home)
  }
  f.probes.length = 0
  const failing = f.make({ presence: () => { throw Error('CIM 查询失败') } })
  assert.equal((await failing.stopFailedStart()).changed, false, '恢复路径查询失败不得抛，也不得杀进程')
  assert.equal((await failing.stop()).changed, false)
  assert.ok(f.warnings.some(text => text.includes('windows-cli-driver')), '恢复查询失败必须留告警')
  assert.ok(await failing.start() == null, 'WinCLI 不代启动，必须返回空（不拉起进程）')
  assert.equal(f.probes.length, 0, '不代启动＝不产生任何子进程调用')
})

test('WinCLI driver: 兜底卸载坏旧包不要求 SDK peers/探针/包管理，残留归档与 restore 字节精确', async t => {
  const f = fixture(t, { installed: 'broken', withPeers: false, runPackage: async () => { throw Error('兜底卸载不能依赖探针/包管理') } })
  const driver = f.make()
  const brokenManifest = read(path.join(f.installedDir, 'package.json'))
  const cleaned = Buffer.from(JSON.stringify({ name: 'dsh-profile-tavern', dependencies: { keep: '1' }, dsh: { profile: { bundles: ['keep'] } }, settings: { preserve: true } }, null, 2) + '\n', 'utf8')
  assert.equal(existsSync(f.peerRoot), false, '夹具里没有任何 SDK peer/node_modules')
  const state = await driver.preflight('uninstall', { residual: true })
  assert.equal(state.assemblyPresent, true); assert.equal(state.noop, false)
  assert.equal(existsSync(path.join(f.profileDir, '.dsh-module-fallback')), false)
  await driver.manageResidual('uninstall')
  assert.equal(existsSync(f.installedDir), false)
  const archive = path.join(f.evidence, 'residual-packages', '0-' + adapter.packageName)
  assert.deepEqual(read(path.join(archive, 'package.json')), brokenManifest, '残留包必须字节归档')
  assert.deepEqual(read(f.profileFile), cleaned)
  assert.deepEqual(read(path.join(f.evidence, 'residual-profile-before.json')), f.profileBytes)
  await driver.manageResidual('restore')
  assert.deepEqual(read(f.profileFile), f.profileBytes, 'restore 必须逐字还原原 profile')
  assert.deepEqual(read(path.join(f.installedDir, 'package.json')), brokenManifest, 'restore 必须逐字还原坏旧包')
  assert.equal(existsSync(archive), false)
})

// 新块机制换代：同名不同包不再直接拒（preflight 标 upgrading、noop=false），装配真实装卸可回原代。
// input 用 version '0.3.8'（新机制一代）——判据是**块机制/现场块**，不是旧版 0.2.2 整数比较。
test('现场驱动1 新块换代预检允许且装配回原代', async t => {
  const f = fixture(t, { installed: 'generation' })
  const oldPkgFile = path.join(f.installedDir, 'package.json')
  writeFileSync(oldPkgFile, JSON.stringify({ name: adapter.packageName, version: '0.3.8', files: ['package.json', 'marker.txt'] }, null, 2) + '\n', 'utf8')
  const oldPkgBytes = read(oldPkgFile), profileBefore = read(f.profileFile)
  const driver = f.make()
  const state = await driver.preflight('install')
  assert.equal(driver.upgrading, true, '同名不同包必须标 upgrading（不再直接拒）')
  assert.equal(state.noop, false, 'upgrading 时不得报 noop')
  await driver.manage('uninstall') // 真文件系统：官方卸旧装配
  await driver.manage('install') // 真文件系统：装新代
  assert.ok(existsSync(path.join(f.profileDir, 'node_modules', adapter.packageName)), '装新代后装配必须存在')
  await driver.restorePackage() // 真文件系统：按 recoveryPackage 恢复原代装配
  assert.deepEqual(read(f.profileFile), profileBefore, 'profile 字节必须回到升级前')
  assert.deepEqual(read(oldPkgFile), oldPkgBytes, '恢复后装配包字节必须是升级前那一代')
  assert.ok(f.probes.every(item => item.exe === process.execPath), '只允许 fake runPackage 记录的能力探针（无真实包管理）')
})