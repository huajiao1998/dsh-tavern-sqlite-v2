// 主入口（deploy/apply-seams.mjs）× 「存档格式桥」UI 接缝的集成测试。
// 必要范围（不是全量回归）：
//   ① CLI 三态退出码（--check=3 / apply=0 / uninstall=0）与「零写入」；
//   ② 陌生 UI 源码 ⇒ UI 一侧失败且**不触 host**；
//   ③ 顺序契约：预检（ui+legacy+patchIndex）全部通过才写；UI 先写、host 后写；
//   ④ host 失败 ⇒ 只回退**本次** UI 前像（既有 manifest/backup 不动）；
//   ⑤ host 已就绪、只需补 legacy 而 legacy 施缝失败 ⇒ 同样回退本次 UI 前像；
//   ⑥ uninstall：UI → legacy → main，全部逐字节还原。
// 只用合成整树（mkdtemp 独占 + 删前核对身份）；不跑真实源码树、不部署、不读任何存档数据。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyAllSeams, transformStorageIndex } from '../deploy/apply-seams.mjs'
import { applyLegacyViewSeams } from '../deploy/apply-legacy-view-seams.mjs'
import { applySaveUiSeam, SAVE_UI_MANIFEST, SAVE_UI_MARKER, SAVE_UI_TARGETS } from '../deploy/apply-save-ui-seam.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.resolve(HERE, '../deploy/apply-seams.mjs')
// 作者原始源（v2 host 夹具基材）：三条包线共用的 .tmp-verify-clean-install 快照带的是
// storage-sqlite 代标记，v2 线过不了反向还原守卫；共用快照不能改（storage-sqlite 线靠它跑绿），
// 故 v2 改从作者源派生自己的基线。客户端产物仍取共用快照（与 host 施缝代无关）。
const AUTHOR_ROOT = path.resolve(HERE, '../../../tmp/upstream25-author-fixture/src/dsh-tavern-5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60/tavern-plugin')
const FIXTURES = path.resolve(HERE, '../../../.tmp-verify-clean-install')
const TEMP_PREFIX = '.save-ui-main-entry-'
const INDEX_REL = 'tavern-plugin/lib/index.js'
const MAIN_SHIM_REL = 'tavern-plugin/lib/domain/chat-sqlite-store.js'
const LEGACY_SHIM_REL = 'tavern-plugin/lib/domain/legacy-view-seams.js'
const MANIFESTS = ['.tavern-seams.json', SAVE_UI_MANIFEST, '.tavern-legacy-view-seams.json']
const BACKUP_SUFFIXES = ['.save-ui-seam.backup']
const AUTHOR_LEGACY = {
  'tavern-plugin/lib/domain/tavern-conversation-registry.js': 'lib/domain/tavern-conversation-registry.js',
  'tavern-plugin/lib/domain/conversation-initialization.js': 'lib/domain/conversation-initialization.js',
  'tavern-plugin/lib/domain/session-view-reader.js': 'lib/domain/session-view-reader.js'
}
const AUTHOR_INDEX = path.join(AUTHOR_ROOT, 'lib/index.js')

// 存在性/身份门：基材缺失或已被施缝 ⇒ 立即失败，不用空基线冒充通过。
assert.ok(existsSync(AUTHOR_INDEX), '作者源缺失：' + AUTHOR_ROOT)
for (const rel of Object.values(AUTHOR_LEGACY)) assert.ok(existsSync(path.join(AUTHOR_ROOT, rel)), '作者源缺失：' + rel)
const rawAuthorIndex = readFileSync(AUTHOR_INDEX, 'utf8')
assert.ok(!rawAuthorIndex.includes('createChatSqliteStore(') && !rawAuthorIndex.includes("ctx.provide('tavernChats'"),
  '作者源本身已施缝，拒绝据其推导基线：' + AUTHOR_ROOT)

