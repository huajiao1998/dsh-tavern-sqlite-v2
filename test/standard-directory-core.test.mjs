// 仅验本次迁目录实际改变的解析/持久装配路径，不重跑未变的业务算法全集。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { copyPackage } from '../deploy/maintenance/runner.mjs'
import { createStandardInstallation, pluginDirFor } from '../deploy/maintenance/standard-installation.mjs'
import { STORAGE_PACKAGE_RESOLVER } from '../deploy/standard-seam-transforms.mjs'
import { createStandardHostApply, AUTHOR_VERSION, ORIGINAL_ROW_ID, ORIGINAL_ROW_NAME, RUNTIME_PACKAGE_NAME, RUNTIME_VERSION, BOOT_PACKAGE_NAME, BOOT_VERSION } from '../lib/standard-host.js'
const product = fileURLToPath(new URL('../', import.meta.url))
const name = 'dsh-tavern-sqlite-v2'
const write = (file, text) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text, 'utf8') }
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'standard-core-migration-'))
  t.after(() => { assert.ok(path.basename(root).startsWith('standard-core-migration-')); rmSync(root, { recursive: true, force: true }) })
  const home = path.join(root, 'home'), profileDir = path.join(home, 'profiles', 'tavern')
  write(path.join(profileDir, 'package.json'), '{"name":"dsh-profile-tavern","dependencies":{"keep":"1"},"dsh":{"profile":{"bundles":["keep"]}}}\n')
  write(path.join(profileDir, 'cordis.patch.yml'), '# 用户保留\n- insert:\n    - id: keep\n      name: ./keep.js\n')
  return { root, home, profileDir, evidence: path.join(root, 'evidence'), packageDir: pluginDirFor({ home, packageName: name }) }
}

