// WinCLI：官方 Windows CLI 私有 home/runtime 的运行时判据与只读进程存在性判定。
// 全部为**独占临时夹具**（合成 home/SDK/profile/junction 与合成进程列表）：不启动任何进程、
// 不枚举真实进程、不碰真实 profile/存档、不联网；进程清单经 `list` 注入，不执行 powershell。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { options, runtimeFor, windowsCliRuntimeFor } from '../deploy/maintenance/target.mjs'
import { windowsCliProcessList, windowsCliTavernProcesses } from '../deploy/maintenance/process.mjs'

const prefix = 'v2-wincli-target-'
const CORE = ['dsh', 'dsh-app-boot', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-session-query', 'dsh-atomic-write']
const VERSION = '0.1.5-rc.2'
// 官方 WinCLI **没有私有 runtime/node.exe**：启动器用 system PATH 的 node（本机实测路径，含空格与括号）。
const SYSTEM_NODE = 'D:\\Program Files (x86)\\nodejs\\node.exe'
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
function fixture(t, { homeName = '用户 空间' } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => { assert.ok(path.basename(root).startsWith(prefix)); assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, homeName, '.dsh'), runtime = path.join(home, 'runtime'), peerRoot = path.join(runtime, 'node_modules')
  const app = path.join(home, 'apps', 'dsh-tavern'), author = path.join(app, 'tavern-plugin'), profile = path.join(home, 'profiles', 'tavern')
  const put = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8') }
  put(path.join(author, 'package.json'), { name: 'dsh-tavern-plugin', version: '2.5.0' })
  put(path.join(profile, 'package.json'), { dependencies: { 'dsh-tavern-plugin': 'link:' + author }, dsh: { profile: { bundles: ['dsh-tavern-plugin'] } } })
  mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  symlinkSync(author, path.join(profile, 'node_modules', 'dsh-tavern-plugin'), linkType)
  const bin = path.join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  for (const name of CORE) {
    const dir = path.join(peerRoot, '@deepseek-ai', name)
    put(path.join(dir, 'package.json'), name === 'dsh'
      ? { name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: 'lib/bin.js' }, exports: { '.': './lib/bin.js' } }
      : { name: '@deepseek-ai/' + name, version: VERSION, main: 'index.js', exports: { '.': './index.js' } })
    put(path.join(dir, name === 'dsh' ? path.join('lib', 'bin.js') : 'index.js'), 'export const fixture = true')
  }
  put(path.join(runtime, 'dsh.cmd'), '@echo off\r\nnode "%~dp0node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n')
  // 正规 pnpm 布局：physical 在 peerRoot/.pnpm/… 内，`@deepseek-ai/<name>` 只是**词法别名**链接（argv 用词法）。
  const pnpmLink = (name, data, files) => {
    const physical = path.join(peerRoot, '.pnpm', name + '@' + VERSION, 'node_modules', '@deepseek-ai', name)
    put(path.join(physical, 'package.json'), data)
    for (const [file, text] of Object.entries(files)) put(path.join(physical, file), text)
    rmSync(path.join(peerRoot, '@deepseek-ai', name), { recursive: true, force: true })
    symlinkSync(physical, path.join(peerRoot, '@deepseek-ai', name), linkType)
    return physical
  }
  const parse = (extra = [], action = 'install') => options([action, '--home', home, ...extra], { env: {}, cwd: root, userHome: root })
  const nodeExe = path.join(runtime, 'node.exe')
  return { root, home, runtime, peerRoot, app, author, profile, put, parse, pnpmLink, nodeExe, systemNode: SYSTEM_NODE, bin }
}