// 「已施 main」真身 = v2 施缝器对作者原样的输出（用产品代码推导）；再反向还原出作者原样。
const mainReady = transformStorageIndex(rawAuthorIndex)
const authorIndex = mainReady
  .replace("import { createChatSqliteStore } from './domain/chat-sqlite-store.js'\n", '')
  .replace(/  \/\/ \[dsh-tavern-sqlite-v2\] 作者原存储[^\n]*\n  const authorChatStore = (createChatJournalStore\([^\n]*\))\n  \/\/ \[dsh-tavern-sqlite-v2\] 我们的行级 SQLite store[^\n]*\n  const chatJournalStore = createChatSqliteStore\([^\n]*\)\n/, '  const chatJournalStore = $1\n')
  .replace("ctx.effect(() => () => { if (typeof authorChatStore.flushMaintenance === 'function') authorChatStore.flushMaintenance() },", 'ctx.effect(() => () => chatJournalStore.flushMaintenance(),')
  .replace(/  \/\/ \[dsh-tavern-sqlite-v2\] 把聊天存储接口暴露[^\n]*\n  ctx\.provide\('tavernChats', chatPersistence\)\n/, '')
assert.ok(!authorIndex.includes('createChatSqliteStore(') && !authorIndex.includes("ctx.provide('tavernChats'"), 'host fixture 必须回到 main 施缝前')
assert.equal(authorIndex, rawAuthorIndex, '反向还原必须逐字节回到作者原样')

// 客户端：本地只有**构建产物**快照（同版本 src 未知）⇒ 两个目标都用这份产物文本；
// 真实部署必须先在现场对 src 与产物分别 `--check`（见 apply-save-ui-seam.mjs 头部「现状与前置核对」）。
const clientArtifact = readFileSync(path.join(FIXTURES, 'blank-clean-client-0930.js'), 'utf8')

const sources = new Map([
  [INDEX_REL, authorIndex],
  ...Object.entries(AUTHOR_LEGACY).map(([rel, src]) => [rel, readFileSync(path.join(AUTHOR_ROOT, src), 'utf8')]),
  [SAVE_UI_TARGETS[0], clientArtifact],
  [SAVE_UI_TARGETS[1], clientArtifact]
])

