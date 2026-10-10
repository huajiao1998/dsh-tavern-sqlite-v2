// 安装目录/profile识别；只观察配置和程序，不扫描业务目录。
// 宿主判定（2026-10-06 增）：桌面版应用树根有 `.dsh-tavern-local.json`（作者写：{host,dshHome}）；
// 没有该文件即 CLI 版（Linux/macOS/Windows CLI 都是这一形态）。
// Windows CLI（2026-10-07 增）：官方 WinCLI 是私有 home/runtime（node_modules 在 runtime 根下，
// 启动器 runtime/dsh.cmd，真实入口 runtime/node_modules/@deepseek-ai/dsh/lib/bin.js）——与 POSIX
// 的 home/runtime/lib/node_modules 布局不同，故单独一支；POSIX 分支一行未改。
import { existsSync, readdirSync, readFileSync, realpathSync, lstatSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
const json = file => JSON.parse(readFileSync(file, 'utf8'))
export function options(argv, { cwd = process.cwd(), env = process.env, userHome = os.homedir() } = {}) {
  const out = { action: argv[0] || 'install', profile: 'tavern' }
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]
    if (['--check', '--apply', '--internal', '--background', '--prepare-env'].includes(key)) out[key.slice(2)] = true
    else if (['--home', '--app', '--desktop-app', '--profile', '--port', '--evidence', '--systemd-unit', '--elapsed', '--report-dir'].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('参数缺值：' + key)
      out[key.slice(2)] = argv[++i]
    } else throw Error('未知参数：' + key)
  }
  if (!['install', 'uninstall'].includes(out.action)) throw Error('动作须为install或uninstall')
  if (out['prepare-env'] && out.action !== 'install') throw Error('--prepare-env 仅用于 install（卸载不修环境）')
  if (out.apply && out.check) throw Error('--apply与--check互斥')
  if (!out.check) out.apply = true
  if (out.profile !== 'tavern') throw Error('当前插件接缝仅适配tavern profile；不冒称其它profile支持')
  if (out.port !== undefined && (!/^\d+$/.test(out.port) || Number(out.port) < 1 || Number(out.port) > 65535)) throw Error('端口不合法')
  if (out['systemd-unit'] && !/^[A-Za-z0-9_.@-]+\.service$/.test(out['systemd-unit'])) throw Error('systemd单元名不合法')
  if (out.elapsed !== undefined && (!Number.isFinite(Number(out.elapsed)) || Number(out.elapsed) < 0)) throw Error('计时参数不合法')
  const candidates = out.home ? [path.resolve(cwd, out.home)] : [...new Set([
    env.DSH_TAVERN_CLI_HOME, env.DSH_HOME, cwd, path.join(userHome, '.dsh-tavern'),
  ].filter(Boolean).map(p => path.resolve(cwd, p)))].filter(p => existsSync(path.join(p, 'profiles', out.profile, 'package.json')))
  if (candidates.length !== 1) throw Error(candidates.length ? '发现多个安装目录，请显式--home选择一个；不猜实例' : '未找到已有酒馆，请指定--home；不自动安装第二套酒馆')
  out.home = candidates[0]
  const profileDir = path.join(out.home, 'profiles', out.profile), linked = path.join(profileDir, 'node_modules', 'dsh-tavern-plugin')
  if (!existsSync(linked)) throw Error('目标profile未安装作者酒馆包')
  const authorRoot = realpathSync(linked)
  if (path.basename(authorRoot) !== 'tavern-plugin') throw Error('不支持的作者安装布局')
  out.app = out.app ? path.resolve(cwd, out.app) : path.dirname(authorRoot)
  if (path.join(out.app, 'tavern-plugin') !== authorRoot) throw Error('--app与profile实际作者包不一致')
  for (const root of [out.home, out.app, profileDir]) {
    if (!existsSync(root) || lstatSync(root).isSymbolicLink() || realpathSync(root) !== root) throw Error('目标根目录需存在且无符号链接')
  }
  // 宿主判定：作者在应用树根写 `.dsh-tavern-local.json`（桌面版）；CLI 版没有该文件。
  const local = tavernHost(out.app)
  if (local.host === 'desktop' && path.resolve(local.dshHome) !== out.home) {
    throw Error('桌面版宿主标记的 dshHome 与实际安装目录不一致，拒绝认领')
  }
  if (out['desktop-app']) {
    if (local.host !== 'desktop' || local.desktopLayout !== 'embedded') throw Error('--desktop-app 仅用于嵌入式桌面版；不能替换独立启动器运行时或认领 CLI')
    out['desktop-app'] = path.resolve(cwd, out['desktop-app'])
  }
  if (local.desktopLayout === 'embedded' && !out['desktop-app']) throw Error('嵌入式桌面版必须显式指定 --desktop-app <DSH Desktop 安装根目录>；不猜宿主')
  return { ...out, profileDir, host: local.host, ...(local.host === 'desktop' ? { tavernRoot: local.root, desktopMarker: local.marker, desktopLayout: local.desktopLayout } : {}) }
}

