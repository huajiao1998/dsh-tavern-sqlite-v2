// 共用runner+真实双平台driver的停止态夹具；不接触实机或数据，不桩源码/装配清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { sourceAccess, assertSourceUninstalled } from '../deploy/maintenance/source.mjs'
import { loadAuthorCleanImages } from '../deploy/maintenance/residual-uninstall.mjs'
import { createDriver, createDesktopDriver } from '../deploy/maintenance/driver.mjs'
import { executeMaintenance, checkMaintenance } from '../deploy/maintenance/runner.mjs'
import { maintenanceBudget } from '../deploy/maintenance/budget.mjs'
const product = fileURLToPath(new URL('../', import.meta.url))
const catalog = loadAuthorCleanImages()
function fixture(t, host) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'v2-residual-driver-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('v2-residual-driver-')); rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), app = path.join(home, 'apps', 'dsh-tavern'), profileDir = path.join(home, 'profiles', 'tavern'), evidence = path.join(home, 'maintenance', adapter.packageName, 'fixture')
  mkdirSync(profileDir, { recursive: true }); mkdirSync(evidence, { recursive: true })
  const tree = catalog.trees.find(tree => tree.commit.startsWith('8480f7de'))
  for (const [rel, item] of Object.entries(tree.files)) if (item) { const file = path.join(app, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(item.body, 'base64')) }
  writeFileSync(path.join(app, '.dsh-tavern-release.json'), JSON.stringify({ commit: tree.commit }), 'utf8')
  const installed = path.join(profileDir, 'node_modules', adapter.packageName)
  mkdirSync(installed, { recursive: true })
  // 旧代包已坏：只留manifest，既无vendor也无lib；bundle项缺失，模拟安装中断。
  writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ name: adapter.packageName, version: '0.2.2' }), 'utf8')
  const profile = { name: 'fixture', dependencies: { [adapter.packageName]: 'file:old-broken', keep: '1' }, dsh: { profile: { bundles: ['keep'] } }, settings: { preserve: true } }
  writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(profile) + '\n', 'utf8')
  const patch = '[]\n'; writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')
  const sentinel = path.join(home, 'profile-data', 'tavern', 'data', 'user-data-sentinel')
  mkdirSync(path.dirname(sentinel), { recursive: true }); writeFileSync(sentinel, '合成原件和SQLite数据不动\n', 'utf8')
  const source = sourceAccess(app, adapter.targets), events = []
  const runtime = { cli: path.join(home, 'runtime', 'bin', 'dsh'), cliEntries: [], desktop: { root: root, appDir: root, peerRoot: root, electronVersion: 'synthetic' } }
  const op = { home, app, profile: 'tavern', profileDir, host, action: 'uninstall' }
  const makeDriver = ev => host === 'desktop'
    ? createDesktopDriver(op, adapter, product, ev, maintenanceBudget(), { runtime, presence: () => [], runPackage: async () => { throw Error('卸载不能依赖探针/包管理') }, logger: { warn() {} } })
    : createDriver(op, adapter, product, ev, maintenanceBudget(), { runtimeResolver: () => runtime, platform: 'linux', processFinder: () => null, runPackage: async () => { throw Error('卸载不能依赖探针/包管理') }, runCommand: () => { throw Error('停止态不能启动服务') } })
  const run = (ev = evidence) => executeMaintenance({ action: 'uninstall', adapter, driver: makeDriver(ev), source, evidenceDir: ev, progress: text => events.push(text), budget: maintenanceBudget() })
  return { root, home, app, profileDir, evidence, source, events, installed, sentinel, makeDriver, run }
}
for (const host of ['cli', 'desktop']) {
  test('兜底卸载 ' + host + '：坏旧包/半装配不阻挡，停态不启动，重复卸载幂等，数据不动', async t => {
    const f = fixture(t, host)
    const result = await f.run()
    assert.equal(result.verified, true)
    assert.equal(result.fallback, true)
    assert.equal(result.initialState, 'stopped'); assert.equal(result.finalState, 'stopped')
    assert.equal(existsSync(f.installed), false)
    const profile = JSON.parse(readFileSync(path.join(f.profileDir, 'package.json'), 'utf8'))
    assert.deepEqual(profile.dependencies, { keep: '1' }); assert.deepEqual(profile.dsh.profile.bundles, ['keep']); assert.deepEqual(profile.settings, { preserve: true })
    assert.equal(readFileSync(path.join(f.profileDir, 'cordis.patch.yml'), 'utf8'), '[]\n')
    assert.equal(readFileSync(f.sentinel, 'utf8'), '合成原件和SQLite数据不动\n')
    assertSourceUninstalled(f.source)
    const next = path.join(f.home, 'maintenance', adapter.packageName, 'second'); mkdirSync(next)
    const repeated = await f.run(next); assert.equal(repeated.changed, false); assert.equal(repeated.verified, true)
  })
  test('兜底卸载 ' + host + '：验收失败恢复原源码和半装配，不伪报成功', async t => {
    const f = fixture(t, host), before = f.source.capture(), profile = readFileSync(path.join(f.profileDir, 'package.json'))
    const driver = f.makeDriver(f.evidence)
    driver.verify = async () => { throw Error('合成验收失败') }
    await assert.rejects(executeMaintenance({ action: 'uninstall', adapter, driver, source: f.source, evidenceDir: f.evidence, budget: maintenanceBudget() }), /合成验收失败/)
    assert.deepEqual(f.source.capture(), before)
    assert.deepEqual(readFileSync(path.join(f.profileDir, 'package.json')), profile)
    assert.ok(existsSync(f.installed))
    assert.equal(JSON.parse(readFileSync(path.join(f.installed, 'package.json'), 'utf8')).version, '0.2.2')
    assert.equal(readFileSync(f.sentinel, 'utf8'), '合成原件和SQLite数据不动\n')
  })
  test('兜底卸载 ' + host + '：共用check分支只读，不改变源码/profile或服务', async t => {
    const f = fixture(t, host), before = f.source.capture(), profile = readFileSync(path.join(f.profileDir, 'package.json'))
    const result = await checkMaintenance({ action: 'uninstall', adapter, driver: f.makeDriver(f.evidence), source: f.source, evidenceDir: f.evidence, budget: maintenanceBudget() })
    assert.equal(result.check, true); assert.equal(result.changed, false)
    assert.deepEqual(f.source.capture(), before)
    assert.deepEqual(readFileSync(path.join(f.profileDir, 'package.json')), profile)
    assert.ok(existsSync(f.installed))
  })
}
