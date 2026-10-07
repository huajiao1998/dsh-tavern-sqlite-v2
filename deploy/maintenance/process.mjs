// CLI目标身份；只读进程元数据，不凭端口杀进程，不读会话/账号/日志。
import { readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pause } from './budget.mjs'
export function command(executable, args, { cwd, env, timeout = 5000, allowAbsent = false } = {}) {
  const result = spawnSync(executable, args, { cwd, env, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  if (result.error) throw result.error
  if(allowAbsent && result.status===1 && !result.stdout.trim() && !result.stderr.trim())return ''
  if (result.status !== 0) throw new Error('只读/管理命令失败：' + path.basename(executable))
  return result.stdout
}
export function stripSecrets(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('DSH_TAVERN_MAINTENANCE_')))
}
export function parseEnvironment(text) {
  const matches = [...text.matchAll(/(?:^| )([A-Za-z_][A-Za-z_0-9]*)=/g)], result = {}
  for (let i = 0; i < matches.length; i++) {
    const hit = matches[i], begin = hit.index + hit[0].length, end = i + 1 < matches.length ? matches[i + 1].index : text.length
    result[hit[1]] = text.slice(begin, end)
  }
  return result
}
export function invocation(argv, target) {
  const index = argv.findIndex((arg, i) => i > 0 && target.cliEntries.includes(arg))
  if (index < 1) return null
  const args = argv.slice(index + 1), found = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-open') { if (found.noOpen) throw Error('重复启动参数'); found.noOpen = true; continue }
    if (!['--profile', '--host', '--port'].includes(args[i]) || !args[i + 1] || found[args[i]]) throw Error('不支持的启动参数，拒绝猜测恢复')
    found[args[i]] = args[++i]
  }
  if (found['--profile'] !== target.profile) return null
  if (!found.noOpen || !['127.0.0.1', '0.0.0.0', '::1', '::'].includes(found['--host']) || !/^\d+$/.test(found['--port'] || '') || Number(found['--port']) < 1 || Number(found['--port']) > 65535) throw Error('目标host/port/no-open参数不完整')
  if (target.port && Number(target.port) !== Number(found['--port'])) throw Error('显式端口与目标进程不一致')
  if (argv.slice(1, index).some(arg => arg !== '--experimental-vm-modules')) throw Error('未知Node启动参数，拒绝改变启动方式')
  return { port: Number(found['--port']), host: found['--host'] }
}
export function sameProcess(a, b) {
  if (!b || a.pid !== b.pid || a.start !== b.start || a.cwd !== b.cwd || JSON.stringify(a.argv) !== JSON.stringify(b.argv)) throw Error('目标进程身份/代次已变化，拒绝停启')
}
function linuxArguments(pid) {
  return readFileSync('/proc/' + pid + '/cmdline').toString('utf8').split('\0').filter(Boolean)
}
export function darwinArgumentsFromText(text, target) {
  const entry = target.cliEntries.find(item => text.includes(' ' + item + ' --'))
  if (!entry) return null
  const at = text.indexOf(' ' + entry + ' --'), before = text.slice(0, at)
  const flag = ' --experimental-vm-modules', executable = before.endsWith(flag) ? before.slice(0, -flag.length) : before
  return [executable, ...(before.endsWith(flag) ? ['--experimental-vm-modules'] : []), entry, ...text.slice(at + entry.length + 2).split(/\s+/)]
}
function darwinArguments(pid, target) {
  return darwinArgumentsFromText(command('ps', ['-ww', '-p', String(pid), '-o', 'command='],{allowAbsent:true}).trim(), target)
}
export function readProcess(pid, target, platform = process.platform) {
  try {
    const argv = platform === 'linux' ? linuxArguments(pid) : darwinArguments(pid, target)
    if (!argv) return null
    const launch = invocation(argv, target)
    if (!launch) return null
    let env, cwd, start, cgroup = ''
    if (platform === 'linux') {
      env = Object.fromEntries(readFileSync('/proc/' + pid + '/environ').toString('utf8').split('\0').filter(s => s.includes('=')).map(s => { const at = s.indexOf('='); return [s.slice(0, at), s.slice(at + 1)] }))
      cwd = realpathSync('/proc/' + pid + '/cwd')
      const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
      start = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]
      cgroup = readFileSync('/proc/' + pid + '/cgroup', 'utf8')
      if (realpathSync('/proc/' + pid + '/exe') !== realpathSync(argv[0])) throw Error('Node实际可执行文件不匹配')
    } else {
      const full = command('ps', ['eww', '-p', String(pid), '-o', 'command=']).trim(), prefix = argv.join(' ')
      if (!full.startsWith(prefix + ' ')) throw Error('macOS进程环境不可完整确认')
      env = parseEnvironment(full.slice(prefix.length + 1))
      const files = command('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).split('\n').filter(s => s.startsWith('n'))
      if (files.length !== 1) throw Error('macOS进程cwd不唯一')
      cwd = realpathSync(files[0].slice(1))
      start = command('ps', ['-p', String(pid), '-o', 'lstart=']).trim()
      // launchd拥有的目标不能以直接CLI方式旁路重启；要求先从管理器停止。
      const parent = command('ps', ['-p', String(pid), '-o', 'ppid=']).trim()
      if (parent === '1' && command('launchctl', ['list']).split('\n').some(line => line.trim().startsWith(pid + '\t'))) throw Error('launchd管理实例请先通过原任务停止，再安装；不旁路启动')
    }
    if (cwd !== target.app || env.DSH_HOME !== target.home || !env.PATH || !start) throw Error('进程cwd/home/PATH/代次不匹配，拒绝认领')
    return { pid: Number(pid), argv, env: stripSecrets(env), cwd, start, cgroup, ...launch }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null
    throw error
  }
}
export function findProcess(target, platform = process.platform) {
  const found = []
  const rows = command('ps', ['-ww', '-axo', platform === 'linux' ? 'pid=,args=' : 'pid=,command=']).split('\n').map(line => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
  const pids = rows.filter(row => target.cliEntries.some(entry => row[2].includes(' ' + entry + ' --'))).map(row => row[1])
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue
    let argv
    try { argv = platform === 'linux' ? linuxArguments(pid) : darwinArgumentsFromText(rows.find(row => row[1] === pid)[2], target) }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error }
    if (!argv || !argv.some(arg => target.cliEntries.includes(arg))) continue
    const launch = invocation(argv, { ...target, port: undefined })
    if (!launch) continue
    // 相同runtime/profile却不同home/cwd也拒绝，不把模糊身份当作停止态。
    const item = readProcess(Number(pid), target, platform)
    if(!item && processAlive(Number(pid)))throw Error('候选PID仍存在但完整身份不可确认，拒绝认作停止态')
    if (item) found.push(item)
  }
  if (found.length > 1) throw Error('目标home/profile有多个进程，拒绝自动维护')
  return found[0] || null
}
export function processAlive(pid) {
  try { process.kill(pid,0);return true } catch(error) { if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error }
}

