// 嵌入目标：全部程序/marker/profile均为独占临时夹具，不执行exe、不访问真实home或存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { options, runtimeFor, tavernHost } from '../deploy/maintenance/target.mjs'
import { maintenanceChildArgs } from '../deploy/maintenance/runner.mjs'

const prefix = 'v2-embedded-target-'
function fixture(t, launcher = false) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)))
  t.after(() => { assert.ok(path.basename(root).startsWith(prefix)); assert.equal(realpathSync(root), root); rmSync(root, { recursive: true, force: true }) })
  const home = launcher ? path.join(root, 'tavern', 'data', 'harness') : path.join(root, '用户 home', '.dsh')
  const app = path.join(home, 'apps', 'dsh-tavern'), author = path.join(app, 'tavern-plugin')
  const profile = path.join(home, 'profiles', 'tavern'), desktop = launcher ? path.join(root, 'tavern', 'runtime-1') : path.join(root, 'Desktop (独立)')
  const put = (file, value) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8') }
  put(path.join(author, 'package.json'), { name: 'dsh-tavern-plugin', version: '2.5.0' })
  put(path.join(profile, 'package.json'), { dependencies: { 'dsh-tavern-plugin': 'link:' + author }, dsh: { profile: { bundles: ['dsh-tavern-plugin'] } } })
  mkdirSync(path.join(profile, 'node_modules'), { recursive: true })
  symlinkSync(author, path.join(profile, 'node_modules', 'dsh-tavern-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
  const marker = path.join(app, '.dsh-tavern-local.json')
  put(marker, { host: 'desktop', dshHome: home })
  if (launcher) put(path.join(root, 'tavern', 'launcher-settings.xml'), '<settings/>')
  const appDir = path.join(desktop, 'resources', 'app'), peerRoot = path.join(appDir, 'node_modules')
  const makeRuntime = dest => {
    const base = path.join(dest, 'resources', 'app')
    put(path.join(dest, 'DSH Desktop.exe'), 'FIXTURE ONLY, NOT EXECUTABLE')
    put(path.join(base, 'lib', 'desktop-cli.js'), '// fixture')
    put(path.join(base, 'package.json'), { name: 'dsh-plugin-desktop', version: '2.0.13', peerDependencies: { electron: '^43.0.0' } })
    for (const name of ['dsh', 'dsh-app-boot', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-session-query', 'dsh-atomic-write']) {
      const pkg = path.join(base, 'node_modules', '@deepseek-ai', name)
      put(path.join(pkg, 'package.json'), { name: '@deepseek-ai/' + name, version: '0.1.5-rc.2', main: 'index.js', type: 'module' })
      put(path.join(pkg, 'index.js'), 'export const fixture = true')
      if (name === 'dsh') {
        put(path.join(pkg, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.5-rc.2', bin: { dsh: 'lib/bin.js' } })
        put(path.join(pkg, 'lib', 'bin.js'), '// fixture CLI bin without default main')
      }
    }
  }
  makeRuntime(desktop)
  const parse = (extra = [], action = 'install') => options([action, '--home', home, ...extra], { env: {}, cwd: root, userHome: root })
  const args = ['--desktop-app', desktop]
  return { root, home, app, author, profile, desktop, appDir, peerRoot, marker, put, makeRuntime, parse, args }
}

test('嵌入目标：真实home/作者link和显式宿主识别，内部交接仍指同一程序树', t => {
  const f = fixture(t), op = f.parse(f.args), runtime = runtimeFor(op)
  assert.equal(op.host, 'desktop'); assert.equal(op.desktopLayout, 'embedded'); assert.equal(op.app, f.app)
  assert.equal(runtime.desktop.root, f.desktop); assert.equal(runtime.desktop.electronVersion, '43.0.0')
  assert.equal(runtime.desktop.exe, path.join(f.desktop, 'DSH Desktop.exe'))
  assert.equal(runtime.desktop.peerRoot, f.peerRoot)
  assert.ok(runtime.atomicUrl.startsWith('file:'))
  const child = maintenanceChildArgs('fixture-entry', { ...op, check: true }, path.join(f.home, 'maintenance', 'fixture'), f.root, 1)
  const inner = options(child.slice(1), { env: {}, cwd: f.root, userHome: f.root })
  assert.equal(inner.internal, true); assert.equal(inner.check, true)
  assert.equal(runtimeFor(inner).desktop.root, f.desktop)
})

test('嵌入目标：缺宿主参数、CLI错用、独立launcher借参均拒绝', t => {
  const f = fixture(t)
  assert.throws(() => f.parse(), /必须显式指定/)
  assert.throws(() => f.parse(['--desktop-app']), /缺值/)
  rmSync(f.marker)
  assert.throws(() => f.parse(f.args), /仅用于嵌入式/)
  const launcher = fixture(t, true)
  assert.throws(() => launcher.parse(launcher.args), /仅用于嵌入式/)
})

test('嵌入目标：marker绑定不同home、相对home和符号链接根不放行', t => {
  const f = fixture(t)
  f.put(f.marker, { host: 'desktop', dshHome: f.root })
  assert.throws(() => f.parse(f.args), /不一致/)
  f.put(f.marker, { host: 'desktop', dshHome: '.dsh' })
  assert.throws(() => f.parse(f.args), /合法 dshHome/)
  f.put(f.marker, { host: 'desktop', dshHome: f.home })
  const alias = path.join(f.root, 'home-alias')
  symlinkSync(f.home, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => options(['install', '--home', alias, ...f.args], { env: {}, cwd: f.root }), /无符号链接/)
})

test('嵌入目标：错误作者link与损坏data/harness不能降级认领', t => {
  const f = fixture(t)
  const linked = path.join(f.profile, 'node_modules', 'dsh-tavern-plugin')
  rmSync(linked)
  const other = path.join(f.root, 'other', 'tavern-plugin'); mkdirSync(other, { recursive: true })
  symlinkSync(other, linked, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => tavernHost(f.app), /实际链接不一致/)
  const launcher = fixture(t, true)
  rmSync(path.join(launcher.root, 'tavern', 'launcher-settings.xml'))
  assert.throws(() => launcher.parse(), /启动器标记不符/)
})

test('嵌入目标：缺文件、错误宿主、未知Electron、目录别名拒绝', t => {
  for (const mutate of [
    f => rmSync(path.join(f.desktop, 'DSH Desktop.exe')),
    f => rmSync(path.join(f.appDir, 'lib', 'desktop-cli.js')),
    f => f.put(path.join(f.appDir, 'package.json'), { name: 'not-desktop', peerDependencies: { electron: '43.0.0' } }),
    f => f.put(path.join(f.appDir, 'package.json'), { name: 'dsh-plugin-desktop', peerDependencies: { electron: '>=43.0.0 <45.0.0' } }),
  ]) {
    const f = fixture(t); mutate(f)
    assert.throws(() => runtimeFor(f.parse(f.args)), /缺少真实程序文件|不是 dsh-plugin-desktop|无法明确解析/)
  }
  const f = fixture(t), alias = path.join(f.root, 'desktop-alias')
  symlinkSync(f.desktop, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => runtimeFor(f.parse(['--desktop-app', alias])), /无符号链接/)
})

test('嵌入目标：核心boot与插件peer错版或缺入口拒绝，卸载不强求安装peer', t => {
  for (const name of ['dsh', 'dsh-app-boot', 'dsh-session-persistence', 'dsh-session-persistence-jsonl', 'dsh-session-query']) {
    const f = fixture(t)
    f.put(path.join(f.peerRoot, '@deepseek-ai', name, 'package.json'), { name: '@deepseek-ai/' + name, version: '0.1.5-rc.3', main: 'index.js' })
    assert.throws(() => runtimeFor(f.parse(f.args)), /未适配/)
    assert.equal(runtimeFor(f.parse(f.args, 'uninstall')).desktop.root, f.desktop)
  }
  const f = fixture(t)
  rmSync(path.join(f.peerRoot, '@deepseek-ai', 'dsh-session-query', 'index.js'))
  assert.throws(() => runtimeFor(f.parse(f.args)), /Cannot find module/)
})

if (process.platform === 'win32') test('嵌入目标：PS5菜单前调用真实JS判据，中文空格路径不丢且缺peer不认领', t => {
  const f = fixture(t), src = readFileSync(new URL('../deploy/install.ps1', import.meta.url), 'utf8')
  const helper = src.slice(src.indexOf('function Assert-DesktopTarget('), src.indexOf('# ——— 3.'))
  assert.ok(helper.includes('runtimeFor(op)'), '必须抽取实际同判据验证函数')
  const payload = Buffer.from(JSON.stringify({ root: fileURLToPath(new URL('..', import.meta.url)), home: f.home, desktop: f.desktop, exe: process.execPath }), 'utf8').toString('base64')
  const encoded = Buffer.from(helper, 'utf8').toString('base64'), script = path.join(f.root, 'pre-menu.ps1')
  f.put(script, [
    "$ErrorActionPreference='Stop'",
    '$OutputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    "function Fail([string]$text) { throw $text }",
    "Invoke-Expression ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + encoded + "')))",
    "$a=([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + payload + "')) | ConvertFrom-Json)",
    "$root=$a.root; $Action='install'; $DesktopApp=$a.desktop",
    "$tavern=@{home=$a.home;kind='desktop'}; $node=@{exe=$a.exe;runAsNode=$false}",
    'Assert-DesktopTarget $tavern $node',
    "if($tavern.layout -ne 'embedded'){throw 'wrong layout'}",
    "Write-Host 'REAL-TARGET-ACCEPTED'",
  ].join('\n'))
  const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const run = () => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
  const accepted = run(); assert.ifError(accepted.error); assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr)
  assert.match(accepted.stdout, /REAL-TARGET-ACCEPTED/)
  rmSync(path.join(f.peerRoot, '@deepseek-ai', 'dsh-session-query', 'package.json'))
  const refused = run(); assert.ifError(refused.error); assert.notEqual(refused.status, 0)
  assert.match(refused.stdout + refused.stderr, /桌面目标识别未通过/)
  assert.doesNotMatch(refused.stdout, /REAL-TARGET-ACCEPTED/)
})

test('嵌入目标：同实例模块允许宿主正规peer链接，不借祖先副本补缺入口', t => {
  const f = fixture(t)
  assert.equal(runtimeFor(f.parse(f.args)).desktop.root, f.desktop)
  const local = path.join(f.peerRoot, '@deepseek-ai', 'dsh-session-query'), physical = path.join(f.root, 'pnpm实际模块')
  f.put(path.join(physical, 'package.json'), { name: '@deepseek-ai/dsh-session-query', version: '0.1.5-rc.2', main: 'index.js' })
  f.put(path.join(physical, 'index.js'), 'module.exports = {}')
  assert.ok(local.startsWith(f.root + path.sep)); rmSync(local, { recursive: true, force: true })
  symlinkSync(physical, local, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(runtimeFor(f.parse(f.args)).desktop.root, f.desktop)
  for (const peer of ['dsh-app-boot', 'dsh-atomic-write']) {
    const g = fixture(t)
    rmSync(path.join(g.peerRoot, '@deepseek-ai', peer, 'index.js'))
    const foreign = path.join(g.root, 'node_modules', '@deepseek-ai', peer)
    g.put(path.join(foreign, 'package.json'), { name: '@deepseek-ai/' + peer, version: '0.1.5-rc.2', main: 'index.js' })
    g.put(path.join(foreign, 'index.js'), 'module.exports = {}')
    assert.throws(() => runtimeFor(g.parse(g.args)), /解析到另一副本|Cannot find module/)
  }
})

test('嵌入目标：独立launcher原选择保持、多个runtime仍拒猜', t => {
  const f = fixture(t, true), op = f.parse()
  assert.equal(op.desktopLayout, 'launcher'); assert.equal(runtimeFor(op).desktop.root, f.desktop)
  f.makeRuntime(path.join(f.root, 'tavern', 'runtime-2'))
  assert.throws(() => runtimeFor(op), /多个运行时目录/)
})
