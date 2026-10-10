// bootstrap兜底定向验证（2026-10-07）：零deps+vendor五入口；缺vendor拒；卸载半装/无包不absent早退；
// 安装半装严格拒；悬空链接容忍；foreign family保拒。全部原创微型替身，不联网、不读真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootstrapOptions, installedPackage, validatePackage, selectLocal, bootstrap } from '../deploy/bootstrap.mjs'
import { createStandardInstallation, installOwnedRows, pluginDirFor } from '../deploy/maintenance/standard-installation.mjs'
import { copyPackage } from '../deploy/maintenance/runner.mjs'
import { fileURLToPath } from 'node:url'
const product = fileURLToPath(new URL('../', import.meta.url))

const NAME = 'dsh-tavern-sqlite-v2'
const VENDOR = ['lib/vendor/lodash/lodash.min.js', 'lib/vendor/json5/index.mjs', 'lib/vendor/jsonrepair/esm/index.js', 'lib/vendor/yaml/dist/index.js', 'lib/vendor/acorn/acorn.mjs']
const FILES = ['deploy/maintenance.mjs', 'deploy/maintenance/runner.mjs', 'deploy/maintenance/source.mjs', 'deploy/maintenance/driver.mjs', 'index.js', 'cordis.patch.yml']
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-residual-'))
const drop = root => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'bootstrap-residual-')), '只清理本次自建临时目录'); fs.rmSync(root, { recursive: true, force: true }) }
const noNetwork = () => { throw Error('本地完整包不应联网') }
const manifest = (dir, extra = {}) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const write = (file, body = '// fixture\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, 'utf8') }

/** 维护链替身：相对导入与new URL('./x')都按“任意文件名”写，缺件即判包不完整（不预设兜底资产命名）。 */
const maintenanceSource = ({ asset = null, module = null } = {}) => [
  module ? "import { residual } from './" + module + "'" : '',
  asset ? "export const asset = new URL('./" + asset + "', import.meta.url)" : '',
  'export const fixture = true',
].filter(Boolean).join('\n') + '\n'
/** 微型完整包：零运行时依赖 + vendor账本五入口 + 维护链（asset为随包资产，module为被引用模块）。 */
function tinyPackage(dir, { version = '0.2.8', asset = null, module = null, extra = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  for (const rel of FILES) write(path.join(dir, rel))
  write(path.join(dir, 'deploy', 'maintenance', 'runner.mjs'), maintenanceSource({ asset, module }))
  for (const rel of VENDOR) write(path.join(dir, rel))
  write(path.join(dir, 'lib', 'vendor', 'manifest.json'), JSON.stringify({ packages: { lodash: { version: '1.0.0' }, json5: { version: '1.0.0' }, jsonrepair: { version: '1.0.0' }, yaml: { version: '1.0.0' }, acorn: { version: '1.0.0' } } }))
  write(path.join(dir, 'package.json'), JSON.stringify({ name: NAME, version, dependencies: {}, files: FILES, ...extra }))
  return dir
}
/** profile替身：只写装配清单与（可选）现装目录；不建真实酒馆。 */
function tavernHome(root, state, { installed = false } = {}) {
  const home = path.join(root, 'home'), profileDir = path.join(home, 'profiles', 'tavern'), dir = path.join(profileDir, 'node_modules', NAME)
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  write(path.join(profileDir, 'package.json'), JSON.stringify(state))
  if (installed) tinyPackage(dir)
  return { home, dir }
}
/** 只截获本用例stdout文案（证“继续卸载/下载完成才维护”的顺序），finally恢复。 */
function captureLog() {
  const lines = [], original = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  return { lines, restore: () => { console.log = original } }
}

test('①validatePackage：零deps+vendor五入口+维护链资产齐备即通过；缺vendor/声明依赖保拒', () => {
  const root = temp()
  try {
    const full = tinyPackage(path.join(root, 'full'))
    assert.equal(validatePackage(full).name, NAME)
    // 维护链引用的随包资产（任意文件名）+ 被引用模块都在 → 不预设主线命名也通过。
    const named = tinyPackage(path.join(root, 'named'), { asset: 'fallback-asset-any.txt', module: 'helper-any.mjs' })
    write(path.join(named, 'deploy', 'maintenance', 'fallback-asset-any.txt'))
    write(path.join(named, 'deploy', 'maintenance', 'helper-any.mjs'))
    assert.equal(validatePackage(named).name, NAME)
    // 维护链引用了不存在的资产/模块 → 缺件即判不完整。
    const missingAsset = tinyPackage(path.join(root, 'missing-asset'), { asset: 'gone.txt' })
    assert.throws(() => validatePackage(missingAsset), /维护链引用缺失/)
    const missingModule = tinyPackage(path.join(root, 'missing-module'), { module: 'gone.mjs' })
    assert.throws(() => validatePackage(missingModule), /维护链引用缺失/)
    // 缺 vendor 入口 → 拒绝，且不联网替换。
    const noVendor = tinyPackage(path.join(root, 'no-vendor'))
    fs.rmSync(path.join(noVendor, VENDOR[0]))
    assert.throws(() => validatePackage(noVendor), /vendor 入口缺失.*lodash\.min\.js/)
    // 声明任何运行时依赖 → 拒绝（供应链政策不放宽）。
    const dep = tinyPackage(path.join(root, 'dep'), { extra: { dependencies: { lodash: '^4.0.0' } } })
    assert.throws(() => validatePackage(dep), /依赖 lodash/)
  } finally { drop(root) }
})

test('②bootstrapOptions：动作保留；未知参数与缺值保拒', () => {
  assert.deepEqual(bootstrapOptions(['install', '--home', '/x']), { action: 'install', local: undefined, pass: ['--home', '/x'] })
  assert.deepEqual(bootstrapOptions(['uninstall', '--home', '/x', '--package', '/pkg']), { action: 'uninstall', local: '/pkg', pass: ['--home', '/x'] })
  assert.throws(() => bootstrapOptions(['reinstall']), /install或uninstall/)
  assert.throws(() => bootstrapOptions(['install', '--online']), /未知参数/)
  assert.throws(() => bootstrapOptions(['install', '--package']), /缺值/)
})

test('③安装半装严格拒；卸载半装/无包不早退，仍选本地完整包或新发行包', async () => {
  const root = temp()
  try {
    const half = tavernHome(path.join(root, 'half'), { dependencies: { [NAME]: 'file:x' }, dsh: { profile: { bundles: [] } } }, { installed: true })
    assert.throws(() => installedPackage(['--home', half.home], {}), /不一致/, '安装不得猜缺包或已卸载')
    assert.equal(installedPackage(['--home', half.home], {}, { action: 'uninstall' }), fs.realpathSync(half.dir), '半装仍给可用本地完整包')
    // 半装但现装目录损坏（缺index.js）：安装仍给出路径，但校验即拒（不联网替换）。
    const damaged = tavernHome(path.join(root, 'damaged'), { dependencies: { [NAME]: 'file:x' }, dsh: { profile: { bundles: [NAME] } } }, { installed: true })
    fs.rmSync(path.join(damaged.dir, 'index.js'))
    const suggested = installedPackage(['--home', damaged.home], {})
    assert.throws(() => validatePackage(suggested), /不完整/)
    // 完全无现装：卸载仍选到本地完整包（不absent早退），bootstrap走本地路径、不联网。
    const clean = tavernHome(path.join(root, 'clean'), { dependencies: {}, dsh: { profile: { bundles: [] } } })
    const local = tinyPackage(path.join(root, 'local-release'))
    assert.equal(installedPackage(['--home', clean.home], {}, { action: 'uninstall' }), undefined)
    assert.equal(selectLocal({ action: 'uninstall', installed: undefined, local, cwd: root, scriptDir: '', version: '0.2.8' }).file, local)
    assert.equal(selectLocal({ action: 'uninstall', installed: undefined, cwd: root, scriptDir: '', version: '0.2.8' }), null, '无本地同版本件才回落下载')
    const log = captureLog()
    try {
      const code = await bootstrap(['uninstall', '--home', clean.home, '--package', local], { request: noNetwork, invoke: async (bin, argv) => (assert.equal(argv[1], 'uninstall'), 0) })
      assert.equal(code, 0)
      assert.ok(log.lines.some(line => /缺包不等于接缝已撤/.test(line)), '卸载缺包须显式继续而非早退')
    } finally { log.restore() }
  } finally { drop(root) }
})

test('④悬空链接容忍：卸载不抛并回落发行包；安装仍按不一致拒绝', () => {
  const root = temp()
  try {
    const dangling = tavernHome(path.join(root, 'dangling'), { dependencies: { [NAME]: 'file:x' }, dsh: { profile: { bundles: [NAME] } } })
    const target = tinyPackage(path.join(root, 'dangling-target'))
    fs.symlinkSync(target, dangling.dir, process.platform === 'win32' ? 'junction' : 'dir')
    fs.rmSync(target, { recursive: true, force: true })
    assert.equal(fs.existsSync(dangling.dir), false, '悬空链接：existsSync跟随链接为false')
    assert.equal(installedPackage(['--home', dangling.home], {}, { action: 'uninstall' }), undefined)
    assert.throws(() => installedPackage(['--home', dangling.home], {}), /不一致/)
  } finally { drop(root) }
})

test('⑤foreign family保拒：旧包名/另一版本线不迁移不共装不代卸', () => {
  const root = temp()
  try {
    for (const foreign of ['dsh-tavern-sqlite-v1', 'dsh-tavern-storage-sqlite-v2']) {
      const other = tavernHome(path.join(root, 'other-' + foreign), { dependencies: { [foreign]: 'file:x' }, dsh: { profile: { bundles: [foreign] } } })
      assert.throws(() => installedPackage(['--home', other.home], {}, { action: 'uninstall' }), new RegExp(foreign))
    }
  } finally { drop(root) }
})

// 标准目录（data/plugins）本地执行器定位：真 product 复制到标准目录后，装/卸都必须复用同一位置；
// 双源（标准目录 + profile 同名 dep/bundle）必须拒绝；foreign manifest 与损坏 manifest 都不得被当成可用包。
test('获取器：标准目录本地执行器复用且双源拒绝', async () => {
  const root = temp()
  try {
    // ① 真 product 经 helper 装进本用例自有 home 的标准目录（不走 profile 同名 dep/bundle）
    const home = path.join(root, 'home'), profileDir = path.join(home, 'profiles', 'tavern')
    fs.mkdirSync(profileDir, { recursive: true })
    const profile = { name: 'dsh-profile-tavern', dependencies: {}, dsh: { profile: { bundles: [] } } }
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8')
    const pluginDir = pluginDirFor({ home, packageName: NAME })
    const packageRoot = path.join(root, 'selected-package')
    copyPackage(product, packageRoot)
    const seeded = installOwnedRows('[]\n', { pluginDir, home })
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), seeded.text, 'utf8')
    await createStandardInstallation({ op: { home, profileDir }, adapter: { packageName: NAME }, packageRoot, evidence: path.join(root, 'evidence'), linkPeers: () => {} }).manage('install')
    assert.equal(fs.existsSync(path.join(pluginDir, 'package.json')), true, '标准目录必须已装（真 product 复制）')
    const afterInstall = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(Object.keys(afterInstall.dependencies), [], '标准装配不得写 profile 同名 dep')
    assert.deepEqual(afterInstall.dsh.profile.bundles, [], '标准装配不得写 profile 同名 bundle')
    // ② install / uninstall 都必须定位到同一个标准目录并可复用（同一物理路径）
    const located = installedPackage(['--home', home], {}, { action: 'install' })
    assert.equal(fs.realpathSync(located), fs.realpathSync(pluginDir), 'install 必须定位标准目录并复用同一程序')
    assert.equal(installedPackage(['--home', home], {}, { action: 'uninstall' }), located, 'uninstall 必须复用同一本地执行器')
    assert.equal(validatePackage(located).name, NAME, '标准目录包必须通过完整性校验（真 product，vendor 齐备）')
    // ③ 双源：标准目录之外再补 profile 同名 dep+bundle ⇒ 必须拒绝（不猜哪一份权威）
    const dual = { dependencies: { [NAME]: 'file:x' }, dsh: { profile: { bundles: [NAME] } } }
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(dual, null, 2) + '\n', 'utf8')
    assert.throws(() => installedPackage(['--home', home], {}, { action: 'install' }), Error, '标准目录与 profile 同名装配同时存在必须拒绝')
    // ④ foreign manifest：标准目录里换成别的包名 ⇒ 不得被当作可用本地程序
    const foreignDir = path.join(root, 'foreign-std')
    fs.mkdirSync(foreignDir, { recursive: true })
    fs.writeFileSync(path.join(foreignDir, 'package.json'), JSON.stringify({ name: 'dsh-tavern-sqlite-v1', version: '0.0.1' }) + '\n', 'utf8')
    const foreignHome = path.join(root, 'foreign-home'), foreignProfile = path.join(foreignHome, 'profiles', 'tavern')
    fs.mkdirSync(foreignProfile, { recursive: true })
    fs.writeFileSync(path.join(foreignProfile, 'package.json'), JSON.stringify({ name: 'dsh-profile-tavern', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2) + '\n', 'utf8')
    const foreignPluginDir = pluginDirFor({ home: foreignHome, packageName: NAME })
    fs.mkdirSync(path.dirname(foreignPluginDir), { recursive: true })
    fs.cpSync(foreignDir, foreignPluginDir, { recursive: true })
    assert.throws(() => installedPackage(['--home', foreignHome], {}, { action: 'install' }), Error, 'foreign manifest 不得冒认可用本包')
    // ⑤ 损坏 manifest：解析即抛（危险未知归属不得被静默当成 usable）
    fs.writeFileSync(path.join(foreignPluginDir, 'package.json'), '{ 不是合法 JSON\n', 'utf8')
    assert.throws(() => installedPackage(['--home', foreignHome], {}, { action: 'install' }), /JSON|Unexpected|Syntax/i, '损坏 manifest 必须解析失败而非静默可用')
  } finally { drop(root) }
})

// 静态文本对齐：install.sh 内嵌的获取器必须与 bootstrap.mjs 同一函数**同文本**（单次比对，不执行发行构建、不算 SHA）。
test('获取器：install.sh 内嵌体与 bootstrap 源同文本', () => {
  const read = rel => fs.readFileSync(path.join(product, rel), 'utf8')
  const slice = (text, source) => {
    const start = text.indexOf('export function installedPackage')
    assert.notEqual(start, -1, source + ' 必须含 export function installedPackage')
    const stop = text.indexOf('\n//', start)
    return text.slice(start, stop === -1 ? text.length : stop).trimEnd()
  }
  assert.equal(slice(read('deploy/install.sh'), 'deploy/install.sh'), slice(read('deploy/bootstrap.mjs'), 'deploy/bootstrap.mjs'), '内嵌获取器与源必须逐字一致')
})