/**
 * 宿主判定（只看作者写的标记，不猜环境）：
 *   · 应用树根有 `.dsh-tavern-local.json` ⇒ `host:'desktop'`（Electron 桌面版），并校验 dshHome；
 *   · 没有 ⇒ `host:'cli'`（Linux/macOS/Windows CLI 版，现状路径）。
 */
export function tavernHost(appRoot) {
  const marker = path.join(appRoot, '.dsh-tavern-local.json')
  if (!existsSync(marker)) return { host: 'cli' }
  let data
  try { data = json(marker) } catch (error) { throw Error('桌面版宿主标记无法解析：' + (error && error.message)) }
  if (data?.host !== 'desktop') return { host: 'cli' }
  if (typeof data.dshHome !== 'string' || !path.isAbsolute(data.dshHome)) throw Error('桌面版宿主标记缺少合法 dshHome')
  const dshHome = path.resolve(data.dshHome), root = path.dirname(path.dirname(dshHome))
  // 已有独立launcher的损坏不能以“embedded”放行；两种布局有各自的证明。
  if (path.basename(dshHome) === 'harness' && path.basename(path.dirname(dshHome)) === 'data') {
    if (!existsSync(path.join(root, 'launcher-settings.xml'))) throw Error('桌面版目录布局与启动器标记不符，拒绝认领')
    return { host: 'desktop', dshHome, root, marker, desktopLayout: 'launcher' }
  }
  const profile = path.join(dshHome, 'profiles', 'tavern'), linked = path.join(profile, 'node_modules', 'dsh-tavern-plugin')
  if (!existsSync(dshHome) || lstatSync(dshHome).isSymbolicLink() || realpathSync(dshHome) !== dshHome ||
      !existsSync(path.join(profile, 'package.json')) || !existsSync(linked) || realpathSync(linked) !== path.join(appRoot, 'tavern-plugin')) {
    throw Error('嵌入式桌面版标记、home/profile 与作者包实际链接不一致，拒绝认领')
  }
  return { host: 'desktop', dshHome, marker, desktopLayout: 'embedded' }
}

