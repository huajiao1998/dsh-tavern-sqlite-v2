// bootstrap兜底定向验证（2026-10-07）：零deps+vendor四入口；缺vendor拒；卸载半装/无包不absent早退；
// 安装半装严格拒；悬空链接容忍；foreign family保拒。全部原创微型替身，不联网、不读真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { bootstrapOptions, installedPackage, validatePackage, selectLocal, bootstrap } from '../deploy/bootstrap.mjs'

const NAME = 'dsh-tavern-sqlite-v2'
const VENDOR = ['lib/vendor/lodash/lodash.min.js', 'lib/vendor/json5/index.mjs', 'lib/vendor/jsonrepair/esm/index.js', 'lib/vendor/yaml/dist/index.js']
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
/** 微型完整包：零运行时依赖 + vendor账本四入口 + 维护链（asset为随包资产，module为被引用模块）。 */
function tinyPackage(dir, { version = '0.2.8', asset = null, module = null, extra = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  for (const rel of FILES) write(path.join(dir, rel))
  write(path.join(dir, 'deploy', 'maintenance', 'runner.mjs'), maintenanceSource({ asset, module }))
  for (const rel of VENDOR) write(path.join(dir, rel))
  write(path.join(dir, 'lib', 'vendor', 'manifest.json'), JSON.stringify({ packages: { lodash: { version: '1.0.0' }, json5: { version: '1.0.0' }, jsonrepair: { version: '1.0.0' }, yaml: { version: '1.0.0' } } }))
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

test('①validatePackage：零deps+vendor四入口+维护链资产齐备即通过；缺vendor/声明依赖保拒', () => {
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
