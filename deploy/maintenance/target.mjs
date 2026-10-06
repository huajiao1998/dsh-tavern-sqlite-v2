// 安装目录/profile识别；只观察配置和程序，不扫描业务目录。
// 宿主判定（2026-10-06 增）：桌面版应用树根有 `.dsh-tavern-local.json`（作者写：{host,dshHome}）；
// 没有该文件即 CLI 版（Linux/macOS/Windows CLI 都是这一形态）。
import { existsSync, readdirSync, readFileSync, realpathSync, lstatSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
const json = file => JSON.parse(readFileSync(file, 'utf8'))
export function options(argv, { cwd = process.cwd(), env = process.env, userHome = os.homedir() } = {}) {
  const out = { action: argv[0] || 'install', profile: 'tavern' }
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]
    if (['--check', '--apply', '--internal', '--background', '--prepare-env'].includes(key)) out[key.slice(2)] = true
    else if (['--home', '--app', '--profile', '--port', '--evidence', '--systemd-unit', '--elapsed', '--report-dir'].includes(key)) {
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
  return { ...out, profileDir, host: local.host, ...(local.host === 'desktop' ? { tavernRoot: local.root, desktopMarker: local.marker } : {}) }
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
  // 桌面布局固定为 <root>/data/harness；用启动器标记复核，不靠猜路径。
  const root = path.dirname(path.dirname(data.dshHome))
  if (path.basename(data.dshHome) !== 'harness' || path.basename(path.dirname(data.dshHome)) !== 'data' || !existsSync(path.join(root, 'launcher-settings.xml'))) {
    throw Error('桌面版目录布局与启动器标记不符，拒绝认领')
  }
  return { host: 'desktop', dshHome: data.dshHome, root, marker }
}

/** 桌面版运行时解析：启动器目录下的 `runtime-*` Electron 应用（不猜、不多选）。 */
function desktopRuntimeFor(op) {
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

export function runtimeFor(op) {
  if (op.host === 'desktop') return desktopRuntimeFor(op)
  const root = path.join(op.home, 'runtime', 'lib', 'node_modules', '@deepseek-ai'), cli = path.join(op.home, 'runtime', 'bin', 'dsh')
  const pkg = json(path.join(root, 'dsh', 'package.json')), boot = json(path.join(root, 'dsh-app-boot', 'package.json'))
  if (pkg.version !== '0.1.5-rc.2' || boot.version !== '0.1.5-rc.2') throw Error('只支持已适配DSH/boot 0.1.5-rc.2，不自动改宿主版本')
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
