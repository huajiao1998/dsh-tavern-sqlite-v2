// standard-host 回归闸：标准装包路径的宿主包装控制器（纯 DI，不需要真实 ctx / 不装任何包）
//
// 为什么这样测：真身接口（cordis-plugin-loader 1.0.3 / cordis 4.0.2 / dsh-client-modules 0.1.5-rc.2）
// 的关键语义是 "disabled ⇒ 不 import"、"create == import+apply+await fiber"、"Loader.write() no-op"
// （见 lib/standard-host.js 头部锚点）。本闸用**照该契约写的假 loader**驱动控制器，
// 断言的是控制器自己的判定/顺序/清理责任，**不冒充**真实装配已被验证（真实装配仍须现场跑）。
//   node test/standard-host.test.mjs
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  AUTHOR_VERSION,
  BOOT_PACKAGE_NAME,
  BOOT_VERSION,
  DEFAULT_ALLOWED_DEPENDENT_ROWS,
  ORIGINAL_ROW_ID,
  ORIGINAL_ROW_NAME,
  OWNED_MARKER,
  RUNTIME_PACKAGE_NAME,
  RUNTIME_VERSION,
  STANDARD_HOST_ROW_ID,
  apply,
  assertAuthorManifest,
  assertNoImportedDependents,
  assertRuntimeVersions,
  createStandardHostApply,
  deriveAppDir,
  findImportedAuthorDependents,
  inject,
  resolveAuthorEntry,
  resolvePackageVersion,
  resolveRuntimeVersions,
  runtimeDirectPaths,
  startStandardHost,
} from '../lib/standard-host.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'lib', 'standard-host.js')
const APP = path.resolve(path.join(path.sep, 'app-under-test'))
const AUTHOR_ENTRY = path.join(APP, 'tavern-plugin', 'lib', 'index.js')
const AUTHOR_URL = pathToFileURL(AUTHOR_ENTRY).href
const AUTHOR_PKG = { name: ORIGINAL_ROW_NAME, version: AUTHOR_VERSION }
let passed = 0
function ok(label) { passed += 1; console.log('  ✓ ' + label) }

// ---------------------------------------------------------------------------
// 假件（照 rc.2 契约：entries() 可迭代 / create(options,parent) / remove(id) 异步 / store 公开）
// ---------------------------------------------------------------------------
function makeEntry(options, { fiber = undefined } = {}) {
  return { options, fiber, disabled: options.disabled === true }
}
function makeOriginalRow({ disabled = true, fiber = undefined, name = ORIGINAL_ROW_NAME, config, inject: rowInject } = {}) {
  const options = { id: ORIGINAL_ROW_ID, name }
  if (disabled !== undefined) options.disabled = disabled
  if (config !== undefined) options.config = config
  if (rowInject !== undefined) options.inject = rowInject
  const entry = makeEntry(options, { fiber })
  // 真身里 Entry.parent 是 EntryGroup，其 tree.ctx.baseUrl 是 include 树（根配置文件所在目录）
  entry.parent = { tree: { ctx: { baseUrl: pathToFileURL(APP + path.sep).href } } }
  return entry
}
function makeLoader({ entries = [], store = {}, order = [], onCreate, onRemove } = {}) {
  const calls = { create: [], remove: [] }
  const loader = {
    store,
    entries: () => entries,
    async create(options, parent, position) {
      calls.create.push({ options, parent, position })
      order.push('create')
      if (onCreate) return await onCreate({ options, parent, position, store })
      const id = options.id
      store[id] = makeEntry({ ...options }, { fiber: { state: 2 } })
      return id
    },
    async remove(id) {
      calls.remove.push(id)
      order.push('remove')
      if (onRemove) await onRemove({ id, store })
      delete store[id]
    },
  }
  return { loader, calls }
}
function makeAuthor(overrides = {}) {
  return {
    url: AUTHOR_URL,
    entryPath: AUTHOR_ENTRY,
    packageDir: path.dirname(path.dirname(AUTHOR_ENTRY)),
    packageJson: { ...AUTHOR_PKG },
    version: AUTHOR_VERSION,
    appDir: APP,
    source: 'original-entry-path',
    attempts: [],
    ...overrides,
  }
}
function makeRuntime(overrides = {}) {
  return {
    dsh: { name: RUNTIME_PACKAGE_NAME, version: RUNTIME_VERSION, path: '/rt/dsh/package.json', source: 'runtime-modules' },
    boot: { name: BOOT_PACKAGE_NAME, version: BOOT_VERSION, path: '/rt/boot/package.json', source: 'runtime-modules' },
    loader: { name: '@deepseek-ai/cordis-plugin-loader', version: '1.0.3' },
    cordis: { name: '@deepseek-ai/cordis', version: '4.0.2' },
    anchors: [],
    attempts: [],
    ...overrides,
  }
}
function baseArgs(extra = {}) {
  const order = []
  const rows = extra.rows ?? [makeOriginalRow({ inject: ['fs', 'tools'] })]
  const { loader, calls } = makeLoader({
    entries: rows, store: extra.store, order, onCreate: extra.onCreate, onRemove: extra.onRemove,
  })
  return {
    order, loader, calls,
    args: {
      loader,
      resolveAuthor: async () => makeAuthor(extra.author),
      resolveRuntime: async () => makeRuntime(extra.runtime),
      prepare: (info) => { order.push('prepare:' + String(info.mode)); return { ready: true, mode: info.mode, applied: false } },
      uninstall: (info) => { order.push('uninstall:' + String(info.reason)) },
      preflight: () => { order.push('preflight') },
      ...extra.args,
    },
  }
}
async function expectThrow(fn, pattern) {
  try {
    await fn()
  } catch (error) {
    assert.ok(error instanceof Error, '应抛 Error')
    if (pattern) assert.match(error.message, pattern)
    return error
  }
  assert.fail('本应抛错但没有：' + pattern)
}
// 缝库的**可信 stub**：applyStandardSeams 成功后 checkStandardSeams 必须转 ready（真身就是这样：
// apply 写完后 check 复检才 ready；不会被恒 false 的 stub 骗出"假成功"路径）。
// uninstall 的返回值也照真身（deploy/standard-seams.mjs:155）：{changed, requiresRestart, restored, legacySeamsRemain}
function makeSeams({ ready = true, changed = true, order = [] } = {}) {
  const state = { ready, changed, applied: 0, uninstalled: [] }
  return {
    state,
    seams: {
      checkStandardSeams: () => { order.push('check'); return { ready: state.ready, coverage: 'standard-core' } },
      applyStandardSeams: () => { order.push('apply'); state.applied += 1; if (state.changed) state.ready = true; return { changed: state.changed, ready: true } },
      uninstallStandardSeams: (info) => {
        order.push('uninstall')
        state.uninstalled.push(info)
        return { changed: true, requiresRestart: true, restored: 'standard-generation-before-image', legacySeamsRemain: false }
      },
    },
  }
}