/** 桌面版运行时解析：启动器目录下的 `runtime-*` Electron 应用（不猜、不多选）。 */
function desktopRuntimeFor(op) {
  if (op.desktopLayout === 'embedded') return embeddedDesktopRuntimeFor(op)
  const root = op.tavernRoot
  if (!root) throw Error('桌面版宿主缺少启动器根目录，拒绝继续')
  const candidates = readdirSync(root).filter(name => name.startsWith('runtime-')).map(name => {
    const dir = path.join(root, name), exe = ['DSH Desktop.exe', 'DSH Tavern.exe'].map(file => path.join(dir, file)).find(existsSync)
    const appDir = path.join(dir, 'resources', 'app'), manifest = path.join(appDir, 'package.json')
    return exe && existsSync(path.join(appDir, 'lib', 'desktop-cli.js')) && existsSync(manifest) ? { dir, exe, appDir, manifest } : null
  }).filter(Boolean)
  if (candidates.length === 0) throw Error('桌面版未找到可用运行时（runtime-*/resources/app/lib/desktop-cli.js）；拒绝猜测安装方式')
  candidates.sort((a, b) => statSync(b.dir).mtimeMs - statSync(a.dir).mtimeMs)
  if (candidates.length > 1) {
    // 多个运行时=升级残留：不作弊挑一个，要求用户先清理（保持"不猜实例"的既有护栏）。
    throw Error(`桌面版存在多个运行时目录（${candidates.length} 个），拒绝猜测当前代；请删除旧 runtime-* 后重试`)
  }
  const [{ exe, appDir, manifest }] = candidates
  const app = json(manifest)
  // Electron 版本来自该应用自己的 peerDependencies.electron（桌面版据此构造 npm_config_target）。
  const electronRange = String(app.peerDependencies?.electron || app.devDependencies?.electron || '')
  const electronVersion = /(\d+\.\d+\.\d+)/.exec(electronRange)?.[1]
  if (!electronVersion) throw Error('桌面版运行时未声明 Electron 版本，无法构造官方装包环境')
  // 基址是 node_modules（与 CLI 路径一致）：peer 名自带作用域，调用方用 ...peer.split('/') 拼接。
  const peerRoot = path.join(appDir, 'node_modules')
  if (!existsSync(peerRoot)) throw Error('桌面版运行时缺少 @deepseek-ai 依赖根，拒绝继续')
  const require = createRequire(manifest)
  const atomicUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href
  return {
    cli: null,
    cliEntries: [],              // 桌面版不做进程身份认领（无 argv/cwd 可核），只做存在性判定
    atomicUrl,
    host: 'desktop',
    desktop: { exe, appDir, bootstrap: path.join(appDir, 'lib', 'desktop-cli.js'), electronVersion, peerRoot, root: candidates[0].dir },
  }
}

