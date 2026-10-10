// POSIX 驱动 × 标准装配（data/plugins）首次定向证据：现装态**无 profile 同名链接/dep/bundle**，
// preflight 幂等为真；卸载 + 失败后 restorePackage 必须把包位置/profile/patch 字节还原回原位。
// 合成 scope：不 spawn 真进程、不查真机进程表、不跑真能力探针（runPackage 为计数桩）、不触真实数据；
// 标准装配由真 helper 首造（linkPeers() => {}，本叶不装宿主 peer）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDriver } from '../deploy/maintenance/driver.mjs'
import { maintenanceAdapter } from '../deploy/maintenance.mjs'
import { maintenanceBudget } from '../deploy/maintenance/budget.mjs'
import { copyPackage } from '../deploy/maintenance/runner.mjs'
import { AUTHOR_VERSION } from '../lib/standard-host.js'
import { createStandardInstallation, installOwnedRows, pluginDirFor } from '../deploy/maintenance/standard-installation.mjs'

const product = fileURLToPath(new URL('../', import.meta.url))
const NAME = maintenanceAdapter.packageName
const read = file => readFileSync(file)
const peers = Object.keys(JSON.parse(readFileSync(path.join(product, 'package.json'), 'utf8')).peerDependencies)

test('POSIX标准装配：现装无profile链接仍预检幂等且失败恢复原位', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'posix-standard-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const home = path.join(root, 'home'), app = path.join(home, 'apps', 'dsh-tavern')
  const profileDir = path.join(home, 'profiles', 'tavern'), evidence = path.join(home, 'maintenance', NAME, 'posix-1')
  const runtimeRoot = path.join(home, 'runtime'), runtimeLib = path.join(runtimeRoot, 'lib')
  mkdirSync(profileDir, { recursive: true }); mkdirSync(evidence, { recursive: true }); mkdirSync(runtimeLib, { recursive: true })
  // 宿主 peer 物理源（合成，仅形状；不调用 manage 的 peer 链接）
  for (const peer of peers) {
    const dir = path.join(runtimeLib, 'node_modules', ...peer.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: peer, version: '0.1.5-rc.2' }) + '\n', 'utf8')
  }
  // 作者包身份 + profile（含一个非目标依赖 keep，用合成包保证 before/after 可核）
  mkdirSync(path.join(app, 'tavern-plugin'), { recursive: true })
  writeFileSync(path.join(app, 'tavern-plugin', 'package.json'), JSON.stringify({ name: 'dsh-tavern-plugin', version: AUTHOR_VERSION }) + '\n', 'utf8')
  mkdirSync(path.join(profileDir, 'node_modules', 'keep'), { recursive: true })
  writeFileSync(path.join(profileDir, 'node_modules', 'keep', 'package.json'), JSON.stringify({ name: 'keep', version: '1.0.0' }) + '\n', 'utf8')
  writeFileSync(path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-tavern', dependencies: { keep: '1' }, dsh: { profile: { bundles: ['keep'] } } }, null, 2) + '\n', 'utf8')
  // 标准装配首造：early 行由真 helper 写，包体用真实 product 复制（不装宿主 peer）
  const pluginDir = pluginDirFor({ home, packageName: NAME })
  const packageRoot = path.join(root, 'selected-package')
  copyPackage(product, packageRoot)
  const seeded = installOwnedRows('[]\n', { pluginDir, home })
  assert.equal(seeded.changed, true, '首造必须写出 early 行')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), seeded.text, 'utf8')
  const assembly = createStandardInstallation({ op: { home, profileDir }, adapter: { packageName: NAME }, packageRoot, evidence, linkPeers: () => {} })
  await assembly.manage('install')
  assert.equal(existsSync(path.join(pluginDir, 'package.json')), true, '标准目录必须已装')
  assert.equal(existsSync(path.join(profileDir, 'node_modules', NAME)), false, '标准装配不得在 profile 内留同名链接')
  const before = {
    manifest: read(path.join(pluginDir, 'package.json')),
    profile: read(path.join(profileDir, 'package.json')),
    patch: read(path.join(profileDir, 'cordis.patch.yml')),
    sdk: read(path.join(runtimeLib, 'node_modules', ...peers[0].split('/'), 'package.json')),
  }
  // 驱动：DI 全合成；无原代进程（合法停态），lazy 不 spawn、不查真机
  const probes = []
  const driver = createDriver(
    { home, app, profileDir, profile: 'tavern', host: 'cli', action: 'uninstall', check: false },
    { ...maintenanceAdapter, checkStandardSeams: () => ({ ready: true }) },
    product, evidence, maintenanceBudget({ milliseconds: 60000 }),
    { platform: 'linux', runtimeResolver: () => ({ cli: path.join(runtimeRoot, 'runtime-cli.js') }),
      runPackage: async (exe, args) => { probes.push(args.join(' ')); return '' },
      processFinder: () => null, processReader: () => null, processAlive: () => false,
      portOpen: () => false, runCommand: () => '', request: async () => { throw Error('本叶不发网络请求') } })
  assert.equal(driver.original, undefined, '合法停态：无原代进程快照（本叶不认领运行中实例）')
  const state = await driver.preflight('install')
  // 本夹具只有作者 manifest、无接缝源码，属于源码干净/撤缝态，所以需重接而非 noop；不外推所有标准现装。
  assert.equal(state.noop, false, '本夹具源码干净/撤缝态需要重接，不能作已就绪 noop')
  const again = await driver.preflight('install')
  assert.deepEqual(again, state, '同一现装态下两次预检必须给出相同状态（幂等）')
  assert.deepEqual(read(path.join(pluginDir, 'package.json')), before.manifest, '预检不得改写已装包')
  assert.deepEqual(read(path.join(profileDir, 'cordis.patch.yml')), before.patch, '预检不得改写 patch')
  await driver.manage('uninstall')
  assert.equal(existsSync(pluginDir), false, '卸载必须撤掉标准目录')
  assert.deepEqual(read(path.join(profileDir, 'package.json')), before.profile, '非目标 profile 字段必须原样')
  // 模拟验收失败后恢复：包位置/profile/patch/合成 SDK 必须字节还原
  driver.verify = async () => { throw Error('合成验收失败') }
  await assert.rejects(driver.verify('uninstall'), /合成验收失败/)
  await driver.restorePackage()
  assert.deepEqual(read(path.join(pluginDir, 'package.json')), before.manifest, '包必须回到标准位置且字节一致')
  assert.deepEqual(read(path.join(profileDir, 'package.json')), before.profile, 'profile 字节还原')
  assert.deepEqual(read(path.join(profileDir, 'cordis.patch.yml')), before.patch, 'patch 字节还原')
  assert.deepEqual(read(path.join(runtimeLib, 'node_modules', ...peers[0].split('/'), 'package.json')), before.sdk, '合成 SDK 不得被改')
  assert.ok(probes.length >= 2, '预检仍走既有能力探针调用路径（runPackage 为合成桩，不冒充真探针）')
})