/**
 * Windows 进程清单（只读）：`/proc` 与 `ps` 在 Windows 都不可用，改用 CIM 读
 * pid/可执行路径/命令行。**只用于"目标酒馆是否在跑"的存在性判定**——Windows 拿不到
 * 目标进程的 cwd 与环境，因此这里不参与身份认领（认领仍只在 POSIX 路径做）。
 *
 * 编码护栏：Windows PowerShell 5.1 重定向输出默认走控制台代码页（中文系统＝GBK），
 * 路径含非 ASCII 字符时会乱码 ⇒ 按路径匹配会**假阴性**（把运行中的酒馆判成停止），
 * 这正是存在性判定要防的事故。因此在命令内先把输出钉死为 UTF-8。
 */
export function windowsProcessList() {
  const script = '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  const text = command('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 })
  const raw = JSON.parse(text.trim() || '[]')
  return (Array.isArray(raw) ? raw : [raw]).map(item => ({
    pid: Number(item.ProcessId),
    exe: String(item.ExecutablePath || ''),
    argv: String(item.CommandLine || ''),
  })).filter(item => Number.isInteger(item.pid) && item.pid > 0)
}

/** 命令行分词：只在引号外按空白切；引号内的中文/空格路径不被截断（`\"` 视作字面引号）。 */
function windowsCliArgvTokens(text) {
  const tokens = []
  let current = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\' && text[i + 1] === '"') { current += '"'; i++; continue }
    if (ch === '"') { quoted = !quoted; continue }
    if (!quoted && /\s/.test(ch)) { if (current) { tokens.push(current); current = '' } continue }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

/** 绝对路径判定（含 Windows 盘符/UNC，跨平台一致；POSIX 上 `C:\…` 也算绝对）。 */
function isAbsolutePath(value) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)
}

/**
 * Windows CLI 专用只读进程清单：**只列 `Name='node.exe'`**，只取 pid/exe/CommandLine。
 * 与 `windowsProcessList`（列全部进程）分开，避免为一次存在性判定拖回整机进程表。
 * UTF-8 输出、5 秒超时（`command` 默认 timeout=5000、encoding='utf8'）：中文/空格路径若按 GBK
 * 解出乱码，路径匹配会**假阴性**（把运行中的酒馆判成停止），所以命令内先钉死 UTF-8。
 * 查询失败、输出不可解析、任意 node 候选缺关键身份（exe/CommandLine）→ 抛错 fail closed。
 * `run` 只作纯夹具注入点（默认仍走同一条 `command` 只读通道）。
 */