console.log('standard-host 回归闸')

// 1) 常量与导出
assert.deepEqual([...inject], ['loader'], '行级 inject 必须是 [loader]')
assert.equal(typeof apply, 'function', 'apply 必须是函数（生产导出）')
assert.equal(STANDARD_HOST_ROW_ID, 'dsh-tavern-storage-author-host-v2', '固定 id 必须是可判归属的专名')
assert.deepEqual([...DEFAULT_ALLOWED_DEPENDENT_ROWS], ['tavern-cordis-inspect'], '默认只放行已核对的 inspect 行')
assert.equal(RUNTIME_VERSION, '0.1.5-rc.2')
assert.equal(BOOT_VERSION, '0.1.5-rc.2')
ok('常量与导出（id/inject/runtime 版本/默认放行名单）')

// 2) 原行仍启用 ⇒ 拒绝，且不预检、不施缝、不建行
{
  const { args, calls, order } = baseArgs({ rows: [makeOriginalRow({ disabled: false })] })
  const error = await expectThrow(() => startStandardHost(args), /仍是启用态/)
  assert.match(error.message, new RegExp(ORIGINAL_ROW_ID))
  assert.equal(calls.create.length, 0, '覆盖失败时不得建行')
  assert.deepEqual(order, [], '覆盖失败时不得进入预检/施缝')
  ok('原行未禁用 ⇒ 拒绝（不晚 disable 已 import 的树）')
}

// 3) 原行已挂载（fiber 存在）⇒ 拒绝，即使 disabled 为 true
{
  const { args, calls } = baseArgs({ rows: [makeOriginalRow({ disabled: true, fiber: { state: 2 } })] })
  await expectThrow(() => startStandardHost(args), /已经被 import 并挂载/)
  assert.equal(calls.create.length, 0)
  ok('原行已有 fiber ⇒ 拒绝')
}

// 4) 原行不存在 / name 不符 ⇒ 拒绝
{
  const { args } = baseArgs({ rows: [] })
  await expectThrow(() => startStandardHost(args), /找不到作者主行/)
  const { args: args2 } = baseArgs({ rows: [makeOriginalRow({ name: 'dsh-tavern-plugin-renamed' })] })
  await expectThrow(() => startStandardHost(args2), /找不到作者主行/)
  ok('原行缺失 / name 不符 ⇒ 拒绝')
}

// 5) 作者版本门禁：仅已适配2.5.0；旧2.4和未知补丁版均写前拒绝。
{
  assert.equal(AUTHOR_VERSION, '2.5.0')
  for (const version of ['2.4.0', '2.5.1']) {
    const { args, calls, order } = baseArgs({ author: { packageJson: { name: ORIGINAL_ROW_NAME, version }, version } })
    await expectThrow(() => startStandardHost(args), /版本不符/)
    assert.equal(calls.create.length, 0)
    assert.deepEqual(order, [])
  }
  ok('作者仅2.5.0；旧2.4与未知版本均在施缝前拒绝')
}