// 独立安装的共享Desktop：只认显式程序树；不扫描注册表、磁盘或猜当前代。
function embeddedDesktopRuntimeFor(op) {
  const root = op['desktop-app']
  if (!root || !path.isAbsolute(root)) throw Error('嵌入式桌面版缺少明确的 --desktop-app')
  const appDir = path.join(root, 'resources', 'app'), peerRoot = path.join(appDir, 'node_modules')
  for (const dir of [root, appDir, peerRoot]) {
    if (!existsSync(dir) || !lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir) {
      throw Error('嵌入式宿主程序目录需完整、真实且无符号链接：' + dir)
    }
  }
  const exe = path.join(root, 'DSH Desktop.exe'), manifest = path.join(appDir, 'package.json'), bootstrap = path.join(appDir, 'lib', 'desktop-cli.js')
  for (const file of [exe, manifest, bootstrap]) {
    if (!existsSync(file) || !lstatSync(file).isFile() || realpathSync(file) !== file) throw Error('嵌入式宿主缺少真实程序文件：' + file)
  }
  const app = json(manifest)
  if (app.name !== 'dsh-plugin-desktop') throw Error('指定宿主不是 dsh-plugin-desktop，拒绝认领')
  // 和当前CLI/桌面driver同一固定适配版本，绝不因manifest宽范围放行未验peer。
  const names = ['dsh', 'dsh-app-boot', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-session-query']
  const require = createRequire(manifest)
  const ownModule = peer => {
    const dir = path.join(peerRoot, ...peer.split('/'))
    if (!existsSync(path.join(dir, 'package.json'))) throw Error('嵌入式宿主本地模块缺失：' + peer)
    const entry = realpathSync(require.resolve(peer))
    if (!entry.startsWith(realpathSync(dir) + path.sep)) throw Error('嵌入式宿主模块解析到另一副本：' + peer)
    return entry
  }
  if (op.action !== 'uninstall') for (const name of names) {
    const peer = '@deepseek-ai/' + name, file = path.join(peerRoot, ...peer.split('/'), 'package.json')
    if (!existsSync(file) || json(file).name !== peer || json(file).version !== '0.1.5-rc.2') throw Error('嵌入式宿主peer缺失/未适配：' + peer + '；不安装第二份宿主')
    // CLI包以bin启动，没有默认main；只对可导入的boot/插件peer核入口。
    if (name !== 'dsh') ownModule(peer)
    else if (!existsSync(path.join(peerRoot, ...peer.split('/'), 'lib', 'bin.js'))) throw Error('嵌入式宿主CLI入口缺失：' + peer)
  }
  const electronRange = String(app.peerDependencies?.electron || app.devDependencies?.electron || '')
  const electronVersion = /^(?:\^|~)?(\d+\.\d+\.\d+)$/.exec(electronRange)?.[1]
  if (!electronVersion) throw Error('嵌入式宿主 Electron 声明无法明确解析，拒绝猜测')
  const atomicUrl = pathToFileURL(ownModule('@deepseek-ai/dsh-atomic-write')).href
  return { cli: null, cliEntries: [], atomicUrl, host: 'desktop',
    desktop: { exe, appDir, bootstrap, electronVersion, peerRoot, root } }
}

/**
 * 官方 Windows CLI 运行时（私有 home/runtime；独占新增，不接管桌面版也不动 POSIX 分支）：
 *   root=appDir=home/runtime，peerRoot=home/runtime/node_modules，cli=**真实 JS 入口**（不是 dsh.cmd）。
 * 返回 `cli` 为真实 JS 入口供目标身份核对，cmd 包装器不能被当 JS 执行；标准目录装配不调用 plugin add/remove。
 * 安装核 SDK/boot 与导入 peer 的版本，并要求解析到的 entry 就是**本地 physical 副本**（允许正规
 * pnpm 链接，拒绝经祖先 node_modules 补缺）；uninstall 只要求私有 SDK bin 与同一把原子锁（不核 peer）。
 * 注意：官方 WinCLI **没有私有 runtime/node.exe**，它用 system PATH 的 node 启动（见 process.mjs 存在性判定）。
 */
export function windowsCliRuntimeFor(op) {
  const home = existsSync(op.home) ? realpathSync(op.home) : path.resolve(String(op.home))
  // CLI 私有 SDK 与作者树必须属于同一个 home；不能用 A 的运行检查去改 B 的作者程序。
  if (op.app) {
    const app = realpathSync(op.app)
    if (!app.startsWith(home + path.sep)) throw Error('Windows CLI 作者程序不属于当前 home，拒绝跨实例维护')
    const marker = path.join(app, '.dsh-tavern-local.json')
    if (existsSync(marker)) {
      const local = json(marker)
      if (local.host !== 'cli' || typeof local.dshHome !== 'string' || !path.isAbsolute(local.dshHome) || path.resolve(local.dshHome) !== home) {
        throw Error('Windows CLI 作者标记与当前 home 不一致，拒绝跨实例维护')
      }
    }
  }
  const root = path.join(home, 'runtime'), peerRoot = path.join(root, 'node_modules')
  if (!existsSync(peerRoot) || !lstatSync(peerRoot).isDirectory()) throw Error('Windows CLI 缺少私有 runtime/node_modules，拒绝认领')
  // runtime 与 node_modules 必须是 home 内的**真实目录**：符号链接会把判据引到 home 之外的任意副本。
  for (const [dir, label] of [[root, 'runtime'], [peerRoot, 'runtime/node_modules']]) {
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir || !dir.startsWith(home + path.sep)) {
      throw Error('Windows CLI 私有 ' + label + ' 须为 home 内真实目录（不得符号链接越出）：' + dir)
    }
  }
  const anchor = path.join(peerRoot, '@deepseek-ai', 'dsh', 'package.json')
  if (!existsSync(anchor)) throw Error('Windows CLI 缺少 runtime 内 dsh 包，拒绝认领')
  const require = createRequire(anchor)
  // 真实入口：只认 dsh 包自己声明的 bin，且必须落在包根内（拒 ../ 越界与包外文件）。
  const manifest = json(anchor), bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof bin !== 'string' || !bin.trim()) throw Error('Windows CLI 的 dsh 包未声明 bin 入口，拒绝猜测')
  const pkgDir = path.join(peerRoot, '@deepseek-ai', 'dsh')
  if (!existsSync(pkgDir)) throw Error('Windows CLI 缺少 runtime 内 dsh 包目录，拒绝认领')
  const physicalRoot = realpathSync(peerRoot), physicalPkg = realpathSync(pkgDir)
  // dsh 包的 physical 副本必须来自**私有 peerRoot**（pnpm 的 .pnpm 内部链接允许，越出即拒绝）。
  if (!physicalPkg.startsWith(physicalRoot + path.sep)) throw Error('Windows CLI 的 dsh 包解析到私有 runtime 之外的副本，拒绝认领')
  // pnpm 链接下 argv 里出现的是**词法别名**（peerRoot 内的链接路径），进程身份核的是 physical 副本：
  // 两个都留。别名与 physical 不是同一个字符串，去重不能把别名丢掉（真机曾因只留 physical 而假阴性）。
  const lexical = path.resolve(pkgDir, bin), entry = path.resolve(physicalPkg, bin)
  if (!entry.startsWith(physicalPkg + path.sep)) throw Error('Windows CLI 的 dsh bin 越出包根，拒绝认领：' + bin)
  if (!/\.(?:mjs|cjs|js)$/i.test(bin)) throw Error('Windows CLI 入口不是 JS 文件，拒绝认领：' + bin)
  for (const file of new Set([lexical, entry])) {
    if (!existsSync(file) || !lstatSync(file).isFile()) throw Error('Windows CLI 入口不是真实 JS 文件，拒绝认领：' + file)
  }
  // 别名必须真的指向同一个 physical 入口（Win 上路径大小写不敏感，按平台语义比对）。
  const aliasReal = realpathSync(lexical), sameEntry = process.platform === 'win32' ? aliasReal.toLowerCase() === entry.toLowerCase() : aliasReal === entry
  if (!sameEntry) throw Error('Windows CLI 入口别名与 physical 副本不一致，拒绝认领：' + bin)
  const cliEntries = [...new Set([lexical, entry])]
  // 导入 peer：安装核存在/身份/入口/版本；卸载不核 peer——卸载只需要能跑 SDK bin 与同一把原子锁。
  const imported = ['dsh-app-boot', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-session-query']
  if (op.action !== 'uninstall') for (const name of imported) {
    const peer = '@deepseek-ai/' + name, dir = path.join(peerRoot, ...peer.split('/')), file = path.join(dir, 'package.json')
    if (!existsSync(file)) throw Error('Windows CLI 缺少宿主 peer：' + peer)
    const data = json(file)
    if (data.name !== peer) throw Error('Windows CLI 宿主 peer 身份不符：' + peer)
    if (data.version !== '0.1.5-rc.2') throw Error('既有宿主peer缺失/未适配：' + peer + '；不自动安装第二份宿主')
    let resolved
    try { resolved = realpathSync(require.resolve(peer)) } catch { throw Error('Windows CLI 宿主 peer 入口不可解析：' + peer) }
    const local = realpathSync(dir)
    if (!resolved.startsWith(local + path.sep) || !local.startsWith(physicalRoot + path.sep)) {
      throw Error('Windows CLI 宿主 peer 解析到另一副本（借祖先 node_modules 补缺）：' + peer)
    }
  }
  const sdk = json(anchor)
  if (sdk.name !== '@deepseek-ai/dsh') throw Error('Windows CLI 的 dsh 包身份不符，拒绝认领')
  if (op.action !== 'uninstall' && sdk.version !== '0.1.5-rc.2') throw Error('只支持已适配DSH/boot 0.1.5-rc.2，不自动改宿主版本')
  // 原子锁仍取**同一份本地副本**（uninstall 也要求），保证与安装同一把维护锁：
  // 必须来自 peerRoot 内 @deepseek-ai/dsh-atomic-write 的 physical 副本，且解析出的入口是该副本内的**真实文件**
  // （否则任意其它包的入口都能冒充这把锁）。
  const atomicDir = path.join(peerRoot, '@deepseek-ai', 'dsh-atomic-write'), atomicManifest = path.join(atomicDir, 'package.json')
  if (!existsSync(atomicManifest)) throw Error('Windows CLI 缺少原子锁模块 @deepseek-ai/dsh-atomic-write')
  const atomicPkg = json(atomicManifest)
  if (atomicPkg.name !== '@deepseek-ai/dsh-atomic-write') throw Error('Windows CLI 原子锁包身份不符：' + String(atomicPkg.name))
  if (op.action !== 'uninstall' && atomicPkg.version !== '0.1.5-rc.2') throw Error('既有宿主peer缺失/未适配：@deepseek-ai/dsh-atomic-write；不自动安装第二份宿主')
  let atomicUrl
  try { atomicUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href } catch { throw Error('Windows CLI 缺少原子锁模块 @deepseek-ai/dsh-atomic-write') }
  const atomic = fileURLToPath(atomicUrl), physicalAtomic = realpathSync(atomicDir)
  if (!physicalAtomic.startsWith(physicalRoot + path.sep)) throw Error('Windows CLI 原子锁解析到另一副本，拒绝认领')
  if (!existsSync(atomic) || !lstatSync(atomic).isFile() || !realpathSync(atomic).startsWith(physicalAtomic + path.sep)) {
    throw Error('Windows CLI 原子锁入口不是本副本内的真实文件，拒绝认领：' + atomic)
  }
  return { cli: entry, cliEntries, atomicUrl, host: 'cli',
    windowsCli: { root, appDir: root, peerRoot, cliEntry: entry, cliEntries, binRelative: bin } }
}