test('WinCLI：win32+CLI 走私有 runtime 描述符，入口为真实 JS 且原子锁取同副本', t => {
  const f = fixture(t)
  assert.equal(f.parse().host, 'cli')
  const r = windowsCliRuntimeFor(f.parse())
  assert.equal(r.host, 'cli'); assert.equal(r.windowsCli.root, f.runtime); assert.equal(r.windowsCli.appDir, f.runtime)
  assert.equal(r.windowsCli.peerRoot, f.peerRoot)
  assert.equal(r.cli, realpathSync(f.bin), 'cli 必须是真实 JS 入口，不是 dsh.cmd')
  assert.ok(r.cli.endsWith('.js')); assert.ok(r.cliEntries.includes(r.cli)); assert.ok(r.cliEntries.every(entry => entry.startsWith(f.runtime + path.sep)))
  assert.ok(r.atomicUrl.startsWith('file:'))
  assert.ok(r.atomicUrl.includes('dsh-atomic-write'), '原子锁须来自同一 runtime 副本：' + r.atomicUrl)
  assert.equal(r.windowsCli.cliEntry, r.cli)
  assert.equal(r.windowsCli.binRelative, 'lib/bin.js', 'bin 相对路径随描述符带出，供进程相对入口归属判定')
})

test('WinCLI：pnpm 链接下 cliEntries 同时留词法别名与 physical（argv 实际用词法）', t => {
  const f = fixture(t)
  const physical = f.pnpmLink('dsh', { name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: 'lib/bin.js' }, exports: { '.': './lib/bin.js' } },
    { 'lib/bin.js': 'export const fixture = true' })
  const r = windowsCliRuntimeFor(f.parse())
  const lexical = path.join(f.peerRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.notEqual(lexical, physical + path.sep + path.join('lib', 'bin.js'), '夹具须真的走链接（词法≠physical）')
  assert.equal(r.cli, realpathSync(physical + path.sep + path.join('lib', 'bin.js')), 'cli 仍是 physical 真实入口')
  assert.deepEqual(r.cliEntries, [lexical, r.cli], '别名与 physical 都留，不得被 Set 去重成一个')
  assert.equal(r.windowsCli.cliEntries.length, 2)
})