const created = []
after(() => {
  for (const dir of created) {
    assert.equal(path.resolve(dir), dir, '临时目录身份核对')
    assert.ok(path.basename(dir).startsWith(TEMP_PREFIX), '只删自己按前缀建的临时目录')
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTree({ client, index } = {}) {
  const dir = mkdtempSync(path.join(HERE, TEMP_PREFIX))
  created.push(dir)
  mkdirSync(path.join(dir, 'tavern-plugin/lib/domain'), { recursive: true })
  mkdirSync(path.join(dir, 'tavern-plugin/src/client'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n', 'utf8')
  for (const [rel, text] of sources) writeFileSync(path.join(dir, rel), text, 'utf8')
  if (client !== undefined) for (const rel of SAVE_UI_TARGETS) writeFileSync(path.join(dir, rel), client, 'utf8')
  if (index !== undefined) writeFileSync(path.join(dir, INDEX_REL), index, 'utf8')
  return dir
}

function run(appDir, flags = []) {
  const result = spawnSync(process.execPath, [SCRIPT, '--app', appDir, ...flags], { stdio: 'ignore' })
  assert.equal(result.error, undefined)
  return result.status
}

function snapshots(appDir) {
  return new Map([...sources.keys()].map(rel => [rel, readFileSync(path.join(appDir, rel), 'utf8')]))
}

function assertTree(appDir, expected) {
  for (const [rel, text] of expected) assert.equal(readFileSync(path.join(appDir, rel), 'utf8'), text, '逐字节还原 ' + rel)
  for (const rel of MANIFESTS) assert.equal(existsSync(path.join(appDir, rel)), false, '不留 ' + rel)
  for (const rel of [MAIN_SHIM_REL, LEGACY_SHIM_REL]) assert.equal(existsSync(path.join(appDir, rel)), false, '不留 ' + rel)
  for (const rel of [...sources.keys()]) {
    for (const suffix of BACKUP_SUFFIXES) {
      assert.equal(existsSync(path.join(appDir, rel + suffix)), false, '不留备份 ' + rel + suffix)
    }
  }
  // main 缝的设计：**首次备份（作者原样）保留**（卸载只恢复 owned manifest 的条目，不删这份恢复用副本）。
  const dir = path.join(appDir, 'tavern-plugin/lib')
  const backups = readdirSync(dir).filter(name => name.includes('.pre-seams-'))
  for (const name of backups) {
    assert.equal(name.startsWith('index.js.pre-seams-'), true, '只应有 index 的 main 首次备份：' + name)
    assert.equal(readFileSync(path.join(dir, name), 'utf8'), authorIndex, 'main 首次备份必须等于作者原样')
  }
}

test('CLI：--check 未施缝 ⇒ 退出码 3，且一个字节都不写', () => {
  const appDir = makeTree()
  const before = snapshots(appDir)
  assert.equal(run(appDir, ['--check']), 3)
  assertTree(appDir, before)
})

test('CLI：UI 陌生源码 ⇒ 退出码 1，且不触 host', () => {
  const appDir = makeTree({ client: clientArtifact.replace('h(TavernBackgroundWait, {sessionId:props.sessionId, activity:view.activity}),', '') })
  const before = snapshots(appDir)
  assert.equal(run(appDir, ['--check']), 1)
  assertTree(appDir, before)
})

test('CLI：apply → 复跑幂等 → uninstall 逐字节还原', () => {
  const appDir = makeTree()
  const before = snapshots(appDir)
  assert.equal(run(appDir, ['--check']), 3)
  assert.equal(run(appDir), 0)
  for (const rel of SAVE_UI_TARGETS) {
    assert.equal(readFileSync(path.join(appDir, rel), 'utf8').includes(SAVE_UI_MARKER), true, 'UI 接缝已落 ' + rel)
  }
  assert.equal(existsSync(path.join(appDir, SAVE_UI_MANIFEST)), true)
  assert.equal(existsSync(path.join(appDir, '.tavern-seams.json')), true)
  assert.equal(readFileSync(path.join(appDir, INDEX_REL), 'utf8').includes('await initializeAuthorLegacyWorkspaces(ctx)'), true, 'host 缝已落')
  assert.equal(run(appDir, ['--check']), 0)
  const applied = snapshots(appDir)
  assert.equal(run(appDir), 0)
  for (const [rel, text] of applied) assert.equal(readFileSync(path.join(appDir, rel), 'utf8'), text, '复跑字节不变 ' + rel)
  assert.equal(run(appDir, ['--uninstall']), 0)
  assertTree(appDir, before)
  assert.equal(run(appDir, ['--uninstall']), 0)
  assertTree(appDir, before)
})

test('主入口：host 失败 ⇒ 只回退本次 UI 前像；既有 manifest/backup 不动', () => {
  // ① UI 尚未施：host 注入失败 ⇒ UI 两文件回到作者原样，且不留 UI manifest/备份
  const appDir = makeTree()
  const before = snapshots(appDir)
  assert.throws(() => applyAllSeams({ appDir, applyHost: () => { throw new Error('synthetic host failure') } }), /synthetic host failure/)
  assertTree(appDir, before)
  // ② 只有 UI 已施（host 仍待施）：host 注入失败 ⇒ UI 已施内容/manifest/备份全部保留（不做卸载语义的回退）
  const second = makeTree()
  applySaveUiSeam({ appDir: second })
  const uiAppliedTree = snapshots(second)
  assert.throws(() => applyAllSeams({ appDir: second, applyHost: () => { throw new Error('synthetic host failure') } }), /synthetic host failure/)
  for (const [rel, text] of uiAppliedTree) assert.equal(readFileSync(path.join(second, rel), 'utf8'), text, '既有代必须保留 ' + rel)
  assert.equal(existsSync(path.join(second, SAVE_UI_MANIFEST)), true)
  assert.equal(existsSync(path.join(second, SAVE_UI_TARGETS[0] + '.save-ui-seam.backup')), true)
  assert.equal(existsSync(path.join(second, '.tavern-seams.json')), false, 'host 未写成功：不得留下 main manifest')
})

test('主入口：host 已就绪、UI 待施、legacy 施缝失败 ⇒ 仍回退本次 UI 前像', () => {
  // 构造「host 已就绪 + UI dirty + legacy 待施」：先全施，再把 UI 与 legacy 各自卸回待施。
  const appDir = makeTree()
  assert.equal(run(appDir), 0)
  assert.equal(applySaveUiSeam({ appDir, uninstall: true }).removed, true)
  assert.equal(applyLegacyViewSeams({ appDir, uninstall: true }).removed, true)
  const before = snapshots(appDir)
  for (const rel of SAVE_UI_TARGETS) {
    assert.equal(readFileSync(path.join(appDir, rel), 'utf8').includes(SAVE_UI_MARKER), false, '前置：UI 应回到待施')
  }
  assert.equal(readFileSync(path.join(appDir, INDEX_REL), 'utf8').includes("ctx.provide('tavernChats'"), true, '前置：host 仍应就绪')
  // 注入 legacy 施缝失败（在 UI 已写之后）；host 无写入工作，走的就是那条 !hostNeedsWork 分支。
  let calls = 0
  assert.throws(() => applyAllSeams({
    appDir,
    applyLegacy: () => { calls += 1; throw new Error('synthetic legacy apply failure') }
  }), /synthetic legacy apply failure/)
  assert.equal(calls, 1, '注入的 legacy 施缝必须被调用一次')
  for (const [rel, text] of before) assert.equal(readFileSync(path.join(appDir, rel), 'utf8'), text, 'legacy 失败必须回退 UI 前像 ' + rel)
  assert.equal(existsSync(path.join(appDir, SAVE_UI_MANIFEST)), false, '回退后不得留下 UI manifest')
  assert.equal(existsSync(path.join(appDir, SAVE_UI_TARGETS[0] + '.save-ui-seam.backup')), false, '回退后不得留下 UI 备份')
  assert.equal(existsSync(path.join(appDir, '.tavern-seams.json')), true, '既有 main manifest 必须保留')
})

test('主入口：UI 施缝记录丢失 ⇒ uninstall 在 host 之前失败，host 一处未动', () => {
  const appDir = makeTree()
  assert.equal(run(appDir), 0)
  const applied = snapshots(appDir)
  rmSync(path.join(appDir, SAVE_UI_MANIFEST), { force: true })
  assert.equal(run(appDir, ['--uninstall']), 1)
  for (const [rel, text] of applied) {
    if (rel === SAVE_UI_MANIFEST) continue
    assert.equal(readFileSync(path.join(appDir, rel), 'utf8'), text, 'host 一处都不得被卸 ' + rel)
  }
  assert.equal(existsSync(path.join(appDir, '.tavern-seams.json')), true, 'main manifest 必须保留')
  assert.equal(existsSync(path.join(appDir, LEGACY_SHIM_REL)), true, 'legacy 必须保持已施')
  assert.equal(readFileSync(path.join(appDir, INDEX_REL), 'utf8').includes('await initializeAuthorLegacyWorkspaces(ctx)'), true)
})

test('主入口：main owned 备份缺失 ⇒ uninstall 预检即失败，UI/legacy/main 全部保持现状', () => {
  const appDir = makeTree()
  assert.equal(run(appDir), 0)
  const applied = snapshots(appDir)
  const libDir = path.join(appDir, 'tavern-plugin/lib')
  const backup = readdirSync(libDir).find(name => name.startsWith('index.js.pre-seams-'))
  assert.ok(backup, '应存在 main 首次备份')
  rmSync(path.join(libDir, backup), { force: true })
  assert.equal(run(appDir, ['--uninstall']), 1)
  for (const [rel, text] of applied) assert.equal(readFileSync(path.join(appDir, rel), 'utf8'), text, '预检失败必须全部保持现状 ' + rel)
  assert.equal(existsSync(path.join(appDir, '.tavern-seams.json')), true)
  assert.equal(existsSync(path.join(appDir, SAVE_UI_MANIFEST)), true, 'UI manifest 不得被提前删')
  assert.equal(existsSync(path.join(appDir, SAVE_UI_TARGETS[0] + '.save-ui-seam.backup')), true, 'UI 备份不得被提前删')
  assert.equal(existsSync(path.join(appDir, LEGACY_SHIM_REL)), true)
})

test('主入口：host 锚点未知 ⇒ 预检阶段抛错、UI 一个字节都没写', () => {
  const appDir = makeTree({ index: 'export const unsupported = true\n' })
  assert.throws(() => applyAllSeams({ appDir }), /原件只读接缝|锚点|缺少/)
  for (const rel of SAVE_UI_TARGETS) {
    assert.equal(readFileSync(path.join(appDir, rel), 'utf8'), clientArtifact, 'UI 不得被写 ' + rel)
    assert.equal(readFileSync(path.join(appDir, rel), 'utf8').includes(SAVE_UI_MARKER), false)
  }
  assert.equal(existsSync(path.join(appDir, SAVE_UI_MANIFEST)), false)
})