/** `platform` 只为纯夹具 Win 测试可注入；非 Win 原分支一行未改。 */
export function runtimeFor(op, { platform = process.platform } = {}) {
  if (op.host === 'desktop') return desktopRuntimeFor(op)
  if (platform === 'win32') return windowsCliRuntimeFor(op)
  const root = path.join(op.home, 'runtime', 'lib', 'node_modules', '@deepseek-ai'), cli = path.join(op.home, 'runtime', 'bin', 'dsh')
  const pkg = json(path.join(root, 'dsh', 'package.json')), boot = json(path.join(root, 'dsh-app-boot', 'package.json'))
  if (op.action !== 'uninstall' && (pkg.version !== '0.1.5-rc.2' || boot.version !== '0.1.5-rc.2')) throw Error('只支持已适配DSH/boot 0.1.5-rc.2，不自动改宿主版本')
  const entry = realpathSync(cli), anchor = path.join(root, 'dsh', 'package.json'), require = createRequire(anchor)
  // 复用运行时已有维护文件锁，非数据库锁；无需flock或新增npm依赖。
  const atomicUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href
  return { cli, cliEntries: [cli, entry], atomicUrl }
}
export function assertTargetAllowed(op) {
  // 本项目测试机独立禁令仍在：公开使用不默认选择这个home或该端口。
  if (op.home === '/root/.dsh' || Number(op.port) === 3080) throw Error('项目禁碰实例，写前拒绝')
}
export const packagePolicyArgs = () => ['--offline', '--ignore-scripts', '--config.auto-install-peers=false']
