// 安装目录/profile识别；只观察配置和程序，不扫描业务目录。
import { existsSync, readFileSync, realpathSync, lstatSync } from 'node:fs'
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
    else if (['--home', '--app', '--profile', '--port', '--evidence', '--systemd-unit', '--elapsed'].includes(key)) {
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
  return { ...out, profileDir }
}
export function runtimeFor(op) {
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
