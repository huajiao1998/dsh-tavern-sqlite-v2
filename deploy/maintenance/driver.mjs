// 目标profile原地离线装卸；保留原运行状态，无认证、无依赖树副本。
import { existsSync, lstatSync, readFileSync, writeFileSync, realpathSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import net from 'node:net'
import { command, findProcess, readProcess, sameProcess, stripSecrets, waitExit, processAlive, desktopTavernProcesses, windowsCliTavernProcesses } from './process.mjs'
import { pause, maintenanceBudget } from './budget.mjs'
import { runtimeFor, packagePolicyArgs, assertTargetAllowed } from './target.mjs'
import { parseSystemdProperties, systemdOwner, assertSystemdTarget, assertSystemdUnchanged } from './systemd.mjs'
import { rewriteExecStartVmFlag } from './environment.mjs'
import { waitSystemdExecIdentity } from './start-identity.mjs'
import { STANDARD_RECORD } from './source.mjs'
import { AUTHOR_VERSION } from '../../lib/standard-host.js'
import { residualAssembly } from './residual-assembly.mjs'
const family = ['dsh-tavern-storage-sqlite', 'dsh-tavern-storage-sqlite-v1', 'dsh-tavern-storage-sqlite-v2', 'dsh-tavern-sqlite-v1', 'dsh-tavern-sqlite-v2']
// 运行时依赖**必须为零**：四个解析器依赖（lodash/yaml/json5/jsonrepair）已 vendor 进包内
// （见 lib/vendor/VENDOR.md + manifest.json）。零依赖是"任何宿主都能离线安装"的前提：
// 桌面版宿主的 pnpm 离线元数据缓存里没有 lodash/json5/jsonrepair，声明依赖会 ERR_PNPM_NO_OFFLINE_META。
const VENDOR_ENTRIES = { lodash: 'lib/vendor/lodash/lodash.min.js', json5: 'lib/vendor/json5/index.mjs', jsonrepair: 'lib/vendor/jsonrepair/esm/index.js', yaml: 'lib/vendor/yaml/dist/index.js' }
/**
 * 供应链护栏（安装前必过）：包只能有零运行时依赖，且 vendor 账本与四个入口文件必须齐全。
 * 任一不符即拒绝安装——不放宽依赖政策。
 */
export function assertPackageDependencies(pkg, root) {
  const declared = Object.keys(pkg.dependencies || {})
  if (declared.length > 0) throw Error('本包要求零运行时依赖（解析器依赖已 vendor 进包内）；发现：' + declared.join('、') + '，拒绝安装')
  const manifestFile = path.join(root, 'lib', 'vendor', 'manifest.json')
  if (!existsSync(manifestFile)) throw Error('缺少 vendor 账本 lib/vendor/manifest.json，拒绝安装')
  let manifest
  try { manifest = json(manifestFile) } catch (error) { throw Error('vendor 账本无法解析：' + (error && error.message)) }
  for (const [name, entry] of Object.entries(VENDOR_ENTRIES)) {
    const recorded = manifest.packages?.[name]
    if (!recorded || recorded.version === undefined) throw Error('vendor 账本缺少 ' + name + ' 的记录，拒绝安装')
    if (!existsSync(path.join(root, entry))) throw Error('vendor 入口缺失：' + entry + '，拒绝安装')
  }
  return { packages: Object.fromEntries(Object.entries(VENDOR_ENTRIES).map(([name]) => [name, manifest.packages[name].version])) }
}
const json = p => JSON.parse(readFileSync(p, 'utf8'))
const profileState = dir => { const data = json(path.join(dir, 'package.json')); return { data, deps: data.dependencies || {}, bundles: data.dsh?.profile?.bundles || [] } }
export async function packageCommand(exe, args, { cwd, env, timeout = 20000 } = {}) {
  // windowsHide：Windows 上避免控制台闪烁；detached 仅在 POSIX 用于建立进程组（便于整组终止）。
  const child = spawn(exe, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: 'inherit' })
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
// 启动方式判据：默认不改unit、不改NODE_OPTIONS；安装需要既有--experimental-vm-modules，其余动作不要求旗标。
export function assertLaunchMode(action, adapter, argv) {
  if (action !== 'install' || !adapter.requiresVmModules) return { required: false }
  if (!argv) throw Error('既有启动命令不可确证，拒绝在猜测旗标下安装')
  if (!argv.includes('--experimental-vm-modules')) throw Error('V2需要既有Node --experimental-vm-modules；默认不静默改启动命令（显式加 --prepare-env 可授权自动补旗标并留备份）')
  return { required: true }
}
/**
 * 读取 profile 已有 node_modules 使用的 pnpm store 目录。
 * 桌面版（Desktop 2.0.13 自带 pnpm 11.8.0）把 store 放在 `<tavernRoot>/data/cache/pnpm/v11`，
 * 而 pnpm 11 在 store 与既有链接不一致时会直接 **ERR_PNPM_UNEXPECTED_STORE 拒绝安装**：
 * 因此必须把既有 store 显式交给这次安装，而不是让它回落到默认的 `<盘>\.pnpm-store\v11`。
 * 只读 `.modules.yaml` 的 storeDir 字段（自发现，不猜路径、不写死）。
 */
export function pnpmStoreDir(profileDir) {
  const file = path.join(profileDir, 'node_modules', '.modules.yaml')
  if (!existsSync(file)) return null
  try {
    // 该文件是 YAML 但键值写成 JSON 风格：`"storeDir": "D:\\Program Files ...\\v11",`
    // ——键可能带引号，路径里的反斜杠是**双写转义**，取到值后要还原。
    const hit = /^\s*"?storeDir"?:\s*"?(.+?)"?\s*,?\s*$/m.exec(readFileSync(file, 'utf8'))
    if (!hit) return null
    const value = hit[1].trim().replace(/\\\\/g, '\\')
    return value || null
  } catch { return null }
}

/**
 * 宿主 peer 投影（桌面版专用，2026-10-06 真机根因修复）。
 *
 * 桌面版 Electron 的模块解析覆盖层把 `@deepseek-ai/*` 锚到 **CLI 版才有的**
 * `<DSH_HOME>/runtime/lib/node_modules`（桌面安装没有该目录），而 `dsh-app-boot` 生成的
 * 插件私有农场 `<profile>/.dsh-module-fallback/node_modules` 又按设计**排除**安装自带的包
 *（`installationPackageNames`），于是"插件声明的宿主 peer"在桌面端谁也解析不到 ⇒ 插件加载失败、
 * 整个插件树进恢复模式（真机实测）。
 *
 * 这里把插件声明的 `@deepseek-ai/*` peer **投影进它自己的私有农场**，目标取**桌面应用自己的**
 * `resources/app/node_modules/@deepseek-ai/<name>`——与宿主 harness 加载的是同一份真实路径，
 * 因此 Node 模块缓存命中同一实例（宿主补丁必须打在同一个实例上，复制一份是错的）。
 * 投影清单落一个标记文件，卸载时只摘我们建的那些，绝不覆盖/删除别人的投影。
 */
const HOST_PEER_MARKER = '.dsh-tavern-sqlite-v2-host-peers.json'
export function hostPeerNames(pkg) {
  return Object.keys(pkg.peerDependencies || {}).filter(name => name.startsWith('@deepseek-ai/'))
}
export function ensureHostPeerLinks(pkg, desktop, profileDir) {
  const names = hostPeerNames(pkg)
  if (names.length === 0) return []
  const scopeDir = path.join(profileDir, '.dsh-module-fallback', 'node_modules', '@deepseek-ai')
  const sourceDir = path.join(desktop.appDir, 'node_modules', '@deepseek-ai')
  mkdirSync(scopeDir, { recursive: true })
  const created = []
  for (const name of names) {
    const leaf = name.split('/')[1]
    const target = path.join(sourceDir, leaf)
    if (!existsSync(path.join(target, 'package.json'))) throw Error('桌面版运行时缺少宿主 peer：' + name + '（' + target + '）；拒绝安装一个加载不起来的插件')
    const link = path.join(scopeDir, leaf)
    if (existsSync(link)) {
      if (realpathSync(link) !== realpathSync(target)) throw Error('插件农场里已有指向别处的 ' + name + '：拒绝覆盖既有投影')
      continue
    }
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    created.push(leaf)
  }
  writeFileSync(path.join(scopeDir, HOST_PEER_MARKER), JSON.stringify({ package: pkg.name, created }, null, 2) + '\n', 'utf8')
  return created
}
export function removeHostPeerLinks(profileDir) {
  const scopeDir = path.join(profileDir, '.dsh-module-fallback', 'node_modules', '@deepseek-ai')
  const marker = path.join(scopeDir, HOST_PEER_MARKER)
  if (!existsSync(marker)) return []
  let created = []
  try { created = JSON.parse(readFileSync(marker, 'utf8')).created || [] } catch { created = [] }
  const removed = []
  for (const leaf of created) {
    const link = path.join(scopeDir, leaf)
    // 只删我们记过的、且确实还是"链接"的条目；普通目录视为他人投影，不动。
    try { if (existsSync(link)) { rmSync(link, { recursive: true, force: true }); removed.push(leaf) } } catch { /* 摘除失败不掩盖原错误，下次卸载重试 */ }
  }
  rmSync(marker, { force: true })
  return removed
}

/**
 * 把插件写成 profile 的 **`link:` 依赖 + bundle**（与作者自家插件同形状）。
 * 只增删我们自己那一条，其余字段（含 `dshTavern.*` 作者管理清单）原样保留、不改语义。
 */
export function writeProfileLink(profileDir, packageName, target) {
  const file = path.join(profileDir, 'package.json')
  const data = json(file)
  data.dependencies = { ...(data.dependencies || {}), [packageName]: 'link:' + target.split(path.sep).join('/') }
  const bundles = Array.isArray(data.dsh?.profile?.bundles) ? data.dsh.profile.bundles : []
  if (!bundles.includes(packageName)) data.dsh = { ...(data.dsh || {}), profile: { ...(data.dsh?.profile || {}), bundles: [...bundles, packageName] } }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}
export function removeProfileLink(profileDir, packageName) {
  const file = path.join(profileDir, 'package.json')
  const data = json(file)
  if (data.dependencies) delete data.dependencies[packageName]
  const bundles = data.dsh?.profile?.bundles
  if (Array.isArray(bundles)) data.dsh.profile.bundles = bundles.filter(name => name !== packageName)
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/**
 * 把宿主 peer 作为 junction 放进**插件自己的 node_modules**（2026-10-06 真机第三次修复）。
 *
 * 桌面版 Electron 的解析覆盖层对 `@deepseek-ai/*` 有一个硬锚点 `<home>/runtime/lib/node_modules`
 *（CLI 版布局，桌面安装里不存在），并且只对"linked profile 模块"才放行共享回退根——
 * 而我们的包实体在 profile 之外，实测 `file:` 与 `link:` 两种形状都仍被拉到那个死锚点上。
 *
 * 作者自家的插件之所以能加载，是因为它们的 `@deepseek-ai/*` 依赖**就在自己的 node_modules 里**
 * （`tavern-plugin/package.json` 把 dsh-tools/dsh-agent 等列为 dependencies），走**普通 Node 上溯**
 * 就能命中，完全不经过覆盖层那条规则。
 *
 * 这里照同样的形状：把包里声明的宿主 peer 逐个 junction 到**宿主运行时自己的副本**
 * （桌面版 `resources/app/node_modules/@deepseek-ai/<name>`；WinCLI `home/runtime/node_modules/...`）
 * ——realpath 与 harness 加载的是同一份，保证模块实例一致（宿主补丁必须打在同一个实例上）。
 * 整包目录在卸载时一并删除，无需另记清单。
 * `label` 只用于错误文案（默认桌面版；WinCLI 传中性描述，不冒称桌面宿主）。
 */
export function linkHostPeersIntoPackage(pkg, desktop, installDir, label = '桌面版') {
  const names = Object.keys(pkg.peerDependencies || {}).filter(name => name.startsWith('@deepseek-ai/'))
  if (names.length === 0) return []
  const linked = []
  for (const name of names) {
    const source = path.join(desktop.appDir, 'node_modules', ...name.split('/'))
    if (!existsSync(path.join(source, 'package.json'))) throw Error(label + '运行时缺少宿主 peer：' + name + '（' + source + '）；拒绝安装一个加载不起来的插件')
    const link = path.join(installDir, 'node_modules', ...name.split('/'))
    mkdirSync(path.dirname(link), { recursive: true })
    rmSync(link, { recursive: true, force: true })
    symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')
    linked.push(name)
  }
  return linked
}

/**
 * 停止态驱动（桌面版 Electron 与原生 Windows CLI 共用；2026-10-07 由旧 createDesktopDriver 原样提取）。
 *
 * 共同点：**不接管停/启**——桌面版没有可由安装器管理的服务（托盘启停），WinCLI 由用户自己的
 * `dsh-tavern stop/start` 负责；装包一律按作者 `link:` 形状（copyPackage + profile link + junction
 * + 宿主 peer 同实例投影），**不走官方 pnpm shell**：避免离线重装其它 dep 与 store/路径坑，
 * 本包已零 runtimeDependencies、解析器依赖 vendor 进包内。
 *
 * 差异只在 `mode`：
 *   · 'desktop'     —— Electron 桌面版；子进程环境对齐桌面自家装包环境（Electron 头/离线）；
 *                      宿主 peer 物理源=应用树 `resources/app/node_modules`；`host:'desktop'`。
 *   · 'windows-cli' —— 原生 WinCLI 私有 runtime；子进程环境**只给 Node**（不带 ELECTRON_RUN_AS_NODE、
 *                      不带 npm/pnpm 的 Electron 目标旗标）；宿主 peer 物理源=`home/runtime/node_modules`；
 *                      `host:'cli'`（绝不冒认桌面宿主）。
 *
 * 与 CLI/POSIX 路径的分工是**整体替换**，不是修补：POSIX 的进程身份（/proc argv/cwd/代次）与
 * systemd 所有权在 Windows 没有等价物，自造一套弱化版会削弱"认领前必须确证同一对象"的护栏。
 * 因此两者都只做**存在性判定**：目标在跑就拒绝写入并提示用户先完整停止，**绝不杀进程、绝不代启**。
 */
const STOPPED_HOSTS = {
  desktop: {
    host: 'desktop', label: '桌面版', tag: 'desktop-driver',
    // 桌面版由托盘退出/重开：提示语与提取前逐字一致。
    stoppedHint: '桌面版没有可由安装器停/启的服务，请先从托盘退出酒馆后再安装',
    startHint: '从托盘手动启动',
    restart: '请从托盘退出并重新启动酒馆桌面版，再从 Profile 菜单进入 tavern 由用户确认页面与玩法',
    web: '桌面版不做 HTTP/页面自动验收；插件加载与页面由用户重启后确认',
  },
  'windows-cli': {
    host: 'cli', label: 'Windows CLI', tag: 'windows-cli-driver',
    // WinCLI 由用户按原方式停/启：不改作者 start/NODE_OPTIONS，不代启、不代停。
    stoppedHint: 'Windows CLI 由用户自行停/启，请先按原方式完整停止酒馆后再安装',
    startHint: '按原方式手动启动',
    restart: '请按原方式重新启动酒馆 CLI，再从已登录页面进入 tavern 由用户确认页面与玩法',
    web: 'Windows CLI 不做 HTTP/页面自动验收；插件加载与页面由用户启动后确认',
  },
}
function nodeOnlyEnv(env) {
  const blocked = new Set(['electron_run_as_node', 'npm_config_runtime', 'npm_config_target', 'npm_config_disturl'])
  return Object.fromEntries(Object.entries(env).filter(([key]) => !blocked.has(key.toLowerCase())))
}
function createStoppedDriver(op, adapter, packageRoot, evidence, budget, { mode, runtime, runPackage = packageCommand, presence = null, activeBudget = budget, logger = console } = {}) {
  const spec = STOPPED_HOSTS[mode]
  if (!spec) throw Error('未知的停止态宿主模式：' + mode)
  const windowsCli = mode === 'windows-cli'
  const layout = windowsCli ? runtime?.windowsCli : runtime?.desktop
  if (!layout?.appDir || !layout?.peerRoot) throw Error(spec.label + '运行时描述缺失，拒绝认领目标')
  const { host, label, tag } = spec
  // presence 只收一个 context：WinCLI 要 {...op,...runtime}（home/profile/windowsCli 描述符），
  // 桌面版沿用既有 { root, runtimeDir } 形状；查询失败一律上抛（fail closed），不当停止态。
  const context = windowsCli ? { ...op, ...runtime } : { root: op.tavernRoot, runtimeDir: layout.root }
  const findRunning = presence || (windowsCli ? windowsCliTavernProcesses : desktopTavernProcesses)
  const installed = path.join(op.profileDir, 'node_modules', adapter.packageName)
  let prior = null, originalDependencyBytes = {}, residual = null
  const driver = { runtime, recoveryPackage: null, wasRunning: false, host }
  // pnpm store 探路只为桌面版历史通路保留（WinCLI 不读 pnpm 产物，装包只 copy+link）：
  // pnpm 11 的 store-dir 只认 CLI flag（.npmrc/环境变量无效），与既有 node_modules 不一致会
  // ERR_PNPM_UNEXPECTED_STORE，故沿用 `.modules.yaml` 记录的既有 store 并给值加内嵌双引号。
  const storeDir = windowsCli ? null : pnpmStoreDir(op.profileDir)
  const storeArgs = storeDir ? ['--store-dir="' + storeDir + '"'] : []
  // 子进程环境：桌面版对齐桌面自家装包环境；WinCLI 只给 Node（按大小写无关删掉父环境里的
  // ELECTRON_RUN_AS_NODE 与 npm_config_runtime/target/disturl，不改父 env）。
  const env = windowsCli
    ? { ...nodeOnlyEnv(stripSecrets(process.env)), DSH_HOME: op.home, DSH_TAVERN_CLI_HOME: op.home }
    : {
      ...stripSecrets(process.env),
      ELECTRON_RUN_AS_NODE: '1', DSH_HOME: op.home, DSH_TAVERN_CLI_HOME: op.home,
      npm_config_runtime: 'electron', npm_config_target: layout.electronVersion,
      // 与桌面版自己的装包环境对齐（desktop-package-manager.mjs 同款）：disturl 指向 Electron 头，
      // CI 抑制交互提示。缺这两项时 pnpm 在离线模式下的行为与桌面自家通路不一致。
      npm_config_disturl: 'https://electronjs.org/headers', CI: 'true',
      pnpm_config_update_notifier: 'false', npm_config_offline: 'true', pnpm_config_offline: 'true',
    }
  const running = () => findRunning(context)
  const assertStopped = async () => {
    if (windowsCli) {
      // 只操作 home 内的真实父目录；最终本包 junction 允许，父 junction 不能带写入越界。
      for (const leaf of [op.profileDir, path.dirname(installed), path.join(op.home, 'plugins')]) {
        if (!leaf.startsWith(op.home + path.sep)) throw Error('Windows CLI 装配父目录越出 home，拒绝维护')
        for (let dir = leaf; dir !== op.home; dir = path.dirname(dir)) {
          if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw Error('Windows CLI 装配父目录为链接，拒绝越界写入：' + dir)
        }
      }
    }
    const list = running()
    if (list.length) {
      throw Error('酒馆' + label + '正在运行（PID ' + list.map(item => item.pid).join(',') + '）：' + spec.stoppedHint + '（不杀进程、不修改运行中的程序）')
    }
  }
  const assertAssembly = action => {
    const state = profileState(op.profileDir), present = !!state.deps[adapter.packageName] && state.bundles.includes(adapter.packageName) && existsSync(installed)
    const other = deps => Object.fromEntries(Object.entries(deps).filter(([key]) => key !== adapter.packageName).sort(([a], [b]) => a.localeCompare(b)))
    if (JSON.stringify(other(state.deps)) !== JSON.stringify(other(prior.deps)) || JSON.stringify(state.bundles.filter(s => s !== adapter.packageName)) !== JSON.stringify(prior.bundles.filter(s => s !== adapter.packageName))) throw Error('装卸改变非目标依赖/bundle，拒绝成功')
    for (const [file, bytes] of Object.entries(originalDependencyBytes || {})) if (bytes && (!existsSync(file) || !readFileSync(file).equals(bytes))) throw Error('官方操作改变既有非目标软件包，拒绝冒认单包安装成功')
    if (present !== (action === 'install')) throw Error('目标依赖/bundle/链接回读不一致')
    if (action === 'uninstall' && (state.deps[adapter.packageName] || state.bundles.includes(adapter.packageName) || existsSync(installed))) throw Error('卸载仍有装配残留')
    return state
  }
  // 桌面版从不启动/停止酒馆（由用户从托盘操作），因此恢复路径里的 stop 家族方法**绝不能抛**：
  // runner 的失败恢复**总会**调 stopFailedStart()（runner.mjs:111），抛错会让恢复在
  // `source.restore(baseline)` **之前**中断，留下"改了源码没恢复"的半装状态（真机实测踩到过）。
  // 语义：不杀任何进程、不代启；若目标在跑只响亮告警，恢复照常继续。
  const noStop = async reason => {
    let list
    try { list = running() } catch (error) {
      if (!windowsCli) throw error
      logger?.warn?.('[' + tag + '] ' + reason + '：进程查询失败，不杀进程；后续写入仍须证明停止：' + error.message)
      return { changed: false, host, running: 'unknown' }
    }
    if (list.length) logger?.warn?.('[' + tag + '] ' + reason + '：目标酒馆正在运行（PID ' + list.map(item => item.pid).join(',') + '），不杀进程；源码/装配恢复继续，重启后生效')
    return { changed: false, host, running: list.length > 0 }
  }
  return Object.assign(driver, {
    async prepareEnvironment() {
      if (windowsCli) throw Error('Windows CLI 不自动修改启动配置；请自行 dsh-tavern stop 后维护')
      // 桌面版没有 systemd 单元可改，也**不需要** --experimental-vm-modules：
      // 缺 vm 时插件自己走 Worker 路径（execArgv 带旗标），故此处不做事、不假装成功。
      return { changed: false, host, reason: '桌面版经 Worker 取得 vm 能力，无需环境预修' }
    },
    async preflight(action, { residual: cleanResidual = false } = {}) {
      if (windowsCli && !op.check) await assertStopped()
      const pkg = json(path.join(packageRoot, 'package.json'))
      if (pkg.name !== adapter.packageName) throw Error('维护入口与本地包身份不一致')
      if (!cleanResidual) assertPackageDependencies(pkg, packageRoot)
      for (const peer of cleanResidual ? [] : Object.keys(pkg.peerDependencies || {})) {
        const manifest = path.join(layout.peerRoot, ...peer.split('/'), 'package.json')
        if (!existsSync(manifest) || json(manifest).version !== '0.1.5-rc.2') throw Error('桌面版既有宿主peer缺失/未适配：' + peer + '；不自动安装第二份宿主')
        // 宿主 peer 还必须在**桌面应用自己**的 node_modules 里存在——投影（见 ensureHostPeerLinks）
        // 就是指向那一份，保证与 harness 加载的是同一模块实例。
        const hostCopy = path.join(layout.appDir, 'node_modules', ...peer.split('/'), 'package.json')
        if (!existsSync(hostCopy)) throw Error('桌面版应用侧缺少宿主 peer 同实例副本：' + peer + '（' + hostCopy + '）')
      }
      prior = profileState(op.profileDir)
      originalDependencyBytes = cleanResidual ? {} : Object.fromEntries(Object.keys(prior.deps).filter(name => name !== adapter.packageName).map(name => {
        const file = path.join(op.profileDir, 'node_modules', ...name.split('/'), 'package.json')
        return [file, existsSync(file) ? readFileSync(file) : null]
      }))
      for (const name of family) if (name !== adapter.packageName && (prior.deps[name] || prior.bundles.includes(name))) throw Error('另一版本线已安装，先用所属包卸载')
      const author = json(path.join(op.app, 'tavern-plugin', 'package.json'))
      if (author.name !== 'dsh-tavern-plugin') throw Error('作者版本未适配')
      if (!cleanResidual && author.version !== AUTHOR_VERSION) {
        // 作者版本变化不再直接拒：用共享**只读计划**判定“契约等价/已施缝同代”（不写盘、不 import 作者）。
        const plan = typeof adapter.inspectStandardSeamsPlan === 'function' ? adapter.inspectStandardSeamsPlan({ appDir: op.app, authorVersion: author.version }) : null
        if (!plan || (plan.ready !== true && plan.compatible?.ok !== true)) throw Error('作者版本未适配且契约不等价：' + author.version)
      }
      const patch = cleanResidual ? '' : readFileSync(path.join(op.profileDir, 'cordis.patch.yml'), 'utf8').replace(/^\s*#.*$/gm, '').trim()
      if (!cleanResidual && patch !== '[]' && patch !== '') throw Error('profile自定义patch非空，请先核冲突；不覆盖用户配置')
      if (cleanResidual) {
        if (action !== 'uninstall') throw Error('兜底残留路径仅用于卸载')
        residual = residualAssembly({ home: op.home, profileDir: op.profileDir, packageName: adapter.packageName, evidence })
        driver.wasRunning = false
        const runningNow = running().length > 0
        return { noop: false, wasRunning: windowsCli && !!op.check && runningNow, host, runningNow, assemblyPresent: residual.present }
      }
      // `--check` 是只读预检，允许酒馆开着；真正写前的停止态断言在 assertIdentity/manage 里
      //（runner 在装包前还会再调一次 assertStopped）。这里只记录当前是否在跑，便于如实报告。
      const runningNow = running().length > 0
      // 能力探针①：维护进程的 Node 必须能开 node:sqlite(STRICT) 与 zstd（不要求 vm，桌面版由 Worker 提供）。
      const probe = "import {DatabaseSync} from 'node:sqlite';import {zstdDecompressSync} from 'node:zlib';const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE probe(k INTEGER PRIMARY KEY) STRICT');db.close();if(typeof zstdDecompressSync!=='function')throw Error('缺少zstd')"
      await runPackage(process.execPath, ['--input-type=module', '-e', probe], { cwd: op.app, env, timeout: activeBudget.remaining(2500) })
      // 能力探针②：**Worker 内**必须有 vm.SourceTextModule（这是桌面版跑服务端 ESM 卡脚本的唯一通路）。
      // 注意 clearTimeout：不清理的话定时器会把探针进程多吊住 8 秒（每次安装白等）。
      const desktopWorkerProbe = "import {Worker} from 'node:worker_threads';const code=\"const vm=require('node:vm');const {parentPort}=require('node:worker_threads');parentPort.postMessage(typeof vm.SourceTextModule)\";const worker=new Worker(code,{eval:true,execArgv:['--experimental-vm-modules']});const seen=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Worker 探针超时')),8000);worker.once('message',message=>{clearTimeout(timer);resolve(message);worker.terminate()});worker.once('error',error=>{clearTimeout(timer);reject(error)})});if(seen!=='function')throw Error('Worker 内缺少 vm.SourceTextModule')"
      const workerProbe = windowsCli ? "import {Worker} from 'node:worker_threads';const code=\"const vm=require('node:vm');const {parentPort}=require('node:worker_threads');(async()=>{const m=new vm.SourceTextModule('export default 42');await m.link(()=>{});await m.evaluate();if(typeof vm.SyntheticModule!=='function')throw Error('缺少SyntheticModule');parentPort.postMessage(m.namespace.default)})().catch(e=>{throw e})\";const worker=new Worker(code,{eval:true,execArgv:['--experimental-vm-modules']});let timer;try{const seen=await new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('Worker探针超时')),4000);worker.once('message',resolve);worker.once('error',reject)});if(seen!==42)throw Error('Worker ESM核验失败')}finally{clearTimeout(timer);await worker.terminate()}" : desktopWorkerProbe
      await runPackage(process.execPath, ['--input-type=module', '-e', workerProbe], { cwd: op.app, env, timeout: activeBudget.remaining(windowsCli ? 5000 : 9000) })
      const present = !!prior.deps[adapter.packageName]
      if (present !== prior.bundles.includes(adapter.packageName) || present !== existsSync(installed)) throw Error('目标装配不完整，拒绝猜测')
      let withdrawnClean = false
      if (present) {
        if (json(path.join(installed, 'package.json')).name !== adapter.packageName) throw Error('现装包身份错误')
        const { copyPackage, samePackage } = await import('./runner.mjs')
        driver.recoveryPackage = samePackage(packageRoot, realpathSync(installed)) ? packageRoot : path.join(evidence, 'original-package')
        if (driver.recoveryPackage !== packageRoot) copyPackage(realpathSync(installed), driver.recoveryPackage)
        if (action === 'install' && driver.recoveryPackage !== packageRoot) throw Error('现装不同代：现装插件 ' + json(path.join(installed, 'package.json')).version + '，待装插件 ' + pkg.version + '（包字节不一致，非酒馆版本不匹配）；先用本地所属代卸载，不自动升级；现装插件目录：' + realpathSync(installed))
        // 宿主正常退出由标准host disposer撤缝并删记录（装配保留）：该态install按首装重建，
        // uninstall仅卸装配；非该态仍要求记录在场，缺记录即拒绝（不猜）。
        if (!existsSync(path.join(op.app, STANDARD_RECORD))) {
          const { sourceAccess, withdrawnCleanState } = await import('./source.mjs')
          if (!withdrawnCleanState(sourceAccess(op.app, adapter.targets))) throw Error('已装包但缺源码恢复记录')
          withdrawnClean = true
        }
      } else if (existsSync(path.join(op.app, STANDARD_RECORD))) throw Error('包不在但接缝在，拒绝认领')
      driver.wasRunning = false
      return { noop: (action === 'install' ? present : !present) && !withdrawnClean, wasRunning: windowsCli && !!op.check && runningNow, host, runningNow, ...(withdrawnClean ? { withdrawnClean: true } : {}) }
    },
    async manageResidual(action) {
      await assertStopped()
      if (!residual) throw Error('兜底装配未预检')
      return action === 'restore' ? residual.restore() : residual.uninstall()
    },
    async assertIdentity() {
      // 桌面版不做进程身份认领（Windows 无 argv/cwd/代次可核）；写前只需确证目标不在跑。
      await assertStopped()
    },
    assertStopped,
    // 生命周期：不抛（见 noStop 注释）。start 也不代启——桌面版由用户从托盘启动。
    stop: () => noStop('停止请求'),
    stopIfAlive: () => noStop('停止请求'),
    stopFailedStart: () => noStop('失败启动清理'),
    async start() { logger?.warn?.('[' + tag + '] 不代启动酒馆：请用户' + spec.startHint); return null },
    async stoppedAfterError() { return (await running()).length === 0 },
    beginRecovery() {},
    async restorePackage() {
      // 与 POSIX 驱动同语义：把 **profile 装配**恢复到操作前状态——本来就装着 ⇒ 用恢复包重装；
      // 本来没装 ⇒ 卸掉；两态都没有 ⇒ 断言确实未装。**绝不往包源（packageRoot）写**。
      if (prior?.deps?.[adapter.packageName]) {
        await driver.manage('install', driver.recoveryPackage || packageRoot)
        if (windowsCli) {
          // 旧代恢复只还原本插件的原依赖说明；其他字段沿用当前值，不把旧profile整档盖回。
          await assertStopped()
          const file = path.join(op.profileDir, 'package.json'), current = json(file)
          current.dependencies[adapter.packageName] = prior.deps[adapter.packageName]
          writeFileSync(file, JSON.stringify(current, null, 2) + '\n', 'utf8')
          assertAssembly('install')
        }
      }
      else if (profileState(op.profileDir).deps[adapter.packageName] || existsSync(installed)) await driver.manage('uninstall')
      else assertAssembly('uninstall')
      return { changed: true, host }
    },
    async manage(action, root = packageRoot) {
      await assertStopped()
      // **桌面版按作者的 `link:` 形状安装，不走 pnpm**（2026-10-06 真机根因）：
      // 桌面版 Electron 的解析覆盖层把"profile 包解析到共享回退根 `<home>/profiles/node_modules`"
      // 判为 obsolete 而拒绝，**只有 linked profile 模块才允许走共享回退**
      //（`resources/app/lib/module-resolution-*.js` 的 canUseProfileSharedDependencyUrl 要求父模块是 linked）。
      // 作者自己的插件全是 `link:` 形状，所以它们的 `@deepseek-ai/*` 能从共享根解析、拿到与 harness
      // 同一实例。走 pnpm 的 `file:` 安装则注定解析失败（真机两次实测）。这同时绕开了 pnpm 11 在
      // 桌面宿主上的 store/离线元数据/remove 参数三个坑。
      const installDir = path.join(op.home, 'plugins', adapter.packageName)
      const linkPath = path.join(op.profileDir, 'node_modules', adapter.packageName)
      const { copyPackage, samePackage } = await import('./runner.mjs')
      if (action === 'install') {
        rmSync(installDir, { recursive: true, force: true })
        mkdirSync(path.dirname(installDir), { recursive: true })
        copyPackage(root, installDir)
        linkHostPeersIntoPackage(json(path.join(root, 'package.json')), layout, installDir)
        writeProfileLink(op.profileDir, adapter.packageName, installDir)
        rmSync(linkPath, { recursive: true, force: true })
        mkdirSync(path.dirname(linkPath), { recursive: true })
        symlinkSync(installDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
        assertAssembly(action)
        if (!samePackage(root, realpathSync(linkPath))) throw Error('链接安装后的包字节不是选定本地代，拒绝成功')
      } else {
        removeProfileLink(op.profileDir, adapter.packageName)
        rmSync(linkPath, { recursive: true, force: true })
        rmSync(installDir, { recursive: true, force: true })
        assertAssembly(action)
      }
    },
    async verify(action, _adapter, _opts = {}) {
      if (windowsCli) await assertStopped()
      // `existing:true` 是 runner **幂等路径**（已处于目标状态时的复核）的语义，
      // 不是"对运行中实例复验"——这里绝不能抛，否则桌面端重装/幂等检查直接失败。
      // 桌面版不做进程/HTTP 验收：酒馆由用户退出/重开，页面由用户确认。
      assertAssembly(action)
      if (action === 'install' && !adapter.checkStandardSeams({ appDir: op.app }).ready) throw Error('完整源码接缝未ready')
      return {
        runtimeVerified: false, state: 'stopped', host,
        requiresRestart: spec.restart,
        webVerification: spec.web,
      }
    },
    async verifyRecovery() { return driver.verify('install', adapter, {}) },
  })
}

export function createDesktopDriver(op, adapter, root, evidence, budget, options = {}) {
  return createStoppedDriver(op, adapter, root, evidence, budget, { ...options, mode: 'desktop' })
}
export function createWindowsCliDriver(op, adapter, root, evidence, budget, options = {}) {
  if (op['systemd-unit'] || op['prepare-env']) throw Error('Windows CLI 不接管 systemd 或启动配置')
  return createStoppedDriver(op, adapter, root, evidence, budget, { ...options, mode: 'windows-cli' })
}

export function createDriver(op, adapter, packageRoot, evidence, budget, { platform = process.platform, processFinder = findProcess, processReader = readProcess, runPackage = packageCommand, request = fetch, runtimeResolver = runtimeFor, runCommand = command, portOpen = tcpOpen, alive = processAlive } = {}) {
  const runtime = runtimeResolver(op, { platform }), context = { ...op, ...runtime }, installed = path.join(op.profileDir, 'node_modules', adapter.packageName)
  // 桌面版（Electron）走整体替换的独立驱动：POSIX 的进程身份与 systemd 所有权在 Windows 无等价物，
  // 不做"半套身份校验"，只做存在性判定＋桌面版自己的装包入口。CLI/POSIX 路径一行未改。
  if (op.host === 'desktop') return createDesktopDriver(op, adapter, packageRoot, evidence, budget, { runtime, runPackage })
  // 路由按**目标平台**（可注入；默认 ambient）而非硬读 process.platform：POSIX 意图的合成夹具显式传
  // platform:'linux' 后仍走原 CLI 路径，Windows 真实宿主不传即为 win32，护栏不放宽。
  if (platform === 'win32' && op.host === 'cli') return createWindowsCliDriver(op, adapter, packageRoot, evidence, budget, { runtime, runPackage })
  let original, prior, unit, latest, stopSignalled = false, launch = 0, recovery = false, activeBudget = budget, residual = null
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
    /**
     * 显式环境预修（--prepare-env，仅 install）：把缺失的 --experimental-vm-modules 补进
     * systemd 单元 ExecStart（备份原unit→改写→daemon-reload→按原方式重启→复验argv）。
     * 非systemd管理或改写失败可回滚时，一律拒绝并保持原状；不带该开关时本方法不做事。
     */
    async prepareEnvironment(action) {
      if (action !== 'install' || !adapter.requiresVmModules || !op['prepare-env']) return { changed: false }
      const current = processFinder(context)
      const editUnit = async unitName => {
        const state = parseSystemdProperties(runCommand('systemctl', ['show', unitName, ...['MainPID', 'ActiveState', 'ExecStart', 'FragmentPath'].flatMap(key => ['-p', key])], { timeout: activeBudget.remaining(2000) }))
        const argv = /argv\[\]=([^;]+) ;/.exec(state.ExecStart || '')?.[1]?.trim()
        if (!argv || !state.FragmentPath || !existsSync(state.FragmentPath)) throw Error('--prepare-env：单元ExecStart/FragmentPath不可确证，拒绝改写')
        if (argv.split(/\s+/).includes('--experimental-vm-modules')) return { changed: false, unit: unitName }
        return { changed: true, unit: unitName, fragment: state.FragmentPath, before: readFileSync(state.FragmentPath, 'utf8') }
      }
      if (current) {
        if (current.argv.includes('--experimental-vm-modules')) return { changed: false, vmFlag: 'already-present' }
        const owner = systemdOwner(current.cgroup || '')
        const unitName = op['systemd-unit'] || owner
        if (!unitName) throw Error('--prepare-env：目标非systemd管理，无法自动补旗标；请手工在启动命令加 --experimental-vm-modules 后重试')
        if (op['systemd-unit'] && owner && op['systemd-unit'] !== owner) throw Error('--prepare-env：指定systemd单元不拥有目标进程')
        const plan = await editUnit(unitName)
        if (!plan.changed) throw Error('--prepare-env：单元已带旗标但运行进程没有，形态不一致，拒绝继续')
        if (Number(parseSystemdProperties(runCommand('systemctl', ['show', unitName, '-p', 'MainPID'], { timeout: activeBudget.remaining(2000) })).MainPID) !== current.pid) throw Error('--prepare-env：单元MainPID与目标进程不一致')
        const rollback = async () => {
          try {
            writeFileSync(plan.fragment, plan.before)
            runCommand('systemctl', ['daemon-reload'], { timeout: activeBudget.remaining(3000) })
            runCommand('systemctl', ['start', unitName], { timeout: activeBudget.remaining(7000) })
          } catch (error) { throw Error('--prepare-env回滚未完成（unit=' + unitName + '）：' + error.message + '；请人工核单元文件 ' + plan.fragment) }
        }
        runCommand('systemctl', ['stop', unitName], { timeout: activeBudget.remaining(30000) })
        if (processFinder(context) || await portOpen(current.port, ['::', '::1'].includes(current.host) ? '::1' : '127.0.0.1', activeBudget.remaining(250))) { await rollback(); throw Error('--prepare-env：停止后目标仍占端口/存活，已回滚') }
        const backup = path.join(evidence, 'unit-' + path.basename(plan.fragment) + '.backup')
        writeFileSync(backup, plan.before)
        try {
          writeFileSync(plan.fragment, rewriteExecStartVmFlag(plan.before))
          runCommand('systemctl', ['daemon-reload'], { timeout: activeBudget.remaining(3000) })
          runCommand('systemctl', ['start', unitName], { timeout: activeBudget.remaining(7000) })
        } catch (error) { await rollback(); throw Error('--prepare-env：补旗标失败已回滚；' + error.message) }
        const expected = [current.argv[0], '--experimental-vm-modules', ...current.argv.slice(1)]
        const until = Date.now() + activeBudget.remaining(8000)
        while (Date.now() < until) {
          const pid = Number(parseSystemdProperties(runCommand('systemctl', ['show', unitName, '-p', 'MainPID'], { timeout: activeBudget.remaining(2000) })).MainPID)
          const item = pid ? processReader(pid, context) : null
          if (item) {
            if (JSON.stringify(item.argv) !== JSON.stringify(expected) || item.cwd !== current.cwd) { await rollback(); throw Error('--prepare-env：重启后argv/身份与预期不符，已回滚') }
            return { changed: true, vmFlag: 'unit-updated', unit: unitName, backup }
          }
          await pause(50)
        }
        await rollback()
        throw Error('--prepare-env：补旗标重启后未取得可确证进程，已回滚')
      }
      // 纯停止态 + 显式单元：改unit但不拉起（保持停止，与既有停止态规则一致）。
      if (op['systemd-unit']) {
        const state = parseSystemdProperties(runCommand('systemctl', ['show', op['systemd-unit'], ...['MainPID', 'ActiveState', 'ExecStart', 'FragmentPath'].flatMap(key => ['-p', key])], { timeout: activeBudget.remaining(2000) }))
        if (Number(state.MainPID) === 0 && state.ActiveState === 'inactive') {
          const plan = await editUnit(op['systemd-unit'])
          if (!plan.changed) return { changed: false, vmFlag: 'already-present' }
          const backup = path.join(evidence, 'unit-' + path.basename(plan.fragment) + '.backup')
          writeFileSync(backup, plan.before)
          try {
            writeFileSync(plan.fragment, rewriteExecStartVmFlag(plan.before))
            runCommand('systemctl', ['daemon-reload'], { timeout: activeBudget.remaining(3000) })
          } catch (error) {
            writeFileSync(plan.fragment, plan.before)
            runCommand('systemctl', ['daemon-reload'], { timeout: activeBudget.remaining(3000) })
            throw Error('--prepare-env：停止态补旗标失败已回滚；' + error.message)
          }
          return { changed: true, vmFlag: 'unit-updated-stopped', unit: op['systemd-unit'], backup }
        }
      }
      return { changed: false, vmFlag: 'stopped-without-managed-unit' }
    },
    async preflight(action, { residual: cleanResidual = false } = {}) {
      assertTargetAllowed(op)
      const pkg = json(path.join(packageRoot, 'package.json'))
      if (pkg.name !== adapter.packageName) throw Error('维护入口与本地包身份不一致')
      // 供应链护栏：零运行时依赖 + vendor 账本齐全（解析器依赖已打进包内）。
      if (!cleanResidual) assertPackageDependencies(pkg, packageRoot)
      for(const peer of cleanResidual ? [] : Object.keys(pkg.peerDependencies||{})){
        const manifest=path.join(op.home,'runtime','lib','node_modules',...peer.split('/'),'package.json')
        if(!existsSync(manifest)||json(manifest).version!=='0.1.5-rc.2')throw Error('既有宿主peer缺失/未适配：'+peer+'；不自动安装第二份宿主')
      }
      prior = profileState(op.profileDir)
      // 只留已有直接依赖的软件清单字节，不备份依赖目录；事后检查未升级其它包。
      originalDependencyBytes=cleanResidual ? {} : Object.fromEntries(Object.keys(prior.deps).filter(name=>name!==adapter.packageName).map(name=>{const p=path.join(op.profileDir,'node_modules',...name.split('/'),'package.json');return [p,existsSync(p)?readFileSync(p):null]}))
      // family含旧三线与新v1/v2：写前阻止旧线/新线共装。
      for (const name of family) if (name !== adapter.packageName && (prior.deps[name] || prior.bundles.includes(name))) throw Error('另一版本线已安装，先用所属包卸载')
      const author = json(path.join(op.app, 'tavern-plugin', 'package.json'))
      if (author.name !== 'dsh-tavern-plugin') throw Error('作者版本未适配')
      if (!cleanResidual && author.version !== AUTHOR_VERSION) {
        // 作者版本变化不再直接拒：用共享**只读计划**判定“契约等价/已施缝同代”（不写盘、不 import 作者）。
        const plan = typeof adapter.inspectStandardSeamsPlan === 'function' ? adapter.inspectStandardSeamsPlan({ appDir: op.app, authorVersion: author.version }) : null
        if (!plan || (plan.ready !== true && plan.compatible?.ok !== true)) throw Error('作者版本未适配且契约不等价：' + author.version)
      }
      const patch = cleanResidual ? '' : readFileSync(path.join(op.profileDir, 'cordis.patch.yml'), 'utf8').replace(/^\s*#.*$/gm, '').trim()
      if (!cleanResidual && patch !== '[]' && patch !== '') throw Error('profile自定义patch非空，请先核冲突；不覆盖用户配置')
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
      if (cleanResidual) {
        if (action !== 'uninstall') throw Error('兜底残留路径仅用于卸载')
        residual = residualAssembly({ home: op.home, profileDir: op.profileDir, packageName: adapter.packageName, evidence })
        driver.wasRunning = !!original
        if (original) { context.port = original.port; context.host = original.host }
        return { noop: false, wasRunning: !!original, assemblyPresent: residual.present }
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
      let withdrawnClean = false
      if (present) {
        if (json(path.join(installed, 'package.json')).name !== adapter.packageName) throw Error('现装包身份错误')
        const { copyPackage, samePackage } = await import('./runner.mjs')
        driver.recoveryPackage = samePackage(packageRoot, realpathSync(installed)) ? packageRoot : path.join(evidence, 'original-package')
        if (driver.recoveryPackage !== packageRoot) copyPackage(realpathSync(installed), driver.recoveryPackage)
        if (action === 'install' && driver.recoveryPackage !== packageRoot) throw Error('现装不同代：现装插件 ' + json(path.join(installed, 'package.json')).version + '，待装插件 ' + pkg.version + '（包字节不一致，非酒馆版本不匹配）；先用本地所属代卸载，不自动升级；现装插件目录：' + realpathSync(installed))
        // 与桌面版同款"退出撤缝态"：宿主正常退出后disposer已撤缝删记录，源码即作者原像。
        if (!existsSync(path.join(op.app, STANDARD_RECORD))) {
          const { sourceAccess, withdrawnCleanState } = await import('./source.mjs')
          if (!withdrawnCleanState(sourceAccess(op.app, adapter.targets))) throw Error('已装包但缺源码恢复记录')
          withdrawnClean = true
        }
      } else if (existsSync(path.join(op.app, STANDARD_RECORD))) throw Error('包不在但接缝在，拒绝认领')
      driver.wasRunning = !!original
      if (original) { context.port = original.port; context.host = original.host }
      // 不运行官方--dump-config，避免构造Host或自动扫描原档。
      return { noop: (action === 'install' ? present : !present) && !withdrawnClean, wasRunning: !!original, ...(withdrawnClean ? { withdrawnClean: true } : {}) }
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
        // 停止给足优雅退出窗口：应用刚启动即被停（--prepare-env 重启后紧接安装）实测要 ~12s；
        // 7s 会把"还在退出中"误判为失败。上限仍受共享预算约束。
        runCommand('systemctl', ['stop', unit.unit], { timeout: activeBudget.remaining(30000) })
        await driver.assertStopped()
      } else {
        process.kill(target.pid, 'SIGTERM'); stopSignalled = true
        await waitExit(target, context, activeBudget.remaining(7000))
      }
    },
    async stoppedAfterError() {
      if (!stopSignalled) return false
      const until = Date.now() + activeBudget.remaining(30000)
      while (Date.now() < until) {
        const item = processReader(original.pid, context)
        if (!item) {
          if (alive(original.pid)) { await pause(100); continue }
          // PID 存活但身份不可读＝大概率仍在退出（实测 SIGTERM 后 /proc 身份字段先失稳）：
          // 继续等到窗口末，不秒抛"身份不符"顶掉真正的初因。
          await driver.assertStopped(); return true
        }
        sameProcess(original, item); await pause(50)
      }
      throw Error('原代停止未完成（PID 仍在退出或身份已变），未写装配/源码，不并起第二进程')
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
        } else runCommand('systemctl', ['stop', unit.unit], { timeout: activeBudget.remaining(30000) })
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
    async manageResidual(action) {
      await driver.assertStopped()
      if (!residual) throw Error('兜底装配未预检')
      return action === 'restore' ? residual.restore() : residual.uninstall()
    },
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