test('WinCLI：bin 越界、非 JS 入口与缺私有 runtime 一律拒绝', t => {
  const outside = fixture(t), escape = path.join(outside.root, 'escape.js')
  outside.put(escape, '// 包外文件，不许当入口')
  outside.put(path.join(outside.peerRoot, '@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: path.relative(path.join(outside.peerRoot, '@deepseek-ai', 'dsh'), escape) } })
  assert.throws(() => windowsCliRuntimeFor(outside.parse()), /越出包根/)
  const shim = fixture(t)
  shim.put(path.join(shim.peerRoot, '@deepseek-ai', 'dsh', 'package.json'), { name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: 'lib/bin.cmd' } })
  shim.put(path.join(shim.peerRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.cmd'), '@echo off')
  assert.throws(() => windowsCliRuntimeFor(shim.parse()), /不是 JS 文件/)
  const missing = fixture(t)
  rmSync(path.join(missing.runtime, 'node_modules'), { recursive: true, force: true })
  assert.throws(() => windowsCliRuntimeFor(missing.parse()), /私有 runtime\/node_modules/)
})

test('WinCLI：SDK/boot/peer/原子锁错版、缺入口与缺包拒绝，uninstall 不放松原子锁', t => {
  for (const name of ['dsh', 'dsh-app-boot', 'dsh-session-query', 'dsh-atomic-write']) {
    const f = fixture(t)
    const data = name === 'dsh'
      ? { name: '@deepseek-ai/dsh', version: '0.1.5-rc.3', bin: { dsh: 'lib/bin.js' }, exports: { '.': './lib/bin.js' } }
      : { name: '@deepseek-ai/' + name, version: '0.1.5-rc.3', main: 'index.js', exports: { '.': './index.js' } }
    f.put(path.join(f.peerRoot, '@deepseek-ai', name, 'package.json'), data)
    assert.throws(() => windowsCliRuntimeFor(f.parse()), /未适配|只支持已适配/, name + ' 错版须拒绝')
  }
  const g = fixture(t)
  rmSync(path.join(g.peerRoot, '@deepseek-ai', 'dsh-session-query', 'index.js'))
  assert.throws(() => windowsCliRuntimeFor(g.parse()), /入口不可解析/)
  rmSync(path.join(g.peerRoot, '@deepseek-ai', 'dsh-atomic-write'), { recursive: true, force: true })
  assert.throws(() => windowsCliRuntimeFor(g.parse(['--port', '3091'], 'uninstall')), /原子锁/, 'uninstall 也须解析到同一原子锁')
  const h = fixture(t)
  rmSync(path.join(h.peerRoot, '@deepseek-ai', 'dsh-app-boot'), { recursive: true, force: true })
  assert.throws(() => windowsCliRuntimeFor(h.parse()), /缺少宿主 peer/)
  // 卸载不核 peer（缺 peer 也放行）：卸载只需要私有 SDK bin 与**同一把**有效原子锁。
  const u = fixture(t)
  for (const name of ['dsh-app-boot', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-session-query']) {
    rmSync(path.join(u.peerRoot, '@deepseek-ai', name), { recursive: true, force: true })
  }
  const un = windowsCliRuntimeFor(u.parse([], 'uninstall'))
  assert.equal(un.cli, realpathSync(u.bin), '卸载缺 peer 但 atomic 有效 → 放行')
  assert.ok(un.atomicUrl.includes('dsh-atomic-write'))
  // 原子锁入口必须落在**自己那份 physical 副本**内：任意其它包的入口不能冒充这把锁。
  const a = fixture(t), foreign = path.join(a.root, '别的包', 'index.js'), atomicDir = path.join(a.peerRoot, '@deepseek-ai', 'dsh-atomic-write')
  a.put(foreign, 'module.exports = {}')
  a.put(path.join(atomicDir, 'package.json'), { name: '@deepseek-ai/dsh-atomic-write', version: VERSION, main: path.relative(atomicDir, foreign) })
  assert.throws(() => windowsCliRuntimeFor(a.parse()), /原子锁入口/, '任意其它包入口不得冒充原子锁')
})

test('WinCLI：允许正规 pnpm 链接（physical 在 peerRoot 内），拒绝经祖先 node_modules 补缺入口', t => {
  const f = fixture(t)
  f.pnpmLink('dsh-session-query', { name: '@deepseek-ai/dsh-session-query', version: VERSION, main: 'index.js', exports: { '.': './index.js' } }, { 'index.js': 'export const fixture = true' })
  assert.equal(windowsCliRuntimeFor(f.parse()).cli, realpathSync(f.bin), '正规链接须放行')
  // dsh 包 physical 越出私有 peerRoot（哪怕名字对、版本对）→ 拒绝：判据必须来自私有副本。
  const out = fixture(t), outside = path.join(out.root, '外部副本', '@deepseek-ai', 'dsh')
  out.put(path.join(outside, 'package.json'), { name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: 'lib/bin.js' } })
  out.put(path.join(outside, 'lib', 'bin.js'), 'export const fixture = true')
  rmSync(path.join(out.peerRoot, '@deepseek-ai', 'dsh'), { recursive: true, force: true })
  symlinkSync(outside, path.join(out.peerRoot, '@deepseek-ai', 'dsh'), linkType)
  assert.throws(() => windowsCliRuntimeFor(out.parse()), /之外的副本/, 'SDK physical 越出 peerRoot 须拒绝')
  for (const peer of ['dsh-app-boot', 'dsh-atomic-write']) {
    const g = fixture(t)
    rmSync(path.join(g.peerRoot, '@deepseek-ai', peer), { recursive: true, force: true })
    const foreign = path.join(g.root, 'node_modules', '@deepseek-ai', peer)
    g.put(path.join(foreign, 'package.json'), { name: '@deepseek-ai/' + peer, version: VERSION, main: 'index.js', exports: { '.': './index.js' } })
    g.put(path.join(foreign, 'index.js'), 'export const fixture = true')
    assert.throws(() => windowsCliRuntimeFor(g.parse()), /缺少宿主 peer|缺少原子锁模块|解析到另一副本/, peer + ' 不得借祖先补缺')
  }
})

test('WinCLI：system PATH 的 node.exe 在跑（引号/中文/空格）→ 命中，非 node/无关脚本跳过', t => {
  const f = fixture(t), r = windowsCliRuntimeFor(f.parse()), target = { home: f.home, profile: 'tavern', windowsCli: r.windowsCli }
  const quote = value => '"' + value + '"'
  assert.deepEqual(windowsCliTavernProcesses(target, { list: () => [] }), [], '无候选＝停止态')
  // 官方 WinCLI 用 system PATH 的 node 启动：不按 exe==home/runtime/node.exe 限制。
  const hit = windowsCliTavernProcesses(target, { list: () => [
    { pid: 41, exe: f.systemNode, argv: quote(f.systemNode) + ' --experimental-vm-modules ' + quote(r.cli) + ' --profile tavern --host 127.0.0.1 --port 3091 --no-open' },
  ] })
  assert.equal(hit.length, 1); assert.equal(hit[0].pid, 41); assert.equal(hit[0].exe, f.systemNode, '原样返回候选，不改写身份')
  assert.equal(hit[0].env, undefined, '存在性判定不认领 env')
  assert.ok(hit[0].argv.includes(r.cli))
  // 无空格路径：不加引号也按整 token 命中（引号只影响分词，不改变身份）。
  const plain = fixture(t, { homeName: 'plain-home' }), pr = windowsCliRuntimeFor(plain.parse())
  const unquoted = windowsCliTavernProcesses({ home: plain.home, profile: 'tavern', windowsCli: pr.windowsCli },
    { list: () => [{ pid: 42, exe: plain.systemNode, argv: 'node.exe ' + pr.cli + ' --profile tavern' }] })
  assert.equal(unquoted.length, 1, '未加引号的完整绝对入口同样命中')
  const privateNode = windowsCliTavernProcesses(target, { list: () => [{ pid: 43, exe: f.nodeExe, argv: 'node ' + quote(r.cli) }] })
  assert.equal(privateNode.length, 1, '私有 runtime 若有 node.exe 也不排除（只按入口认目标）')
  const unrelated = windowsCliTavernProcesses(target, { list: () => [
    { pid: 7, exe: 'C:\\Program Files\\nodejs\\node.exe', argv: 'node C:\\tools\\unrelated.mjs --watch' },
    { pid: 8, exe: f.systemNode, argv: 'node C:\\tools\\build.mjs' },
    { pid: 9, exe: 'C:\\Windows\\System32\\notepad.exe', argv: 'notepad.exe ' + quote(r.cli) },
  ] })
  assert.deepEqual(unrelated, [], '普通 tools 与非 node 启动器都不算目标')
})

test('WinCLI：词法别名入口命中；路径包含/别处同名 bin.js 不误命中（token 词边界）', t => {
  const f = fixture(t)
  f.pnpmLink('dsh', { name: '@deepseek-ai/dsh', version: VERSION, bin: { dsh: 'lib/bin.js' }, exports: { '.': './lib/bin.js' } },
    { 'lib/bin.js': 'export const fixture = true' })
  const r = windowsCliRuntimeFor(f.parse()), target = { home: f.home, profile: 'tavern', windowsCli: r.windowsCli }
  const quote = value => '"' + value + '"'
  const lexical = path.join(f.peerRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const alias = windowsCliTavernProcesses(target, { list: () => [{ pid: 44, exe: f.systemNode, argv: 'node ' + quote(lexical) + ' --profile tavern' }] })
  assert.equal(alias.length, 1, 'pnpm 链接下 argv 用词法别名，别名入口必须命中')
  const physical = windowsCliTavernProcesses(target, { list: () => [{ pid: 45, exe: f.systemNode, argv: 'node ' + quote(r.cli) + ' --profile tavern' }] })
  assert.equal(physical.length, 1, 'physical 入口同样命中')
  const boundary = windowsCliTavernProcesses(target, { list: () => [
    { pid: 61, exe: f.systemNode, argv: 'node ' + quote(r.cli + 'fake.js') + ' --profile tavern' },
    { pid: 62, exe: f.systemNode, argv: 'node ' + quote(path.join(f.root, 'copy', 'lib', 'bin.js')) + ' --profile tavern' },
  ] })
  assert.deepEqual(boundary, [], '路径包含/别处同名入口不是同一个入口')
})

test('WinCLI：相对 SDK 入口无法归属 → 抛错；字段损坏与清单异常一律 fail closed', t => {
  const f = fixture(t), r = windowsCliRuntimeFor(f.parse()), target = { home: f.home, profile: 'tavern', windowsCli: r.windowsCli }
  for (const argv of [
    'node lib/bin.js --profile tavern',
    'node node_modules/@deepseek-ai/dsh/lib/bin.js --profile tavern',
    'node ./lib/bin.js --profile tavern',
  ]) {
    assert.throws(() => windowsCliTavernProcesses(target, { list: () => [{ pid: 51, exe: f.systemNode, argv }] }), /无法归属/, argv + ' 须抛模糊，不得当停止态')
  }
  // 别的（绝对）JS 脚本、无 profile 的相对脚本仍允许跳过。
  assert.deepEqual(windowsCliTavernProcesses(target, { list: () => [
    { pid: 54, exe: f.systemNode, argv: 'node C:\\tools\\other.mjs --profile tavern' },
    { pid: 55, exe: f.systemNode, argv: 'node tools/run.mjs --watch' },
  ] }), [], '明确无关的脚本不算目标')
  for (const bad of [
    { pid: 52, exe: '', argv: 'node ' + r.cli + ' --profile tavern' },
    { pid: 53, exe: f.systemNode, argv: '' },
    { pid: 0, exe: f.systemNode, argv: 'node ' + r.cli },
  ]) assert.throws(() => windowsCliTavernProcesses(target, { list: () => [bad] }), /缺少|无 PID/, '不完整候选须拒绝停止态')
  assert.throws(() => windowsCliTavernProcesses(target, { list: () => { throw Error('CIM 查询失败') } }), /CIM 查询失败/, '清单失败须上抛')
  assert.throws(() => windowsCliTavernProcesses({ home: f.home }, { list: () => [] }), /缺少私有 home\/入口/)
  // 清单层：损坏行不得被 filter 成空清单（空清单＝停止态）。
  const row = (pid, exe, argv) => JSON.stringify([{ ProcessId: pid, ExecutablePath: exe, CommandLine: argv }])
  assert.equal(windowsCliProcessList({ run: () => row(7, f.systemNode, 'node x.mjs') }).length, 1)
  assert.equal(windowsCliProcessList({ run: () => '[]' }).length, 0)
  assert.throws(() => windowsCliProcessList({ run: () => JSON.stringify([{ ExecutablePath: f.systemNode, CommandLine: 'node x.mjs' }]) }), /无 PID/)
  assert.throws(() => windowsCliProcessList({ run: () => row(8, '', '') }), /缺少关键身份/)
  assert.throws(() => windowsCliProcessList({ run: () => '{ 不是 JSON' }), /不可解析/)
  assert.throws(() => windowsCliProcessList({ run: () => { throw Error('CIM 查询失败') } }), /CIM 查询失败/)
})

test('WinCLI：非 win32 原分支零改——POSIX runtimeFor 结果逐字不变', t => {
  const f = fixture(t)
  // 先拿掉 WinCLI 私有布局：POSIX 分支不得依赖它（依赖了就解析不出入口）。
  rmSync(path.join(f.runtime, 'node_modules'), { recursive: true, force: true })
  const legacy = path.join(f.home, 'runtime', 'lib', 'node_modules', '@deepseek-ai')
  for (const name of CORE) f.put(path.join(legacy, name, 'package.json'), name === 'dsh'
    ? { name: '@deepseek-ai/dsh', version: VERSION }
    : { name: '@deepseek-ai/' + name, version: VERSION, main: 'index.js' })
  for (const name of CORE) f.put(path.join(legacy, name, 'index.js'), 'module.exports = {}')
  const bin = path.join(f.home, 'runtime', 'bin', 'dsh')
  f.put(bin, '#!/usr/bin/env node\n')
  const r = runtimeFor(f.parse(), { platform: 'linux' })
  assert.equal(r.cli, bin); assert.deepEqual(r.cliEntries, [bin, realpathSync(bin)])
  assert.equal(r.host, undefined, 'POSIX 分支不新增 host/windowsCli 字段')
  assert.equal(r.windowsCli, undefined); assert.equal(r.desktop, undefined)
  assert.ok(r.atomicUrl.startsWith('file:'))
  assert.ok(!existsSync(path.join(f.home, 'runtime', 'node_modules')), 'POSIX 夹具不建 WinCLI 布局，证明走的是原分支')
})
