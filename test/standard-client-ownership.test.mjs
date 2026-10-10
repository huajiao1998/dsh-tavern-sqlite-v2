// 标准客户端单源装配（只证**元数据**有效；不起 GUI、不 serve、不假造 API、不改共享 tmp fixture）。
// 真身：把本机 dsh-client-modules fixture **复制到本 test 自建 mkdtemp**，仅把它的**唯一**框架 import
// （`@deepseek-ai/cordis` 的 Service）重写为当前 DSH checkout 经 createRequire 解析出的绝对 file URL；
// 算法与其他 import 一字不改（Object.create 用法不触发 Service 构造，元数据方法保持原函数）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const pluginRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceFixture = path.join(workspace, 'tmp/plg-standard-1001-loader/dsh-client-modules/lib/index.js')
assert.ok(existsSync(sourceFixture), '需要本机 dsh-client-modules 源码（只读、不修改）：' + sourceFixture)

// 唯一框架依赖：按当前 DSH checkout 真实解析（不猜 libs、不装包）
const checkout = process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app'
const requireFromCheckout = createRequire(path.join(checkout, 'package.json'))
const cordisUrl = pathToFileURL(requireFromCheckout.resolve('@deepseek-ai/cordis')).href

const tempDir = mkdtempSync(path.join(os.tmpdir(), 'standard-client-ownership-'))
const copiedPath = path.join(tempDir, 'client-modules.js')
const sourceText = readFileSync(sourceFixture, 'utf8')
const FRAMEWORK_IMPORT = 'import { Service } from "@deepseek-ai/cordis";'
assert.equal(sourceText.split(FRAMEWORK_IMPORT).length - 1, 1, '框架 import 必须恰一处（bounded set）')
const rewrittenText = sourceText.replace(FRAMEWORK_IMPORT, 'import { Service } from ' + JSON.stringify(cordisUrl) + ';')
assert.notEqual(rewrittenText, sourceText, '必须真的重写框架 import')
const leftovers = rewrittenText.match(/from\s+"@deepseek-ai\/[^"]+"/g) || []
assert.deepEqual(leftovers, [], '除 cordis 外不得再有未解析的框架 specifier：' + leftovers.join(','))
writeFileSync(copiedPath, rewrittenText, 'utf8')
const { ClientModuleRegistry } = await import(pathToFileURL(copiedPath).href)
const EARLY = ['bootstrap/session-persistence.js', 'bootstrap/host-patch.js', 'bootstrap/standard-host.js']

test.after(() => { rmSync(tempDir, { recursive: true, force: true }) })