export function windowsCliProcessList({ run = command } = {}) {
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
  const text = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 })
  let raw
  try { raw = JSON.parse(String(text).replace(/^\uFEFF/, '').trim() || '[]') } catch (error) { throw Error('Windows CLI 进程清单输出不可解析：' + (error && error.message)) }
  const rows = (Array.isArray(raw) ? raw : [raw]).map(item => ({
    pid: Number(item?.ProcessId),
    exe: item?.ExecutablePath == null ? '' : String(item.ExecutablePath).trim(),
    argv: item?.CommandLine == null ? '' : String(item.CommandLine).trim(),
  }))
  // 损坏行**不得被 filter 掉**：滤空之后的空清单会被上层读成"酒馆已停止"（假阴性），一律 fail closed。
  if (rows.some(item => !Number.isInteger(item.pid) || item.pid <= 0)) throw Error('Windows CLI 进程清单含无 PID 的行，拒绝认作停止态')
  if (rows.some(item => !item.exe || !item.argv)) throw Error('Windows node 候选缺少关键身份（exe/CommandLine），拒绝认作停止态')
  return rows
}

/**
 * Windows CLI 酒馆是否在运行（**只存在性，不认领**）：Windows 拿不到目标进程的 cwd/环境，
 * 故不 claim cwd/env、不杀不启。官方 WinCLI **没有私有 runtime/node.exe**，它由 system PATH 的
 * `node`（如 `D:\Program Files (x86)\nodejs\node.exe`）启动，所以**不按 exe 路径限制**，只要求启动器
 * 是 node.exe，身份由命令行里的**完整绝对 SDK JS 入口参数**决定（按 token 词边界比对，不按路径包含）。
 *   · 目标 CLI 在跑（任一份入口：pnpm 词法别名或 physical）→ 返回（`{ pid, exe, argv }`）；
 *   · 候选 exe/命令行不完整 → 抛错；相对 SDK 入口（`node lib/bin.js --profile tavern`）无法归属 → 抛错；
 *   · 明确无关的 node 脚本（别的绝对 JS 脚本、不含该入口）→ 跳过，不误判成酒馆。
 */
export function windowsCliTavernProcesses(context, { list = windowsCliProcessList } = {}) {
  const home = context?.home, windowsCli = context?.windowsCli
  const entries = (windowsCli?.cliEntries?.length ? windowsCli.cliEntries : [windowsCli?.cliEntry]).filter(value => typeof value === 'string' && path.isAbsolute(value))
  if (!home || entries.length === 0) throw Error('Windows CLI 目标缺少私有 home/入口，拒绝认领')
  const normalize = value => String(value).replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase()
  const wanted = new Set(entries.map(normalize))
  const binRelative = normalize(windowsCli?.binRelative || path.basename(entries[0])).replace(/^\\+/, '')
  const profile = String(context?.profile || 'tavern')
  const found = [], problems = [], ambiguous = []
  for (const item of list()) {
    if (!item || !Number.isInteger(item.pid) || item.pid <= 0) { problems.push('进程清单含无 PID 的 node 候选'); continue }
    const exe = String(item.exe || '').trim(), argv = String(item.argv || '').trim()
    if (!exe || !argv) { problems.push('PID ' + item.pid + ' 的 node 候选缺少 exe/命令行'); continue }
    if (normalize(exe).split('\\').pop() !== 'node.exe') continue
    const tokens = windowsCliArgvTokens(argv)
    // 词边界：整 token 等于入口才算命中（`<entry>fake.js`、别处同名 bin.js 都不算）。
    if (tokens.some(token => wanted.has(normalize(token)))) { found.push({ pid: item.pid, exe, argv }); continue }
    // 相对入口无法归属：可能是同一套私有 SDK 的另一条启动路径，绝不能当"不误命中"的停止态。
    const shaped = tokens.some((token, i) => token === '--profile' && tokens[i + 1] === profile)
    const relative = tokens.find(token => {
      if (isAbsolutePath(token) || token.startsWith('-') || !/\.(?:mjs|cjs|js)$/i.test(token)) return false
      const value = normalize(token)
      return shaped || value === binRelative || value.endsWith('\\' + binRelative)
    })
    if (relative) ambiguous.push('PID ' + item.pid + ' → ' + relative)
  }
  if (ambiguous.length) throw Error('Windows CLI 候选的相对入口无法归属私有 runtime，拒绝认作停止态：' + ambiguous.join('；'))
  if (problems.length) throw Error('Windows CLI 进程身份不可确证，拒绝认作停止态：' + problems.join('；'))
  return found
}

/**
 * 桌面版酒馆是否在运行：匹配**启动器**与**该运行时目录下的可执行文件**。
 * 必须按完整路径比较——用户机器上可能同时装着独立版 `DSH Desktop`（同名进程）。
 */
export function desktopTavernProcesses({ root, runtimeDir }, { list = windowsProcessList } = {}) {
  const dirs = [root, runtimeDir].filter(Boolean).map(value => String(value).replace(/[\\/]+$/, '').toLowerCase())
  return list().filter(item => {
    const exe = item.exe.toLowerCase()
    return exe && dirs.some(dir => exe.startsWith(dir + '\\'))
  })
}
export async function waitExit(target, context, timeout = 7000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const item = readProcess(target.pid, context)
    if (!item) { if(!processAlive(target.pid))return;throw Error('目标PID仍活着但已不匹配，不能认为已退出') }
    sameProcess(target, item)
    await pause(50)
  }
  throw Error('原进程未在停止边界退出；未写包或源码，不强杀')
}
