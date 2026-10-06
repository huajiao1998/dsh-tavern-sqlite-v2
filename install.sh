#!/bin/sh
# 本地优先；发布构建填入固定地址和摘要，再内嵌零依赖Node获取器。
set -eu
RELEASE_URL='https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/download/v0.2.5/dsh-tavern-sqlite-v2-0.2.5.tgz'
RELEASE_SHA256='a7dc00d29137223fe99fb72ea2eb3c25e6de69d33da83414cef93f21612ecb97'
VERSION='0.2.5'
SCRIPT_DIR=''
case "$0" in
  *install.sh) SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) ;;
esac
export DSH_STORAGE_BOOTSTRAP_DIR="$SCRIPT_DIR"
export DSH_STORAGE_RELEASE_URL="${DSH_STORAGE_RELEASE_URL:-$RELEASE_URL}"
export DSH_STORAGE_RELEASE_SHA256="${DSH_STORAGE_RELEASE_SHA256:-$RELEASE_SHA256}"
export DSH_STORAGE_RELEASE_VERSION="$VERSION"
command -v node >/dev/null 2>&1 || { echo '需要已有酒馆使用的Node.js 22.19+；本脚本不另装运行时。' >&2; exit 1; }
node --input-type=module - "$@" <<'DSH_STORAGE_BOOTSTRAP'
// SH内嵌的零依赖获取器；仅缺安装包时联网，获取完成后才进入安装60秒预算。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const NAME = 'dsh-tavern-sqlite-v2'
const MAX = 16 * 1024 * 1024
export function bootstrapOptions(args) {
  let action = 'install', local
  const pass = []
  if (args[0] && !args[0].startsWith('--')) action = args.shift()
  if (!['install', 'uninstall'].includes(action)) throw Error('动作须为install或uninstall')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--package') { local = args[++i]; if (!local || local.startsWith('--')) throw Error('--package缺值') }
    else if (['--home', '--app', '--profile', '--port', '--systemd-unit', '--evidence'].includes(args[i])) { const value = args[i + 1]; if (!value || value.startsWith('--')) throw Error('参数缺值'); pass.push(args[i], value); i++ }
    else if (['--check', '--apply', '--background', '--prepare-env'].includes(args[i])) pass.push(args[i])
    else throw Error('未知参数：' + args[i])
  }
  return { action, local, pass }
}
function option(pass, key) { const index = pass.indexOf(key); return index < 0 ? undefined : pass[index + 1] }
export function installedPackage(pass, env = process.env) {
  const profile = option(pass, '--profile') || 'tavern'
  if (profile !== 'tavern') throw Error('当前V2只适配tavern profile')
  const explicit = option(pass, '--home'), candidates = explicit ? [path.resolve(explicit)] : [...new Set([env.DSH_TAVERN_CLI_HOME, env.DSH_HOME, process.cwd(), path.join(os.homedir(), '.dsh-tavern')].filter(Boolean).map(p => path.resolve(p)))].filter(p => fs.existsSync(path.join(p, 'profiles', profile, 'package.json')))
  if (candidates.length !== 1) throw Error(candidates.length ? '多个酒馆目录，请指定--home' : '没有找到已有酒馆，请指定--home；不会另装酒馆')
  const profileDir=path.join(candidates[0],'profiles',profile),manifestFile=path.join(profileDir,'package.json')
  if(!fs.existsSync(manifestFile))throw Error('目标不是已有酒馆profile，下载前拒绝')
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8')),dir=path.join(profileDir,'node_modules',NAME)
  for (const name of ['dsh-tavern-storage-sqlite', 'dsh-tavern-storage-sqlite-v1', 'dsh-tavern-storage-sqlite-v2', 'dsh-tavern-sqlite-v1']) if (manifest.dependencies?.[name] || manifest.dsh?.profile?.bundles?.includes(name)) throw Error('已装旧包名或另一版本线：' + name + '；先用其所属旧安装器卸载，不自动迁移/共装')
  const present=!!manifest.dependencies?.[NAME],listed=(manifest.dsh?.profile?.bundles||[]).includes(NAME)
  if(present!==listed||present!==fs.existsSync(dir))throw Error('已装依赖/bundle/链接不一致，拒绝猜测缺包下载或已卸载')
  return present ? fs.realpathSync(dir) : undefined
}
export function validatePackage(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (manifest.name !== NAME || JSON.stringify(Object.keys(manifest.dependencies || {}).sort()) !== JSON.stringify(['json5', 'jsonrepair', 'lodash', 'yaml']) || !Array.isArray(manifest.files)) throw Error('不是完整V2包或声明了未知运行依赖')
  for (const rel of ['deploy/maintenance.mjs', 'deploy/maintenance/runner.mjs', 'deploy/maintenance/source.mjs', 'index.js', 'cordis.patch.yml', ...manifest.files.map(p => p.replace(/\/\*.*$/, ''))]) {
    if (rel.includes('..') || path.isAbsolute(rel) || !fs.existsSync(path.join(root, rel))) throw Error('本地插件包不完整：' + rel + '；不联网替换损坏包')
  }
  return manifest
}
// 本地候选的版本识别：目录读 package.json（须本包名），tgz 从文件名取版本。
function directoryVersion(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    return manifest && manifest.name === NAME && typeof manifest.version === 'string' ? manifest.version : null
  } catch { return null }
}
export function archiveVersion(file) {
  const match = new RegExp('^' + NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d[^/]*)\\.tgz$').exec(path.basename(file))
  return match ? match[1] : null
}
export function selectLocal({ action, local, installed, scriptDir = '', cwd = process.cwd(), cache, version }) {
  if (action === 'uninstall' && !installed) return { kind: 'absent' }
  // 网络优先（2026-10-05 用户定）：本地候选（已装目录/相邻包/缓存tgz）只有与本次发行版本
  // 完全一致才采用；版本不符一律回落下载网络发行包，不用旧代本地件当执行器。
  // --package 是显式人工指定，不受版本一致性约束。
  const sameVersion = candidate => {
    if (!version) return false
    return candidate.kind === 'archive' ? archiveVersion(candidate.file) === version : directoryVersion(candidate.file) === version
  }
  if (local) {
    const file = path.resolve(cwd, local)
    if (!fs.existsSync(file)) throw Error('指定本地包不存在：' + file)
    return { kind: fs.statSync(file).isDirectory() ? 'directory' : 'archive', file }
  }
  if (installed) {
    const candidate = { kind: 'directory', file: installed }
    if (sameVersion(candidate)) return candidate
  }
  const adjacent = scriptDir ? path.resolve(scriptDir, '..') : ''
  for (const file of [adjacent, path.join(cwd, NAME), path.join(cwd, 'package'), cwd].filter(Boolean)) {
    const candidate = { kind: 'directory', file }
    if (directoryVersion(file) && sameVersion(candidate)) return candidate
  }
  for (const dir of [...new Set([scriptDir, cwd, cache].filter(Boolean))]) {
    const file = path.join(dir, NAME + '-' + version + '.tgz')
    if (fs.existsSync(file)) return { kind: 'archive', file }
  }
  // 无同版本本地件：回落 null ⇒ 引导层下载网络发行包执行。
  return null
}
export async function downloadArchive(url, expected, file, { request = fetch } = {}) {
  if (!/^https:\/\//.test(url || '') || !/^[0-9a-f]{64}$/.test(expected || '')) throw Error('尚未生成固定GitHub发行地址/摘要；请用--package本地包。不会请求latest/main或猜仓库')
  const response = await request(url, { signal: AbortSignal.timeout(180000), redirect: 'follow' })
  if (!response.ok || !response.body) throw Error('发行包下载失败：HTTP ' + response.status)
  const blocks = []; let size = 0
  for await (const block of response.body) { size += block.length; if (size > MAX) throw Error('发行包超过16MiB边界'); blocks.push(block) }
  const bytes = Buffer.concat(blocks)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('发行包SHA256不匹配，拒绝执行')
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 })
}
export function unpackArchive(file, root, expected) {
  const bytes = fs.readFileSync(file)
  if (bytes.length > MAX) throw Error('本地包超过16MiB边界')
  if (expected && createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('缓存发行包摘要不符；不联网覆盖损坏包')
  const tar = gunzipSync(bytes, { maxOutputLength: MAX }), files = new Set()
  // 仅接受npm pack标准package/路径、目录和普通文件，不跟随链接或接受特殊扩展路径。
  for (let at = 0; at + 512 <= tar.length;) {
    const header = tar.subarray(at, at + 512)
    if (header.every(value => value === 0)) break
    const text = (begin, length) => header.subarray(begin, begin + length).toString('utf8').split('\0')[0]
    const number = text(124, 12).trim(), checksumText = text(148, 8).trim()
    if (!/^[0-7]+$/.test(number) || !/^[0-7]+$/.test(checksumText)) throw Error('tgz头字段不合法')
    const size = parseInt(number, 8), type = text(156, 1), prefix = text(345, 155), name = (prefix ? prefix + '/' : '') + text(0, 100)
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]
    if (checksum !== parseInt(checksumText, 8) || at + 512 + size > tar.length) throw Error('tgz头校验/长度错误')
    if (!name.startsWith('package/') || name.includes('\\') || name.split('/').some(s => s === '..' || s === '.') || !['', '0', '5'].includes(type)) throw Error('tgz不接受越界/链接/特殊成员：' + name)
    const rel = name.slice(8).replace(/\/$/, ''), target = path.resolve(root, rel)
    if (rel && !target.startsWith(path.resolve(root) + path.sep)) throw Error('tgz解包越界')
    if (rel) {
      if (files.has(rel)) throw Error('tgz重复成员：' + rel)
      files.add(rel)
      if (type === '5') fs.mkdirSync(target, { recursive: true, mode: 0o700 })
      else { fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); fs.writeFileSync(target, tar.subarray(at + 512, at + 512 + size), { flag: 'wx', mode: 0o600 }) }
    }
    at += 512 + Math.ceil(size / 512) * 512
  }
  validatePackage(root)
}
export async function bootstrap(args = process.argv.slice(2), { env = process.env, request = fetch, invoke } = {}) {
  const op = bootstrapOptions([...args]), installed = installedPackage(op.pass, env), version = env.DSH_STORAGE_RELEASE_VERSION || '0.1.2'
  const cache = path.resolve(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), NAME)
  let selected = selectLocal({ ...op, installed, scriptDir: env.DSH_STORAGE_BOOTSTRAP_DIR, cache, version })
  if (selected?.kind === 'absent') { console.log('目标profile没有安装V2；不下载、不停启、不修改。'); return 0 }
  if (!selected) {
    const archive = path.join(cache, NAME + '-' + version + '.tgz')
    console.log('本地无插件包，下载固定发行包；下载期间不停止实例。')
    const partial = archive + '.download-' + randomUUID()
    await downloadArchive(env.DSH_STORAGE_RELEASE_URL, env.DSH_STORAGE_RELEASE_SHA256, partial, { request })
    // 目标缓存若被另一下载创建，只采用校验一致内容，不覆盖。
    if (fs.existsSync(archive)) {
      if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== env.DSH_STORAGE_RELEASE_SHA256) throw Error('并发缓存内容不同，拒绝覆盖')
      fs.unlinkSync(partial)
    } else fs.renameSync(partial, archive)
    selected = { kind: 'archive', file: archive }
    console.log('下载及校验完成。')
  }
  const started = performance.now()
  let root = selected.file, temporary
  try {
  if (selected.kind === 'archive') {
    root = temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-storage-package-')))
    // 只在执行器退出/完成独立副本后清理本次自己的随机目录；中断父进程则留给仍运行的子作业。
    const expected = selected.file.startsWith(cache + path.sep) && /^[0-9a-f]{64}$/.test(env.DSH_STORAGE_RELEASE_SHA256 || '') ? env.DSH_STORAGE_RELEASE_SHA256 : undefined
    unpackArchive(selected.file, root, expected)
  } else validatePackage(root)
  if (!fs.existsSync(path.join(root, 'deploy', 'maintenance', 'driver.mjs'))) throw Error('本地旧代执行器仍需认证；不会调用或下载。请用--package指定新版本地离线包作执行器，旧包保留用于恢复')
  const entry = path.join(root, 'deploy', 'maintenance.mjs'), argv = [entry, op.action, ...op.pass, '--elapsed', String(performance.now() - started)]
  console.log('使用本地完整包；开始离线维护，成功预算60秒。')
  if (invoke) return await invoke(process.execPath, argv)
  const child = spawn(process.execPath, argv, { stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true })
  const detach = () => { child.unref(); console.error('终端中断，已启动维护作业继续。'); process.exit(130) }
  process.once('SIGINT', detach); process.once('SIGTERM', detach)
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  process.removeListener('SIGINT', detach); process.removeListener('SIGTERM', detach)
  return code ?? 1
  } finally {
    if(temporary){
      if(!temporary.startsWith(fs.realpathSync(os.tmpdir())+path.sep+'dsh-storage-package-')||fs.realpathSync(temporary)!==temporary)throw Error('本次解包目录身份变化，不清理')
      fs.rmSync(temporary,{recursive:true,force:true})
    }
  }
}
if (process.argv[1] === '-' || (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  bootstrap().then(code => { process.exitCode = code }).catch(error => { console.error('安装入口失败：' + error.message); process.exitCode = 1 })
}

DSH_STORAGE_BOOTSTRAP