test('标准客户端：普通入口单源声明浏览器且三early入口不声明', async () => {
  // 真 registry：只补真实现需要的字段（pkgMeta 缓存、ctx.loader 空对象 ⇒ 走 nearestPackage 文件回退）
  const baseUrl = pathToFileURL(path.join(pluginRoot, 'package.json')).href
  // 真 iterator 只在 entry.fiber !== undefined 时才消费；disabled:false 表示入口未被禁用
  const entryOf = name => ({ options: { name, disabled: false }, fiber: {}, parent: { tree: { ctx: { baseUrl } } } })
  const entries = [path.join(pluginRoot, 'plugin.js'), ...EARLY.map(name => path.join(pluginRoot, name))]
  const registry = Object.create(ClientModuleRegistry.prototype)
  registry.pkgMeta = new Map()
  // ctx.loader 至少要有 entries()（真 processOne 会遍历它）；本例只喂真实四个入口
  registry.ctx = { loader: { entries: () => entries.map(entryOf) }, logger: { warn: () => {} } }

  // ① 普通入口 plugin.js → 真 locatePkgJson/nearestPackage 命中本包 package.json ⇒ 有 dsh.client 元数据
  const root = registry.resolveMeta(path.join(pluginRoot, 'plugin.js'), baseUrl)
  assert.ok(root, '普通入口必须解析到客户端元数据（单源声明）')
  // 真返回形状（探针实测）：{ packageName, meta: { clientPath, inject, external, immediately } }
  assert.equal(root.packageName, 'dsh-tavern-sqlite-v2', '元数据必须归属本包（单源）')
  const clientPath = String(root.meta?.clientPath ?? '')
  assert.match(clientPath, /client\.js$/, '客户端入口必须是我们自己的 client.js：' + clientPath)
  assert.ok(Array.isArray(root.meta?.inject) && root.meta.inject.includes('dsh-tavern-plugin'),
    '浏览器半边必须声明注入作者 UI 服务包 dsh-tavern-plugin：' + JSON.stringify(root.meta?.inject))

  // ② 三个 early/bootstrap 入口：不是 dsh.client 根 ⇒ 一律 null
  for (const entry of EARLY) {
    assert.equal(registry.resolveMeta(path.join(pluginRoot, entry), baseUrl), null, entry + ' 不得声明浏览器半边')
  }

  // ③ 同 baseUrl 下真 resolveSource：普通入口给 source（sourceKey＝baseUrl\0loaderName，真实现 L727），early 给 undefined
  const asEntry = entryOf
  const rootSource = registry.resolveSource(asEntry(path.join(pluginRoot, 'plugin.js')))
  assert.ok(rootSource && rootSource.meta?.clientPath, '普通入口必须产出客户端 source（含 meta.clientPath）')
  assert.equal(rootSource.sourceKey, baseUrl + '\u0000' + path.join(pluginRoot, 'plugin.js'), 'sourceKey 必须按真实现拼接')
  for (const entry of EARLY) {
    assert.equal(registry.resolveSource(asEntry(path.join(pluginRoot, entry))), undefined, entry + ' 不得产出客户端 source')
  }

  // ④ 真 processOne（存在时）：元数据单源 ⇒ 客户端组合表只允许一个条目
  assert.equal(typeof registry.processOne, 'function', '真实现必须提供 processOne（本叶不软跳过）')
  registry.sources = new Map()
  registry.table = new Map()
  registry.initialRevisionNonce = 'test'
  registry.nextInitialRevision = 1
  for (const name of entries) await registry.processOne(name, error => { throw error })
  assert.equal(registry.table.size, 1, '元数据单源 ⇒ 客户端组合表只允许一个条目')
  const record = [...registry.table.values()][0]
  // 真行形状：{ entry, loaderName, sourceKey, meta, bundle, baseline }
  assert.ok(record?.meta, '组合表条目必须带真元数据：' + JSON.stringify(record && Object.keys(record)))
  assert.ok(Array.isArray(record.meta.inject) && record.meta.inject.includes('dsh-tavern-plugin'),
    '组合后的入口必须仍注入作者 UI 服务包：' + JSON.stringify(record.meta.inject))
  assert.match(String(record.meta.clientPath || ''), /client\.js$/, '组合行必须指向我们的 client.js')
})

test('标准客户端：a2008bf保护入口与三early组合仍只有一个来源', async () => {
  const baseUrl = pathToFileURL(path.join(pluginRoot, 'package.json')).href
  const guard = path.join(pluginRoot, '.tavern-entry.mjs')
  const entries = [guard, ...EARLY.map(name => path.join(pluginRoot, name))]
  const entryOf = name => ({ options: { name, disabled: false }, fiber: {}, parent: { tree: { ctx: { baseUrl } } } })
  const registry = Object.create(ClientModuleRegistry.prototype)
  registry.pkgMeta = new Map()
  registry.ctx = { loader: { entries: () => entries.map(entryOf) }, logger: { warn: () => {} } }
  registry.sources = new Map()
  registry.table = new Map()
  registry.initialRevisionNonce = 'guard-test'
  registry.nextInitialRevision = 1
  const meta = registry.resolveMeta(guard, baseUrl)
  assert.equal(meta?.packageName, 'dsh-tavern-sqlite-v2')
  assert.match(String(meta?.meta.clientPath), /client\.js$/)
  assert.equal(registry.resolveSource(entryOf(guard))?.sourceKey, baseUrl + '\u0000' + guard)
  for (const name of entries.slice(1)) assert.equal(registry.resolveSource(entryOf(name)), undefined, name)
  for (const name of entries) await registry.processOne(name, error => { throw error })
  assert.equal(registry.table.size, 1, '保护入口改名后不得与bootstrap形成客户端双源')
  const record = [...registry.table.values()][0]
  assert.equal(record.loaderName, guard)
  assert.ok(record.meta.inject.includes('dsh-tavern-plugin'))
})
