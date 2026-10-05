// CLI目标身份；只读进程元数据，不凭端口杀进程，不读会话/账号/日志。
import { readFileSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pause } from './budget.mjs'
export function command(executable, args, { cwd, env, timeout = 5000, allowAbsent = false } = {}) {
  const result = spawnSync(executable, args, { cwd, env, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