test('标准目录核心：同一解析器保数据库读写回退结算实现及缓存实例', async t => {
  const f = fixture(t)
  const assembly = createStandardInstallation({ op: f, adapter: { packageName: name }, packageRoot: product, evidence: f.evidence })
  await assembly.preflight('install'); await assembly.manage('install')
  // 真作者路径模块的公共数据根接口；本测试只用自己的 home，不 import 作者 apply 或扫描档案。
  const domain = path.join(f.root, 'author', 'tavern-plugin', 'lib', 'domain')
  write(path.join(f.root, 'author', 'tavern-plugin', 'package.json'), '{"type":"module"}\n')
  write(path.join(domain, 'tavern-data.js'), 'export const resolveTavernDataRoot = () => ' + JSON.stringify(path.join(f.home, 'profile-data', 'tavern', 'data')) + '\n')
  write(path.join(domain, 'storage-package.js'), STORAGE_PACKAGE_RESOLVER)
  const resolver = await import(pathToFileURL(path.join(domain, 'storage-package.js')).href)
  for (const [subpath, rel, exported] of [
    ['chat-store', 'chat-sqlite-store.js', 'createChatSqliteStore'],
    ['clean-rollback', 'lib/clean-rollback.js', 'cleanRollback'],
    ['rollback-cleanup', 'lib/rollback-cleanup.js', 'cleanupAfterRollback'],
    ['rollback-barrier', 'lib/rollback-barrier.js', 'rollbackBarrier'],
    ['server-execution', 'lib/server-execution.js', 'createServerExecution'],
    ['server-dependencies', 'lib/server-dependencies.js', 'serverLodash'],
    ['current-variables', 'lib/current-variables.js', 'createCurrentVariableReader'],
  ]) {
    const via = await resolver.storagePackage(subpath), direct = await import(pathToFileURL(path.join(f.packageDir, rel)).href)
    assert.equal(via, direct, subpath + ' 必须命中同一模块实例')
    assert.equal(typeof via[exported], subpath === 'rollback-barrier' ? 'object' : 'function', subpath + ' 出口必须可用')
  }
  const { createChatSqliteStore } = await resolver.storagePackage('chat-store')
  // copy/diff/apply 用真作者 682 模块（只读）；五个投影 helper 是 identity 替身，本叶不证明完整投影等价。
  const authorDomain = path.resolve(product, '../../tmp/release-034-20261008/author-fixture/src/'
    + 'dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain')
  assert.ok(existsSync(path.join(authorDomain, 'json-mutation.js')), '需要真作者 json-mutation（只读）：' + authorDomain)
  const realCopy = await import(pathToFileURL(path.join(authorDomain, 'copy-json-tree.js')).href)
  const realJson = await import(pathToFileURL(path.join(authorDomain, 'json-mutation.js')).href)
  const helpers = {
    copyJsonTree: realCopy.copyJsonTree, diffJson: realJson.diffJson, applyJsonChangesShared: realJson.applyJsonChangesShared,
    projectSceneImageState: value => value, projectChatSessionState: value => value,
    projectDisplayRuntimeState: value => value, projectChatBackgroundConfig: value => value,
    projectSettlementCheckpoint: value => value,
  }
  const dataRoot = path.join(f.root, 'isolated-database')
  // 迁移后**真实读写**＋真实 SQL 计数（代理 statement 记每次 get/all 执行，不测性能数字）
  const executed = []
  const originalPrepare = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const statement = originalPrepare.call(this, sql, ...rest)
    const text = String(sql)
    return new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value !== 'function') return value
        if (prop === 'all' || prop === 'get' || prop === 'run' || prop === 'iterate') {
          return (...args) => { executed.push(text); return value.apply(target, args) }
        }
        return value.bind(target)
      },
    })
  }
  const FULL_MESSAGES = 'SELECT message_index, message_json FROM archive_messages ORDER BY message_index'
  let writer = null, reader = null
  try {
    writer = createChatSqliteStore({ dataRoot, helpers })
    assert.equal(typeof writer.read, 'function'); assert.equal(typeof writer.update, 'function')
    const chat = {
      id: 'standard-dir-chat', sessionId: 'standard-dir-session', mode: 'card', _storageRevision: 1, updatedAt: 1,
      timeline: { schemaVersion: 1, branchId: 'branch-main', revision: 1, participants: {}, operations: {}, checkpoints: [] },
      messages: [0, 1, 2].map(index => ({ role: index % 2 ? 'user' : 'assistant', turn: index + 1, text: 'm' + index })),
    }
    await writer.update(chat.id, () => chat)
    reader = createChatSqliteStore({ dataRoot, helpers })       // 同 module、同 dataRoot 的第二实例
    const first = await reader.read(chat.id)
    assert.equal(first.messages.length, 3, '迁后必须真落库可读')
    assert.ok(executed.some(sql => sql === FULL_MESSAGES), '冷读必须真整表查 messages')
    const mark = executed.length
    const second = await reader.read(chat.id)
    assert.equal(second._storageRevision, first._storageRevision, '同实例热读必须同 revision')
    assert.equal(executed.slice(mark).filter(sql => sql === FULL_MESSAGES).length, 0, '热读不得再整表查 archive_messages')
    // 另一实例（同 module/同 dataRoot）真 patch：读必须新鲜，防迁目录造成不同 instance/句柄缓存
    await writer.patch(chat.id, 1, [
      { op: 'set', path: ['_storageRevision'], value: 2 },
      { op: 'set', path: ['updatedAt'], value: 2 },
      { op: 'set', path: ['messages', 1, 'text'], value: 'm1-new' },
    ])
    const third = await reader.read(chat.id)
    assert.equal(third._storageRevision, 2, '外部（另一实例）提交后不得读到旧档')
    assert.equal(third.messages[1].text, 'm1-new', '另一实例提交的正文必须可见')
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare
    try { if (writer !== null) writer.dispose() } catch { /* 失败路径 */ }
    try { if (reader !== null) reader.dispose() } catch { /* 失败路径 */ }
  }
  assert.equal(existsSync(path.join(f.profileDir, 'node_modules', name)), false, '不能依赖同名 profile 链接')
})