// 6) runtime exact 门禁：dsh / boot 路径都要对得上，且早期拒绝（不施缝不建行）
{
  const { args, calls, order } = baseArgs({ runtime: { dsh: { name: RUNTIME_PACKAGE_NAME, version: '0.1.5-rc.1' } } })
  const error = await expectThrow(() => startStandardHost(args), /runtime 版本门禁未通过/)
  assert.match(error.message, /@deepseek-ai\/dsh/)
  assert.equal(calls.create.length, 0)
  assert.deepEqual(order, [], '版本门禁失败不得进入预检/施缝')

  const { args: bootBad } = baseArgs({ runtime: { boot: { name: BOOT_PACKAGE_NAME, version: '0.2.0-rc.2' } } })
  const bootError = await expectThrow(() => startStandardHost(bootBad), /runtime 版本门禁未通过/)
  assert.match(bootError.message, /@deepseek-ai\/dsh-app-boot/)

  const { args: missing } = baseArgs({
    runtime: {
      dsh: { name: RUNTIME_PACKAGE_NAME, version: undefined },
      boot: { name: BOOT_PACKAGE_NAME, version: undefined },
      attempts: ['runtime-modules: 无 /rt/dsh/package.json'],
    },
  })
  const missingError = await expectThrow(() => startStandardHost(missing), /runtime 版本门禁未通过/)
  assert.match(missingError.message, /解析明细/, '解析不到时必须带明细')
  ok('runtime 门禁：dsh/boot 不符或缺 → 拒绝（含解析明细）')
}

// 7) app 定位失败且未显式给 appDir ⇒ 拒绝（不靠 cwd 猜）
{
  const { args } = baseArgs({ author: { appDir: undefined, appDirReason: '入口路径形状不符' } })
  await expectThrow(() => startStandardHost(args), /拿不到 app 树根/)
  const { args: withAppDir } = baseArgs({ author: { appDir: undefined, appDirReason: '入口路径形状不符' }, args: { appDir: APP } })
  const dispose = await startStandardHost(withAppDir)
  assert.equal(typeof dispose, 'function', '显式 appDir 应可继续')
  await dispose()
  ok('拿不到 appDir ⇒ 拒绝；显式 appDir ⇒ 继续')
}

// 8) 快乐路径：顺序 = preflight → prepare(create) → create → 返回 disposer
{
  const { args, order, calls, loader } = baseArgs()
  const dispose = await startStandardHost(args)
  assert.equal(typeof dispose, 'function', '必须返回 disposer 函数（cordis 合法 effect）')
  assert.deepEqual(order, ['preflight', 'prepare:create', 'create'], 'preflight/施缝必须先于 create')
  assert.equal(calls.create.length, 1)
  assert.equal(calls.create[0].parent, null, 'rc.2 必须 parent=null（Loader 根 group，write() no-op）')
  assert.equal(calls.create[0].options.id, STANDARD_HOST_ROW_ID, '根行 id 固定专名')
  assert.equal(calls.create[0].options.name, AUTHOR_URL, 'name 用解析出的 file: URL')
  assert.equal(loader.store[STANDARD_HOST_ROW_ID][OWNED_MARKER], true, '建好的行要被标记为己方')
  await dispose()
  assert.deepEqual(order.slice(3), ['remove', 'uninstall:dispose'], 'disposer：先 remove 成功再 uninstall')
  assert.deepEqual(calls.remove, [STANDARD_HOST_ROW_ID])
  await dispose()
  assert.equal(calls.remove.length, 1, 'disposer 幂等')
  ok('快乐路径顺序 + disposer（remove→uninstall，幂等）')
}

// 9) 默认集成点 options 形状：只带 id/name(+config/inject)，config 引用原样、缺省不塞键
{
  const originalConfig = { custom: 1 }
  const { loader: l1, calls: c1 } = makeLoader({ entries: [makeOriginalRow({ config: originalConfig, inject: ['fs'] })] })
  const { args: a1 } = baseArgs({ args: { loader: l1 } })
  await startStandardHost(a1)
  assert.deepEqual(Object.keys(c1.create[0].options).sort(), ['config', 'id', 'inject', 'name'])
  assert.equal(c1.create[0].options.config, originalConfig, 'config 必须原样传递（同一引用）')
  assert.deepEqual(c1.create[0].options.inject, ['fs'], 'inject 原样传递')
  assert.equal(c1.create[0].parent, null)
  const { loader: l2, calls: c2 } = makeLoader({ entries: [makeOriginalRow({ inject: ['fs'] })] })
  const { args: a2 } = baseArgs({ args: { loader: l2 } })
  await startStandardHost(a2)
  assert.equal('config' in c2.create[0].options, false, '原行无 config 时不该出现 config 键')
  ok('默认集成点 options 形状（config 引用与缺省）')
}

