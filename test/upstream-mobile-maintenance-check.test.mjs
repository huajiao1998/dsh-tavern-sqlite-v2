// 8480f7de 维护检查回归：CLI实际check函数 + 双平台真driver；仅外部进程/宿主能力探针用桩。
// 所有目标均为自有临时home；缺固定夹具/字节错代即失败，不接触真实程序或存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { createDriver, createDesktopDriver } from '../deploy/maintenance/driver.mjs'
import { checkMaintenance } from '../deploy/maintenance/runner.mjs'
import { sourceAccess, STANDARD_RECORD } from '../deploy/maintenance/source.mjs'
import { maintenanceBudget } from '../deploy/maintenance/budget.mjs'

const author = fileURLToPath(new URL('../../../tmp/upstream-main-8480/dsh-tavern-main/', import.meta.url))
const product = fileURLToPath(new URL('../', import.meta.url))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
// 从固定8480清单核对，不能把任意main/同SemVer树当成受测新代。
const pins = {
  'lib/index.js': 'edcacf4bbe4b1b221613a8610f730f3931af744cafc33b24224419e469e8901a',
  'lib/http/routes.js': '0d2b144d934d8e7b5398e8b21ce62d8d0dd3cf8e8614a5507c719089919123d9',
  'src/client/main.js': '44c96e6ab39a21d49f825ef7a32b3bd30d9d0bdbbde6e51e2ebbbe28a3ec3c96',
  'lib/client.js': '0228caeec357ea5b0ab00a5bc42015215dbd151fa485c44d0ecb4943dae3b65e',
  'lib/domain/png-thumbnail.js': '59d51e4a8f459d9a57b660f5066bc9f8499edba5b3d6fe4a762fc64467eb7d6f',
}
for (const [rel, hash] of Object.entries(pins)) {
  const file = path.join(author, 'tavern-plugin', rel)
  assert.ok(existsSync(file), '缺8480f7de固定夹具：' + rel)
  assert.equal(digest(readFileSync(file)), hash, '8480f7de夹具字节错代：' + rel)
}