test('标准目录恢复：旧安装升级失败回原位置包及配置字节', async t => {
  const f = fixture(t), oldDir = path.join(f.home, 'plugins', name), link = path.join(f.profileDir, 'node_modules', name)
  copyPackage(product, oldDir)
  const oldManifest = JSON.parse(readFileSync(path.join(oldDir, 'package.json'), 'utf8'))
  oldManifest.exports['.'] = './index.js'
  oldManifest.dsh.bundle = { patch: './cordis.patch.yml' }
  write(path.join(oldDir, 'package.json'), JSON.stringify(oldManifest, null, 2) + '\n')
  const { symlinkSync } = await import('node:fs')
  mkdirSync(path.dirname(link), { recursive: true }); symlinkSync(oldDir, link, process.platform === 'win32' ? 'junction' : 'dir')
  const pkg = JSON.parse(readFileSync(path.join(f.profileDir, 'package.json'), 'utf8'))
  pkg.dependencies[name] = 'link:' + oldDir.split(path.sep).join('/'); pkg.dsh.profile.bundles.push(name)
  write(path.join(f.profileDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  const beforePackage = readFileSync(path.join(f.profileDir, 'package.json')), beforePatch = readFileSync(path.join(f.profileDir, 'cordis.patch.yml')), beforeProgram = readFileSync(path.join(oldDir, 'package.json'))
  const assembly = createStandardInstallation({ op: f, adapter: { packageName: name }, packageRoot: product, evidence: f.evidence })
  const state = await assembly.preflight('install')
  assert.equal(state.layout, 'legacy'); assert.equal(state.upgrading, true)
  await assembly.manage('uninstall'); await assembly.manage('install')
  assert.equal(assembly.assertAssembly('install').layout, 'standard')
  const restored = await assembly.restore()
  assert.equal(restored.layout, 'legacy')
  assert.equal(existsSync(f.packageDir), false)
  assert.deepEqual(readFileSync(path.join(f.profileDir, 'package.json')), beforePackage)
  assert.deepEqual(readFileSync(path.join(f.profileDir, 'cordis.patch.yml')), beforePatch)
  assert.deepEqual(readFileSync(path.join(oldDir, 'package.json')), beforeProgram)
  assert.equal(assembly.assertAssembly('install').present, true, '恢复验收允许原 legacy 装配，不强转标准')
})

test('标准持久区块：正常启动退出只验不写，缺缝拒绝启动', async () => {
  const appDir = path.resolve('standard-persisted-contract'), entryPath = path.join(appDir, 'tavern-plugin', 'lib', 'index.js')
  let ready = true, writes = 0, created = 0, removed = 0
  const original = { options: { id: ORIGINAL_ROW_ID, name: ORIGINAL_ROW_NAME, disabled: true }, disabled: true, parent: { tree: { ctx: { baseUrl: pathToFileURL(appDir + path.sep).href } } } }
  const store = {}, loader = { store, entries: () => [original], async create(options) { created++; store[options.id] = { options, fiber: { state: 2 } }; return options.id }, async remove(id) { removed++; delete store[id] } }
  const apply = createStandardHostApply({ loadSeams: async () => ({ checkStandardSeams: () => ({ ready }), applyStandardSeams: () => { writes++; throw Error('启动不得施缝') }, uninstallStandardSeams: () => { writes++; throw Error('正常退出不得撤缝') } }), overrides: {
    resolveAuthor: async () => ({ url: pathToFileURL(entryPath).href, entryPath, packageDir: path.dirname(path.dirname(entryPath)), packageJson: { name: ORIGINAL_ROW_NAME, version: AUTHOR_VERSION }, version: AUTHOR_VERSION, appDir, source: 'test', attempts: [] }),
    resolveRuntime: async () => ({ dsh: { name: RUNTIME_PACKAGE_NAME, version: RUNTIME_VERSION }, boot: { name: BOOT_PACKAGE_NAME, version: BOOT_VERSION }, loader: { version: '1.0.3' }, cordis: { version: '4.0.2' }, anchors: [], attempts: [] }), preflight: () => {},
  } })
  const ctx = { get: name => name === 'loader' ? loader : undefined, logger: { info() {}, warn() {} } }
  const dispose = await apply(ctx, { appDir, persistedSeams: true })
  await dispose()
  assert.equal(created, 1); assert.equal(removed, 1); assert.equal(writes, 0)
  ready = false
  await assert.rejects(apply(ctx, { appDir, persistedSeams: true }), /正常启动不自动施缝/)
  assert.equal(created, 1); assert.equal(writes, 0, '缺缝不能在启动时重新安装')
})

test('标准目录结算：迁后解析直达真实MVU核心且事务草稿写回', async t => {
  const f = fixture(t)
  const assembly = createStandardInstallation({ op: f, adapter: { packageName: name }, packageRoot: product, evidence: f.evidence })
  await assembly.preflight('install'); await assembly.manage('install')
  const domain = path.join(f.root, 'author', 'tavern-plugin', 'lib', 'domain')
  write(path.join(f.root, 'author', 'tavern-plugin', 'package.json'), '{"type":"module"}\n')
  write(path.join(domain, 'tavern-data.js'), 'export const resolveTavernDataRoot = () => ' + JSON.stringify(path.join(f.home, 'profile-data', 'tavern', 'data')) + '\n')
  write(path.join(domain, 'storage-package.js'), STORAGE_PACKAGE_RESOLVER)
  const resolver = await import(pathToFileURL(path.join(domain, 'storage-package.js')).href)

  // 迁后解析拿真结算实现；**不传 executeCommand** ⇒ 必须落到本包真核心 ./mvu/mvu-update-core.js
  const { createServerExecution } = await resolver.storagePackage('server-execution')
  assert.equal(typeof createServerExecution, 'function')
  const hostCalls = []
  const execution = createServerExecution({
    project: scripts => ({ scripts: Array.isArray(scripts) ? scripts : [] }),
    readCardExtensions: async () => ({ helperScripts: [] }),
    hasScripts: async () => false,
    createRuntime: () => ({ events: [], errors: [], dispatchEvent: () => ({ ok: true, results: [] }), dispose() {} }),
    host: {
      updateVariables: async (...args) => { hostCalls.push(args); return { updated: true, target: { type: 'message' } } },
      updateMessages: async () => ({ updated: true }), createMessages: async () => ({ updated: true }),
    },
  })

  const baseline = { stat_data: { hp: 1 } }
  const draft = {
    id: 'iso-chat', sessionId: 'iso-session', cardPath: 'fixture', mvu: { enabled: true },
    messages: [
      { role: 'user', content: 'story' },
      { role: 'assistant', content: 'reply', variables: [{ stat_data: { hp: 1 } }] },
    ],
  }
  const result = await execution.executeMvuUpdate({
    sessionId: 'iso-session', draft, transaction: { eventId: 'mvu-work:isolated', draft },
    messageId: 1, swipeId: 0,
    commandText: 'story\n\n<json_patch>[{"op":"replace","path":"/hp","value":2}]</json_patch>',
    baselineVariables: baseline,
  })
  assert.equal(result.handled, true, '结算必须被服务端接住：' + JSON.stringify(result))
  assert.equal(result.mode, 'server-compute', '必须走 server-compute 半边')
  assert.equal(draft.messages[1].variables[0].stat_data.hp, 2, '真核心必须把 /hp 写成 2（不是 stub 假成功）')
  // 事务草稿写回是**核心直接写 draft 的变量引用**，不经 Host 外层写、也不提交数据库（host.updateVariables 只服务卡脚本 host API）
  assert.equal(result.variables?.stat_data?.hp, 2, 'return 的变量树必须已写入 hp=2：' + JSON.stringify(result.variables))
  assert.equal(hostCalls.length, 0, '不得越事务另调 Host 外层写（避免二次结算）')
  assert.equal(baseline.stat_data.hp, 1, '原 before 树必须脱离且保持 hp=1')
  assert.notEqual(result.variables, baseline, '写回必须是脱离的新树，不是原 before 引用')
  assert.notEqual(draft.messages[1].variables[0], baseline, '草稿变量同样不得是原 before 引用')
  execution.disposeAll()
})