// 10) owned 唯一：同 URL 但无标记 ⇒ 拒绝；带标记 ⇒ adopt（verify-only）
{
  const sameUrlNoMarker = makeEntry({ id: STANDARD_HOST_ROW_ID, name: AUTHOR_URL }, { fiber: { state: 2 } })
  const { args, calls } = baseArgs({ store: { [STANDARD_HOST_ROW_ID]: sameUrlNoMarker } })
  await expectThrow(() => startStandardHost(args), /没有本插件归属标记/)
  assert.equal(calls.create.length, 0, '不得按 URL 认领别人的行')

  const ours = makeEntry({ id: STANDARD_HOST_ROW_ID, name: AUTHOR_URL }, { fiber: { state: 2 } })
  ours[OWNED_MARKER] = true
  const { args: args2, calls: calls2, order } = baseArgs({ store: { [STANDARD_HOST_ROW_ID]: ours } })
  const dispose = await startStandardHost(args2)
  assert.equal(calls2.create.length, 0, 'adopt 语义：不重复挂载作者 host')
  assert.deepEqual(order, ['prepare:verify'], 'adopt 只能走 verify（不得补施缝、不得跳过校验）')
  await dispose()
  assert.deepEqual(calls2.remove, [STANDARD_HOST_ROW_ID])
  assert.deepEqual(order.slice(1), ['remove', 'uninstall:dispose'])
  ok('owned 唯一：标记才能 adopt；同 URL 无标记 ⇒ 拒绝')
}

// 11) 集成失败：清 created row；本次施过缝才回滚，没施过绝不回滚
{
  const store = {}
  const { loader, calls } = makeLoader({
    entries: [makeOriginalRow()],
    store,
    onCreate: async ({ options }) => {
      store[options.id] = makeEntry({ ...options }, { fiber: { state: 2 } })
      throw new Error('integration boom')
    },
  })
  const uninstalls = []
  const { args } = baseArgs({
    args: {
      loader,
      prepare: ({ mode }) => ({ ready: true, mode, applied: true }),
      uninstall: (info) => { uninstalls.push(info.reason) },
    },
  })
  await expectThrow(() => startStandardHost(args), /integration boom/)
  assert.deepEqual(calls.remove, [STANDARD_HOST_ROW_ID], '失败路径必须清理 created row')
  assert.equal(store[STANDARD_HOST_ROW_ID], undefined)
  assert.deepEqual(uninstalls, ['rollback-after-failed-create'], '本次施过缝 ⇒ 必须回滚源码')

  // 清理失败 / 清理被拒 ⇒ **绝不撤缝**（活 row 还在跑，撤源码 = 半坏树），并且响亮抛 AggregateError
  {
    const { loader: lr } = makeLoader({
      entries: [makeOriginalRow()],
      store: {},
      onCreate: async ({ options, store }) => { store[options.id] = makeEntry({ ...options }, { fiber: { state: 2 } }); throw new Error('boom-a') },
      onRemove: async () => { throw new Error('cleanup boom') },
    })
    const u = []
    const { args: a } = baseArgs({ args: { loader: lr, prepare: ({ mode }) => ({ ready: true, mode, applied: true }), uninstall: (info) => { u.push(info.reason) } } })
    await expectThrow(() => startStandardHost(a), /清理 created row 也失败/)
    assert.deepEqual(u, [], '清理失败 ⇒ 保持源码接缝不动')
  }
  {
    const foreignId = STANDARD_HOST_ROW_ID
    const { loader: lf } = makeLoader({
      entries: [makeOriginalRow()],
      store: {},
      onCreate: async ({ options, store }) => { store[options.id] = makeEntry({ ...options, name: 'not-author-url' }, { fiber: { state: 2 } }); throw new Error('boom-b') },
    })
    const u2 = []
    const { args: a2 } = baseArgs({ args: { loader: lf, prepare: ({ mode }) => ({ ready: true, mode, applied: true }), uninstall: (info) => { u2.push(info.reason) } } })
    await expectThrow(() => startStandardHost(a2), /未清掉（reason=not-ours）/)
    assert.ok(lf.store[foreignId] !== undefined && u2.length === 0, '清理被拒 ⇒ 行仍在且不撤缝')
  }

  const { loader: l2 } = makeLoader({
    entries: [makeOriginalRow()],
    store: {},
    onCreate: async () => { throw new Error('integration boom 2') },
  })
  const uninstalls2 = []
  const { args: a2 } = baseArgs({
    args: {
      loader: l2,
      prepare: ({ mode }) => ({ ready: true, mode, applied: false }),
      uninstall: (info) => { uninstalls2.push(info.reason) },
    },
  })
  await expectThrow(() => startStandardHost(a2), /integration boom 2/)
  assert.deepEqual(uninstalls2, [], '没施过缝就绝不回滚（别动既有的缝）')
  ok('集成失败：清 row；仅 applied=true 时回滚缝')
}

// 12) 集成"成功"但 store 里没有行 ⇒ 拒绝登记 ready
{
  const { loader } = makeLoader({ entries: [makeOriginalRow()], onCreate: async () => 'x' })
  const { args } = baseArgs({ args: { loader } })
  await expectThrow(() => startStandardHost(args), /不登记为 ready/)
  ok('拿不到 owned 行 ⇒ 不伪 ready')
}