function fixture(t, host) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'v2-mobile-check-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-mobile-check-')); rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), app = path.join(home, 'apps', 'dsh-tavern')
  cpSync(path.join(author, 'tavern-plugin'), path.join(app, 'tavern-plugin'), { recursive: true })
  const profileDir = path.join(home, 'profiles', 'tavern')
  mkdirSync(profileDir, { recursive: true })
  const profileFile = path.join(profileDir, 'package.json'), patch = path.join(profileDir, 'cordis.patch.yml')
  writeFileSync(profileFile, JSON.stringify({ name: 'dsh-profile-tavern', dependencies: {}, dsh: { profile: { bundles: [] } } }) + '\n', 'utf8')
  writeFileSync(patch, '[]\n', 'utf8')
  const peerRoot = path.join(home, 'runtime', 'lib', 'node_modules')
  const desktopApp = path.join(root, 'desktop-program')
  const pkg = JSON.parse(readFileSync(path.join(product, 'package.json'), 'utf8'))
  const peers = Object.keys(pkg.peerDependencies)
  for (const peer of peers) {
    for (const base of [peerRoot, path.join(desktopApp, 'node_modules')]) {
      const dir = path.join(base, ...peer.split('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: peer, version: '0.1.5-rc.2' }) + '\n', 'utf8')
    }
  }
  const evidence = path.join(home, 'maintenance', adapter.packageName, 'check-1')
  mkdirSync(evidence, { recursive: true })
  const op = { home, app, profile: 'tavern', profileDir, host, port: '3081', check: true }
  const budget = maintenanceBudget({ milliseconds: 240000 }), probes = []
  const runPackage = async (exe, args) => { probes.push({ exe, args }); return '' }
  const cli = path.join(home, 'runtime', 'bin', 'dsh')
  const driver = host === 'desktop'
    ? createDesktopDriver(op, adapter, product, evidence, budget, {
      runtime: { desktop: { root: path.join(root, 'desktop-runtime'), appDir: desktopApp, peerRoot, electronVersion: 'synthetic' } },
      runPackage, presence: () => [], logger: { warn() {} },
    })
    : createDriver(op, adapter, product, evidence, budget, {
      platform: 'linux', processFinder: () => null, runtimeResolver: () => ({ cli, cliEntries: [cli] }),
      runPackage, runCommand: () => '', portOpen: async () => false,
    })
  const source = sourceAccess(app, adapter.targets)
  const capture = () => ({ source: source.capture(), profile: readFileSync(profileFile), patch: readFileSync(patch) })
  const run = () => checkMaintenance({ action: 'install', adapter, driver, source, evidenceDir: evidence, budget })
  return { app, source, evidence, profileFile, peerRoot, peers, probes, capture, run }
}

for (const host of ['cli', 'desktop']) {
  test('8480f7de ' + host + '：真实维护check分支通过，目标源码/profile逐字不变', async t => {
    const f = fixture(t, host), before = f.capture()
    const result = await f.run()
    assert.equal(result.check, true)
    assert.equal(result.changed, false, '预演副本changed不得冒充目标已修改')
    assert.equal(result.ready, true)
    assert.equal(result.initialState, 'stopped')
    assert.ok(f.probes.length >= 2, '只桩外部探针，真driver必须走到能力检查')
    assert.deepEqual(f.capture(), before, '检查不得改变任何有限源码或profile')
    assert.equal(existsSync(path.join(f.app, STANDARD_RECORD)), false)
    assert.equal(existsSync(path.join(f.evidence, 'rehearsal', STANDARD_RECORD)), true, '真正接缝预演必须在证据目录发生')
  })
  test('8480f7de ' + host + '：未知作者契约仍拒绝且目标零改', async t => {
    const f = fixture(t, host), file = path.join(f.app, 'tavern-plugin', 'package.json')
    const pkg = JSON.parse(readFileSync(file, 'utf8')); pkg.version = '9.9.9'; pkg.main = './unknown-contract.js'
    writeFileSync(file, JSON.stringify(pkg) + '\n', 'utf8')
    const before = f.capture()
    await assert.rejects(f.run(), /与可信基线不兼容|作者版本未适配/)
    assert.deepEqual(f.capture(), before)
  })
  test('8480f7de ' + host + '：不同代明确是插件0.2.2与待装包差异，仍拒覆盖且目标零改', async t => {
    const f = fixture(t, host), installed = path.join(path.dirname(f.profileFile), 'node_modules', adapter.packageName)
    mkdirSync(installed, { recursive: true })
    writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: adapter.packageName, version: '0.2.2', files: ['marker.txt'] }) + '\n', 'utf8')
    writeFileSync(path.join(installed, 'marker.txt'), '合成旧代插件\n', 'utf8')
    writeFileSync(f.profileFile, JSON.stringify({ name: 'dsh-profile-tavern', dependencies: { [adapter.packageName]: 'link:' + installed }, dsh: { profile: { bundles: [adapter.packageName] } } }) + '\n', 'utf8')
    const before = f.capture(), pendingVersion = JSON.parse(readFileSync(path.join(product, 'package.json'), 'utf8')).version
    await assert.rejects(f.run(), error => {
      assert.match(error.message, /现装不同代：现装插件 0\.2\.2/)
      assert.ok(error.message.includes('待装插件 ' + pendingVersion))
      assert.match(error.message, /非酒馆版本不匹配/)
      assert.ok(error.message.includes(installed))
      return true
    })
    assert.deepEqual(f.capture(), before)
    assert.equal(JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')).version, '0.2.2')
  })
  test('8480f7de ' + host + '：宿主peer版本不匹配仍拒绝且目标零改', async t => {
    const f = fixture(t, host), file = path.join(f.peerRoot, ...f.peers[0].split('/'), 'package.json')
    writeFileSync(file, JSON.stringify({ name: f.peers[0], version: '0.1.5-rc.1' }) + '\n', 'utf8')
    const before = f.capture()
    await assert.rejects(f.run(), /既有宿主peer缺失\/未适配/)
    assert.deepEqual(f.capture(), before)
  })
}
