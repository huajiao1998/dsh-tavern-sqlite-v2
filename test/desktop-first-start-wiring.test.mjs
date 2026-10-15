// 首启接线集成：真实安装产物→冻结patch→rc.2 Loader/Registry→浏览器ModuleSystem/Loader。
// 作者业务、slots渲染及命令注册为边界适配；不启动桌面、不读取任何真实数据、不调用清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { createStandardInstallation, ORDINARY_ROW_ID, PERSISTED_ROWS } from '../deploy/maintenance/standard-installation.mjs'

const product = fileURLToPath(new URL('../', import.meta.url))
const desktopRuntime = process.env.DSH_TAVERN_TEST_DESKTOP_RUNTIME || 'D:/Program Files (x86)/DSH-Tavern/runtime-9be856025c1522cb-setup7-5ae29095747f4f4a9fc3f12a68611fd7/resources/app'
const runtimeRequire = createRequire(path.join(desktopRuntime, 'package.json'))
const loadRuntime = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)

test('桌面首启真实容器：安装快照无需scanner即注册普通host、唯一client及共享清理服务，依赖等待与dispose有效', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'desktop-first-start-wiring-'))
  let host, browser
  t.after(async () => {
    await browser?.fiber.dispose()
    await host?.fiber.dispose()
    assert.ok(path.basename(root).startsWith('desktop-first-start-wiring-'))
    rmSync(root, { recursive: true, force: true })
  })
  const home = path.join(root, 'home'), profileDir = path.join(home, 'profiles', 'tavern')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(path.join(profileDir, 'package.json'), '{"name":"dsh-profile-tavern","dsh":{"profile":{"bundles":[]}}}\n', 'utf8')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  const assembly = createStandardInstallation({ op: { home, profileDir }, adapter: { packageName: 'dsh-tavern-sqlite-v2' }, packageRoot: product, evidence: path.join(root, 'evidence') })
  await assembly.preflight('install')
  await assembly.manage('install')
  const { boot, loadOverlayPatches } = await loadRuntime('@deepseek-ai/dsh-app-boot')
  const { Context } = await loadRuntime('@deepseek-ai/cordis')
  const { Loader } = await loadRuntime('@deepseek-ai/cordis-plugin-loader')
  const { ClientModuleRegistry } = await loadRuntime('@deepseek-ai/dsh-client-modules')
  // 与Desktop一致：在作者扫描之前冻结配置，不手动syncUserPlugins补入口。
  const frozen = structuredClone(loadOverlayPatches('first-start-test', path.join(profileDir, 'cordis.patch.yml')))
  const rows = frozen.flatMap(op => op.insert || [])
  assert.ok(PERSISTED_ROWS.every(row => rows.some(item => item.id === row.id)), '冻结快照包含三early')
  const ordinary = rows.filter(row => row.id === ORDINARY_ROW_ID)
  assert.equal(ordinary.length, 1, '未扫描快照必须已有普通入口')
  assert.ok(ordinary[0].name.endsWith('/plugin.js'), '由boot解析器把确切普通入口锚定为file URL')
  const pluginDir = path.join(home, 'profile-data', 'tavern', 'data', 'plugins', 'dsh-tavern-sqlite-v2')
  assert.equal(existsSync(path.join(pluginDir, '.tavern-entry.mjs')), false, '首启不依赖稍后生成的guard')
  const rootConfig = path.join(profileDir, 'root.yml')
  writeFileSync(rootConfig, '[]\n', 'utf8')
  const handlers = new Map(), commands = new Map()
  const register = table => (key, value) => { table.set(key, value); return () => table.delete(key) }
  const actions = Object.fromEntries(['status', 'prepare', 'claim', 'complete', 'recover', 'release', 'variables'].map(key => [key, () => { throw Error('首启测试不调用业务') }]))
  // 不执行SQLite早期业务或作者apply：只让真实普通插件消费其公开宿主边界。
  host = await boot('first-start-test', rootConfig, [{ insert: ordinary }], async ctx => {
    ctx.loader.internal = undefined
    ctx.provide('tavern', { handle: register(handlers) })
    ctx.provide('tavernSaveActions', actions)
    ctx.provide('commands', { register: definition => register(commands)(definition.name, definition) })
    await ctx.plugin(ClientModuleRegistry)
  })
  // 根 include 的 entry id 带 `include:` 前缀（rc.2 dsh-app-boot 实测），子树按 `:` 分段解析
  assert.equal(host.loader.resolve('include:' + ORDINARY_ROW_ID).fiber.state, 2, '真实普通host fiber激活')
  assert.equal(handlers.size, 7, '七项自有RPC已注册')
  assert.deepEqual([...commands.keys()].sort(), ['tavern-save', 'tavern-vars'])
  const registry = host.get('clientModules'), graph = registry.graph()
  assert.equal(graph.entries.filter(row => row.id === 'dsh-tavern-sqlite-v2').length, 1, '真实registry提供唯一client图项')
  assert.equal(registry.clientPath('dsh-tavern-sqlite-v2'), path.join(pluginDir, 'client.js'))
  for (const early of PERSISTED_ROWS) assert.equal(registry.resolveMeta(pathToFileURL(path.join(pluginDir, early.file)).href, host.baseUrl), null, 'bootstrap不贡献第二client来源')
  // 真实浏览器模块系统处理factory和arrival；只替换script传输为registry的实际combo响应。
  const facade = { mode: 'queue', pendingQueue: [], load(definition) { this.pendingQueue.push(definition) } }
  const realm = vm.createContext({ window: { __ModuleLoader__: facade }, console, setTimeout, clearTimeout, AbortSignal })
  const moduleBundle = path.join(path.dirname(runtimeRequire.resolve('@deepseek-ai/dsh-client-modules')), 'client.js')
  vm.runInContext(readFileSync(moduleBundle, 'utf8'), realm)
  const bootstrap = facade.pendingQueue.shift()
  const exports = bootstrap.factory(() => { throw Error('modules bootstrap不应require业务') })
  const moduleSystem = exports.createClientModuleSystem(facade, { id: bootstrap.id, exports }, {
    boot: graph, staticModules: { react: { createElement: (...args) => args } },
    loadBundle: async url => {
      const response = registry.fetchBundle({ method: 'GET', url })
      assert.equal(response.status, 200)
      vm.runInContext(await response.text(), realm)
    },
  })
  browser = new Context()
  await browser.plugin(Loader)
  browser.loader.internal = moduleSystem
  await browser.loader.create({ id: 'storage-ui', name: 'dsh-tavern-sqlite-v2' })
  assert.equal(browser.loader.resolve('storage-ui').fiber.state, 0, '没有作者桥等依赖时真实fiber等待')
  assert.equal(browser.get('tavernStorageUi'), undefined, '未用直接apply绕过激活')
  const occupants = new Map()
  const dependencies = browser.plugin({ name: 'author-boundaries', apply(ctx) {
    ctx.provide('sessions', { subagentAddress: () => undefined })
    ctx.provide('slots', { inject: (_slot, supply) => supply(), register: (definition, render) => register(occupants)(definition.id, render) })
    ctx.provide('tavernStorageView', { apiVersion: 2 })
    ctx.provide('tavernUi', {})
  } })
  await dependencies
  await browser.loader.await()
  assert.equal(browser.loader.resolve('storage-ui').fiber.state, 2)
  assert.equal(typeof browser.get('tavernStorageUi')?.cleanFailure, 'function', '共享服务由真实激活提供')
  assert.deepEqual([...occupants.keys()].sort(), ['dsh-tavern-sqlite-v2:save'])
  await browser.loader.remove('storage-ui')
  assert.equal(browser.get('tavernStorageUi'), undefined, '卸载释放共享服务')
  assert.equal(occupants.size, 0, '卸载释放唯一页头UI注册')
  // 真实 Group API：子树 full id 只用于 resolve；remove 要传该子树本地键（entry.options.id）
  const ordinaryEntry = host.loader.resolve('include:' + ORDINARY_ROW_ID)
  await ordinaryEntry.parent.remove(ordinaryEntry.options.id)
  assert.equal(handlers.size, 0, '卸载释放七项handler')
  assert.equal(commands.size, 0, '卸载释放两条命令')
})