// 13) exact 缓存预检：默认放行已核对的 inspect；其它已挂载子路径行仍拒绝
{
  const inspect = makeEntry({ id: 'tavern-cordis-inspect', name: ORIGINAL_ROW_NAME + '/cordis-inspect' }, { fiber: { state: 2 } })
  const original = makeOriginalRow()
  const loader = { entries: () => [original, inspect], store: {} }
  assert.deepEqual(assertNoImportedDependents({ loader }), { pending: [] }, '默认名单应放行 inspect')
  const other = makeEntry({ id: 'tavern-other', name: ORIGINAL_ROW_NAME + '/other' }, { fiber: { state: 2 } })
  const loader2 = { entries: () => [original, inspect, other], store: {} }
  await expectThrow(() => assertNoImportedDependents({ loader: loader2 }), /tavern-other/)
  // controller 层：显式名单就是最终名单（DI 可预测）；追加语义由 apply 层的并集负责（见 17b）
  assert.deepEqual(
    assertNoImportedDependents({ loader: loader2, allowedDependentRows: ['tavern-cordis-inspect', 'tavern-other'] }),
    { pending: [] },
  )
  await expectThrow(() => assertNoImportedDependents({ loader: loader2, allowedDependentRows: ['tavern-other'] }), /tavern-cordis-inspect/)
  const notMounted = makeEntry({ id: 'x1', name: ORIGINAL_ROW_NAME + '/a' })
  const disabledRow = makeEntry({ id: 'x2', name: ORIGINAL_ROW_NAME + '/b', disabled: true }, { fiber: { state: 2 } })
  const otherPkg = makeEntry({ id: 'x3', name: 'other-plugin/sub' }, { fiber: { state: 2 } })
  assert.deepEqual(
    findImportedAuthorDependents({ entries: () => [original, notMounted, disabledRow, otherPkg] }, {}),
    [],
    '未挂载/禁用/别包都不进清单',
  )
  ok('exact 依赖行预检（默认放行 inspect，其余拒绝；不探测 ESM 缓存）')
}

// 14) 纯函数：deriveAppDir / assertAuthorManifest
{
  assert.equal(deriveAppDir({ packageDir: path.join(APP, 'tavern-plugin') }).appDir, APP)
  assert.equal(deriveAppDir({ entryPath: AUTHOR_ENTRY }).appDir, APP)
  const bad = deriveAppDir({ packageDir: path.join(APP, 'other-pkg'), entryPath: path.join(APP, 'other-pkg', 'lib', 'index.js') })
  assert.equal(bad.appDir, undefined)
  assert.match(bad.reason, /tavern-plugin/)
  assert.deepEqual(assertAuthorManifest(AUTHOR_PKG), AUTHOR_PKG)
  await expectThrow(() => assertAuthorManifest({ name: 'x', version: AUTHOR_VERSION }), /包名不符/)
  await expectThrow(() => assertAuthorManifest({ name: ORIGINAL_ROW_NAME, version: '9.9.9' }), /版本不符/)
  await expectThrow(() => assertAuthorManifest(undefined), /无法解析/)
  ok('deriveAppDir（三层 dirname）与 manifest 门禁为纯函数')
}

// 15) resolveAuthorEntry：path-like 直接用；profile 锚兜底；全失败列 attempts；不用 cwd
{
  const dshHome = path.resolve(path.join(path.sep, 'dsh-home-under-test'))
  const files = new Map()
  files.set(path.join(APP, 'tavern-plugin', 'package.json'), AUTHOR_PKG)
  files.set(AUTHOR_ENTRY, true)
  const io = {
    exists: (p) => files.has(p),
    readPackageJson: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error('ENOENT ' + p)
      return v
    },
  }
  let resolveCalls = 0
  const direct = resolveAuthorEntry({
    originalEntry: makeOriginalRow({ name: AUTHOR_ENTRY }),
    ...io,
    resolveInstalled: () => { resolveCalls += 1; throw new Error('不应被调用') },
    dshHome,
  })
  assert.equal(direct.source, 'original-entry-path')
  assert.equal(direct.url, AUTHOR_URL)
  assert.equal(direct.appDir, APP)
  assert.deepEqual(direct.packageJson, AUTHOR_PKG)
  assert.equal(resolveCalls, 0, 'path-like 分支不得再去 require 解析')

  const profileAnchor = path.join(dshHome, 'profiles', 'tavern', 'package.json')
  const viaProfile = resolveAuthorEntry({
    originalEntry: makeOriginalRow(),
    ...io,
    dshHome,
    resolveInstalled: (spec, anchor) => {
      assert.equal(spec, ORIGINAL_ROW_NAME)
      if (anchor === profileAnchor) return AUTHOR_ENTRY
      throw new Error('not found at ' + anchor)
    },
  })
  assert.equal(viaProfile.source, 'profile-anchor')
  assert.equal(viaProfile.appDir, APP)
  assert.match(viaProfile.attempts[0], /include-base/)

  const error = await expectThrow(() => resolveAuthorEntry({
    originalEntry: makeOriginalRow(),
    ...io,
    dshHome,
    resolveInstalled: () => { throw new Error('nope') },
  }), /不做 cwd 猜测/)
  for (const source of ['include-base', 'profile-anchor', 'author-tree']) {
    assert.match(error.message, new RegExp(source), 'attempts 应列出 ' + source)
  }
  ok('resolveAuthorEntry：入口/锚点顺序 + 失败明细（无 cwd 兜底）')
}

// 16) runtime 解析与门禁（DI io）：双候选直读（runtime/node_modules 优先）→ 锚点兜底；门禁 exact
{
  // fixture 用**目标实根**（B：DSH_HOME=/root/tavern-clean/home），不换成仓内 grep 假设
  const REAL_HOME = '/root/tavern-clean/home'
  const direct = runtimeDirectPaths(REAL_HOME)
  const dshCandidates = direct[RUNTIME_PACKAGE_NAME]
  const bootCandidates = direct[BOOT_PACKAGE_NAME]
  assert.equal(dshCandidates.length, 2, '每个包两个 runtime 候选')
  assert.match(dshCandidates[0], /runtime[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]package\.json$/, '第一候选 = runtime/node_modules（目标真身）')
  assert.match(dshCandidates[1], /runtime[\\/]lib[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh[\\/]package\.json$/, '第二候选 = runtime/lib/node_modules（在产脚本写法）')
  assert.match(bootCandidates[0], /runtime[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-app-boot[\\/]package\.json$/)

  const [dshFirst] = dshCandidates
  const [, bootSecond] = bootCandidates
  const profileAnchor = path.join(REAL_HOME, 'profiles', 'tavern', 'package.json')
  const resolved = resolveRuntimeVersions({
    dshHome: REAL_HOME,
    includeBase: pathToFileURL(APP + path.sep).href,
    exists: (p) => p === dshFirst || p === bootSecond,
    readPackageJson: (p) => {
      if (p === dshFirst) return { name: RUNTIME_PACKAGE_NAME, version: RUNTIME_VERSION }
      if (p === bootSecond) return { name: BOOT_PACKAGE_NAME, version: BOOT_VERSION }
      throw new Error('ENOENT ' + p)
    },
    resolveInstalled: () => { throw new Error('直读命中时不该走锚点') },
  })
  assert.equal(resolved.dsh.source, 'runtime-modules')
  assert.equal(resolved.dsh.path, dshFirst, '第一候选命中')
  assert.equal(resolved.boot.path, bootSecond, '第二候选也要被用到')
  assert.deepEqual(assertRuntimeVersions(resolved), { dsh: RUNTIME_VERSION, boot: BOOT_VERSION, loader: undefined, cordis: undefined })

  // 锚点兜底仍然可用（直读两个候选都缺时）
  const dshAnchorPath = path.join(REAL_HOME, 'profile-node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const viaAnchor = resolveRuntimeVersions({
    dshHome: REAL_HOME,
    includeBase: pathToFileURL(APP + path.sep).href,
    exists: () => false,
    readPackageJson: (p) => {
      if (p === dshAnchorPath) return { name: RUNTIME_PACKAGE_NAME, version: RUNTIME_VERSION }
      throw new Error('ENOENT ' + p)
    },
    resolveInstalled: (spec, anchor) => {
      if (spec === RUNTIME_PACKAGE_NAME + '/package.json' && anchor === profileAnchor) return dshAnchorPath
      throw new Error('no ' + spec + ' at ' + anchor)
    },
  })
  assert.equal(viaAnchor.dsh.source, 'anchor:' + profileAnchor)
  assert.match(viaAnchor.attempts.join('\n'), /runtime[\\/]node_modules/, 'attempts 应含两个直读候选')

  await expectThrow(() => assertRuntimeVersions({ ...resolved, boot: { version: 'x' }, attempts: ['a'] }), /解析明细/)
  await expectThrow(() => assertRuntimeVersions(undefined), /拿不到 runtime 版本信息/)
  const one = resolvePackageVersion('@deepseek-ai/nope', {
    directPaths: {}, anchors: ['/a/package.json'], resolveInstalled: () => { throw new Error('boom') },
  })
  assert.equal(one.version, undefined)
  assert.match(one.attempts[0], /boom/)
  ok('runtime 双候选（node_modules 优先）+ 锚点兜底 + exact 门禁')
}

// 17) apply：返回 disposer；check 通过不施缝，未就绪才施缝；dispose 顺序 remove→uninstall
{
  const order = []
  const { seams, state } = makeSeams({ ready: true, changed: true, order })
  const runApply = createStandardHostApply({
    loadSeams: async () => seams,
    overrides: {
      resolveAuthor: async () => makeAuthor(),
      resolveRuntime: async () => makeRuntime(),
      preflight: () => order.push('preflight'),
    },
  })
  const { loader, calls } = makeLoader({ entries: [makeOriginalRow({ inject: ['fs'] })], order })
  const warns = []
  const ctx = {
    get: (name) => (name === 'loader' ? loader : undefined),
    logger: { warn: (...args) => warns.push(args), info: () => {} },
  }
  const dispose = await runApply(ctx, { appDir: APP })
  assert.equal(typeof dispose, 'function', 'apply 必须返回函数（disposer），不能返回 id/句柄/错误对象')
  assert.deepEqual(order, ['preflight', 'check', 'create'], 'exact 预检 → 施缝预检 → create（拒绝先于写盘）')
  assert.equal(state.applied, 0, 'ready=true 时不得施缝')
  assert.equal(calls.create.length, 1)
  const disposed = await dispose()
  assert.equal(disposed.removed, true, 'disposer 应如实返回 remove 结果')
  assert.equal(disposed.requiresRestart, true, 'uninstall 的 requiresRestart 不许丢，要如实返回')
  assert.equal(disposed.legacySeamsRemain, false)
  assert.ok(
    warns.some((args) => String(args[0]).includes('requiresRestart')),
    'requiresRestart 必须进 logger.warn（cordis 不消费返回值）',
  )
  assert.deepEqual(order.slice(3), ['remove', 'uninstall'])
  assert.equal(state.uninstalled.length, 1)
  assert.equal(state.uninstalled[0].reason, 'dispose')

  state.ready = false
  const { loader: l2 } = makeLoader({ entries: [makeOriginalRow({ inject: ['fs'] })] })
  const dispose2 = await createStandardHostApply({
    loadSeams: async () => seams,
    overrides: { resolveAuthor: async () => makeAuthor(), resolveRuntime: async () => makeRuntime(), preflight: () => {} },
  })({ get: (n) => (n === 'loader' ? l2 : undefined) }, { appDir: APP })
  assert.equal(typeof dispose2, 'function')
  assert.equal(state.applied, 1, '未就绪时必须施缝（并回报 applied）')
  await dispose2()
  ok('apply：disposer + check→(apply)→create→remove→uninstall')
}

// 17b) apply 层：行 config 的放行名单是**并集**（不会顶掉已核对的默认 inspect）
{
  const order = []
  const { seams } = makeSeams({ ready: true, order })
  const inspect = makeEntry({ id: 'tavern-cordis-inspect', name: ORIGINAL_ROW_NAME + '/cordis-inspect' }, { fiber: { state: 2 } })
  const { loader } = makeLoader({ entries: [makeOriginalRow({ inject: ['fs'] }), inspect], order })
  const dispose = await createStandardHostApply({
    loadSeams: async () => seams,
    overrides: { resolveAuthor: async () => makeAuthor(), resolveRuntime: async () => makeRuntime(), preflight: undefined },
  })({ get: (n) => (n === 'loader' ? loader : undefined) }, { appDir: APP, allowedDependentRows: ['tavern-other'] })
  assert.equal(typeof dispose, 'function', '追加名单不应把默认 inspect 顶掉')
  await dispose()
  ok('apply 层放行名单 = 默认 ∪ config（追加语义）')
}

// 18) apply：集成失败且本次施过缝 ⇒ 回滚缝（reason 明确）
{
  const order = []
  const { seams, state } = makeSeams({ ready: false, changed: true, order })
  const { loader } = makeLoader({
    entries: [makeOriginalRow({ inject: ['fs'] })],
    onCreate: async () => { throw new Error('mount boom') },
  })
  await expectThrow(() => createStandardHostApply({
    loadSeams: async () => seams,
    overrides: { resolveAuthor: async () => makeAuthor(), resolveRuntime: async () => makeRuntime(), preflight: () => {} },
  })({ get: (n) => (n === 'loader' ? loader : undefined) }, { appDir: APP }), /mount boom/)
  assert.equal(state.applied, 1)
  assert.equal(state.uninstalled.length, 1, '本次施过缝 ⇒ 失败即回滚')
  assert.equal(state.uninstalled[0].reason, 'rollback-after-failed-create')
  ok('apply：失败 after 施缝 ⇒ 回滚记录（rollback-after-failed-create）')

  // 说谎 stub（apply 不把 ready 修好）必须被"施缝后复检"抓住 —— 复检就是为此存在的
  const lyingUninstalls = []
  const lying = {
    checkStandardSeams: () => ({ ready: false }),
    applyStandardSeams: () => ({ changed: true }),
    uninstallStandardSeams: (info) => { lyingUninstalls.push(info.reason); return { changed: true } },
  }
  const { loader: l3, calls: c3 } = makeLoader({ entries: [makeOriginalRow({ inject: ['fs'] })] })
  await expectThrow(() => createStandardHostApply({
    loadSeams: async () => lying,
    overrides: { resolveAuthor: async () => makeAuthor(), resolveRuntime: async () => makeRuntime(), preflight: () => {} },
  })({ get: (n) => (n === 'loader' ? l3 : undefined) }, { appDir: APP }), /施缝后复检仍未就绪/)
  assert.equal(c3.create.length, 0, '复检未就绪 ⇒ 绝不挂作者 host')
  assert.deepEqual(lyingUninstalls, ['failed-postcheck'], '复检失败必须就地回滚本次施的缝（prepare 在 create-try 之外）')
  ok('apply：说谎 stub（施缝后仍 not ready）⇒ 复检拒绝 + 就地回滚缝')
}

// 19) apply：adopt（有标记）但缝未就绪 ⇒ 拒绝补施缝（不得在已 import 的作者树上写缝）
{
  const order = []
  const { seams, state } = makeSeams({ ready: false, order })
  const ours = makeEntry({ id: STANDARD_HOST_ROW_ID, name: AUTHOR_URL }, { fiber: { state: 2 } })
  ours[OWNED_MARKER] = true
  const { loader } = makeLoader({ entries: [makeOriginalRow()], store: { [STANDARD_HOST_ROW_ID]: ours } })
  await expectThrow(() => createStandardHostApply({
    loadSeams: async () => seams,
    overrides: { resolveAuthor: async () => makeAuthor(), resolveRuntime: async () => makeRuntime() },
  })({ get: (n) => (n === 'loader' ? loader : undefined) }, { appDir: APP }), /拒绝在已 import 的作者树上补施缝/)
  assert.equal(state.applied, 0, 'verify-only 路径绝不能施缝')
  assert.equal(loader.store[STANDARD_HOST_ROW_ID], ours, '拒绝时不得动别人的 owned 行')
  ok('adopt + 缝未就绪 ⇒ 拒绝补施缝')
}

// 20) disposer 安全 shutdown：remove 失败不撤缝；行非我方也拒绝撤缝
{
  const { args, order, loader } = baseArgs({ onRemove: async () => { throw new Error('remove boom') } })
  const dispose = await startStandardHost(args)
  await expectThrow(() => dispose(), /remove boom/)
  assert.deepEqual(order.filter((x) => x.startsWith('uninstall')), [], 'remove 失败后绝不能卸源码接缝')
  assert.ok(loader.store[STANDARD_HOST_ROW_ID] !== undefined, 'remove 失败时行仍在（源码不动）')

  const { args: a2, order: order2 } = baseArgs()
  const dispose2 = await startStandardHost(a2)
  a2.loader.store[STANDARD_HOST_ROW_ID] = makeEntry({ id: STANDARD_HOST_ROW_ID, name: 'someone-else' }, { fiber: { state: 2 } })
  await expectThrow(() => dispose2(), /不是我方行/)
  assert.deepEqual(order2.filter((x) => x.startsWith('uninstall')), [], '归属不明时不得撤缝')
  ok('disposer 安全 shutdown：remove 失败/归属不明 ⇒ 不撤缝')
}

// 21) 无 store 门面（仅 entries/create/remove/resolve）同样可用
{
  const order = []
  const rows = new Map([[ORIGINAL_ROW_ID, makeOriginalRow({ inject: ['fs'] })]])
  let ownedEntry
  const loader = {
    entries: () => [...rows.values()],
    async create(options, parent) {
      assert.equal(parent, null)
      ownedEntry = makeEntry({ ...options }, { fiber: { state: 2 } })
      ownedEntry[OWNED_MARKER] = true
      rows.set(options.id, ownedEntry)
      order.push('create')
      return options.id
    },
    async remove(id) { order.push('remove'); rows.delete(id); ownedEntry = undefined },
    resolve(id) {
      if (!rows.has(id)) throw new Error('cannot resolve entry ' + id)
      return rows.get(id)
    },
  }
  const dispose = await startStandardHost({
    loader,
    resolveAuthor: async () => makeAuthor(),
    resolveRuntime: async () => makeRuntime(),
    prepare: ({ mode }) => { order.push('prepare:' + mode); return { ready: true, mode, applied: false } },
    uninstall: ({ reason }) => { order.push('uninstall:' + reason) },
    preflight: () => { order.push('preflight') },
  })
  assert.equal(ownedEntry[OWNED_MARKER], true)
  await dispose()
  assert.deepEqual(order, ['preflight', 'prepare:create', 'create', 'remove', 'uninstall:dispose'])
  ok('无 store 门面（仅 entries/create/remove/resolve）同样可用')
}

// 22) apply：缝模块缺导出 ⇒ 响亮失败（不静默降级）
{
  const runApply = createStandardHostApply({ loadSeams: async () => ({ checkStandardSeams: () => ({ ready: true }) }) })
  const { loader } = makeLoader({ entries: [makeOriginalRow()] })
  await expectThrow(() => runApply({ get: (n) => (n === 'loader' ? loader : undefined) }, {}), /缺少 applyStandardSeams/)
  ok('缝模块缺导出 ⇒ 拒绝')
}

// 23) 负断言（源码层）+ inspect 真身（若已下载）只 import node: 内置
{
  const source = readFileSync(LIB, 'utf8')
  assert.equal(source.includes('process.cwd('), false, '不得凭 cwd 猜测路径')
  assert.equal(/loadCache|getModuleJob|--expose-internals/.test(source), false, '不得造 ESM 缓存侦测')
  assert.equal(source.includes('parent: null'), true, '集成点必须写明 parent=null')
  assert.equal(/from '@deepseek-ai\//.test(source), false, '本模块不得依赖宿主编译包（保持纯 DI）')
  const inspect = path.resolve(HERE, '..', '..', '..', 'tmp', 'plg-standard-1001-code', 'b', 'lib', 'cordis-inspect.js')
  if (existsSync(inspect)) {
    const text = readFileSync(inspect, 'utf8')
    const specifiers = [...text.matchAll(/^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1])
    assert.ok(specifiers.length > 0, 'inspect 真身应至少有一条 import')
    for (const spec of specifiers) assert.ok(spec.startsWith('node:'), 'inspect 只应 import node: 内置，实际：' + spec)
    ok('源码负断言 + inspect 真身只 import node: 内置（缓存安全）')
  } else {
    ok('源码负断言（inspect 真身未下载，跳过缓存安全核对）')
  }
}

console.log(`standard-host: ${passed} 组断言全部通过`)
