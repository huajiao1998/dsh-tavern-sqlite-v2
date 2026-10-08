// 上游最新树三代兼容闸（2026-10-07）。
//
// 目的：标准接缝（deploy/standard-seams.mjs 及其有限 Host/body/clean/runtime 转换）
// 在**最新上游树**（5c69907：bounded/scoped 新模块）与两个已知代（9e9b26d 晚间 / 5d2ffac 2.5.0 初版）上，
// 逐代在只读夹具的**自有副本**（mkdtemp）里跑完整标准链：
//   protectAuthorStartup → applyStandardSeams(changed) → checkStandardSeams(ready) → 幂等
//   → uninstallStandardSeams → 逐字回原像（TARGETS 在场件字节一致 ＋ 施缝新建件全部移除）→ reapply。
// 只做**链兼容**（非行为验收、非插件全量）；任一步失败即停在首个真实锚点，错误里带阶段名与锚点原文。
// 夹具只读：所有写操作只发生在 mkdtemp 副本里；缺夹具直接炸，不许 skip。
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FIXTURE_SRC = new URL('../../../tmp/upstream25-author-fixture/src/', import.meta.url)
const RECORD = '.tavern-standard-seams.json'
const CORE_HOST_MARK = '[dsh-tavern-core-host:v1]'
// 卸载必须逐字还原的关键件（不允许"只 index 一致就声称全字节"）。
const KEY_FILES = [
  'tavern-plugin/lib/index.js',
  'tavern-plugin/lib/domain/round-history.js',
  'tavern-plugin/lib/domain/turn-orchestration.js',
  'tavern-plugin/lib/domain/tavern-script-host-adapter.js',
]
// 施缝必然新建的核心垫片（作者树里不存在）；卸载必须把它们全部移除。
const NEW_SHIMS = [
  'tavern-plugin/lib/domain/storage-package.js',
  'tavern-plugin/lib/domain/chat-sqlite-store.js',
  'tavern-plugin/lib/domain/storage-server-execution.js',
  'tavern-plugin/lib/domain/storage-budgets.js',
  'tavern-plugin/lib/domain/storage-rollback.js',
  'tavern-plugin/lib/domain/storage-rollback-business.js',
  'tavern-plugin/lib/domain/storage-opening-runtime.js',
  'tavern-plugin/lib/domain/storage-current-variables.js',
  'tavern-plugin/lib/domain/storage-fork-history.js',
  'tavern-plugin/lib/domain/storage-compaction-warning.js',
]
const BACKUP_RE = /(?:\.pre-seams-[\w-]+\.bak|\.legacy-view-seams\.backup|\.save-ui[^/]*\.backup)$/

const seams = await import(new URL('../deploy/standard-seams.mjs', import.meta.url).href)
const { protectAuthorStartup } = await import(new URL('../deploy/maintenance/author-safety.mjs', import.meta.url).href)

function walkFiles(root) {
  const out = [], stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'))
    }
  }
  return out
}

/** 阶段包装：失败时把阶段名与真实锚点错误一起抛出，便于定位"首个真实锚点"。 */
function stage(tag, name, run) {
  try { return run() } catch (error) {
    throw new Error(tag + ' 阶段「' + name + '」失败：' + (error && error.message ? error.message : error), { cause: error })
  }
}

function fixtureDir(sha) {
  const dir = new URL('dsh-tavern-' + sha + '/tavern-plugin/', FIXTURE_SRC)
  if (!existsSync(new URL('lib/index.js', dir))) {
    throw new Error('缺上游 ' + sha + ' 作者树夹具（tmp/upstream25-author-fixture/src/）；兼容基线无法对账，按 loud 失败处理')
  }
  return dir
}

// ① 最新树（5c69907）代际身份：2.5.0 ＋ bounded/scoped 新导出在场，旧压缩协调器已删。
function identifyLatest(dir) {
  assert.equal(existsSync(new URL('lib/domain/bounded-history.js', dir)), true, '最新树缺 bounded-history.js')
  const bounded = readFileSync(new URL('lib/domain/bounded-history.js', dir), 'utf8')
  assert.equal(bounded.includes('export function createBoundedHistory('), true, 'bounded 新导出缺失：createBoundedHistory')
  assert.equal(bounded.includes('export async function readRecentWindow('), true, 'bounded 新导出缺失：readRecentWindow')
  const scoped = readFileSync(new URL('lib/domain/scoped-messages.js', dir), 'utf8')
  assert.equal(scoped.includes('export function isScopedMessages('), true, 'scoped 新导出缺失：isScopedMessages')
  assert.equal(scoped.includes('export function createScopedMessages('), true, 'scoped 新导出缺失：createScopedMessages')
  const index = readFileSync(new URL('lib/index.js', dir), 'utf8')
  assert.equal(index.includes("from './domain/bounded-history.js'"), true, '最新树入口未接 bounded-history')
  assert.equal(index.includes("from './domain/scoped-messages.js'"), true, '最新树入口未接 scoped-messages')
  assert.equal(existsSync(new URL('lib/domain/tavern-compaction.js', dir)), false, '旧压缩协调器仍在，夹具代际错误')
}

// ② 晚间树（9e9b26d）：台账/前台变量/请求血缘在场，且尚无 bounded-history。
function identifyEvening(dir) {
  for (const rel of ['lib/domain/manual-ledger.js', 'lib/domain/foreground-variable-changes.js', 'lib/domain/request-lineage.js']) {
    assert.equal(existsSync(new URL(rel, dir)), true, '9e9b26d 独有模块缺失：' + rel)
  }
  assert.equal(existsSync(new URL('lib/domain/bounded-history.js', dir)), false, '夹具疑似错代：9e9b26d 不该有 bounded-history.js')
  assert.equal(existsSync(new URL('lib/domain/tavern-compaction.js', dir)), false, '旧压缩协调器仍在，夹具代际错误')
}

// ③ 2.5.0 初版树（5d2ffac）：旧压缩协调器仍在，台账模块尚未出现。
function identifyInitial(dir) {
  assert.equal(existsSync(new URL('lib/domain/tavern-compaction.js', dir)), true, '5d2ffac 代应有旧压缩协调器')
  assert.equal(existsSync(new URL('lib/domain/manual-ledger.js', dir)), false, '夹具疑似错代：5d2ffac 不该有 manual-ledger.js')
  assert.equal(existsSync(new URL('lib/domain/bounded-history.js', dir)), false, '夹具疑似错代：5d2ffac 不该有 bounded-history.js')
}

/** 完整标准链：一代一次复制，链内所有阶段复用同一副本。 */
function runStandardChain(tag, sha, identify) {
  const fixture = fixtureDir(sha)
  identify(fixture)
  const pkg = JSON.parse(readFileSync(new URL('package.json', fixture), 'utf8'))
  assert.equal(pkg.name, 'dsh-tavern-plugin', tag + ' 夹具包名不符')
  assert.equal(pkg.version, '2.5.0', tag + ' 夹具版本不是 2.5.0')

  const app = mkdtempSync(path.join(os.tmpdir(), 'upstream-latest-' + sha.slice(0, 7) + '-'))
  const stages = []
  try {
    cpSync(fixture, path.join(app, 'tavern-plugin'), { recursive: true })
    const indexAbs = path.join(app, KEY_FILES[0])
    const protectedOriginal = stage(tag, 'protectAuthorStartup', () => protectAuthorStartup(readFileSync(indexAbs, 'utf8')))
    writeFileSync(indexAbs, protectedOriginal, 'utf8')
    // 施缝前原像（protect 后、施缝前）：TARGETS 逐件取字节，卸载必须逐字回到这里。
    const pristine = new Map()
    for (const rel of seams.maintenanceTargets) {
      const abs = path.join(app, rel)
      pristine.set(rel, existsSync(abs) ? readFileSync(abs) : null)
    }
    const existed = [...pristine.values()].filter(Boolean).length
    // S5 受管目标不在 maintenanceTargets 名单内：其"施缝前原像"必须单独取，供精确字节断言。
    const coordinatorRel = 'tavern-plugin/lib/domain/background-task-coordinator.js'
    const coordinatorOriginal = existsSync(path.join(app, coordinatorRel)) ? readFileSync(path.join(app, coordinatorRel)) : null
    const absentBefore = [...pristine].filter(([, body]) => body === null).map(([rel]) => rel)
    assert.deepEqual(walkFiles(app).filter(rel => BACKUP_RE.test(rel)), [], tag + ' 夹具副本不应预带接缝备份件')
    assert.equal(pristine.get(KEY_FILES[0]).toString('utf8'), protectedOriginal, '入口基线必须等于 protect 后原像')
    for (const rel of NEW_SHIMS) assert.equal(absentBefore.includes(rel), true, tag + ' 作者树不应预带垫片：' + rel)
    stages.push('copy+protect=ok（TARGETS ' + pristine.size + '：在场 ' + existed + '／施缝新建 ' + absentBefore.length + '）')

    const applied = stage(tag, 'applyStandardSeams', () => seams.applyStandardSeams({ appDir: app }))
    assert.equal(applied.changed, true, tag + ' 必须真的施缝')
    const check = stage(tag, 'checkStandardSeams', () => seams.checkStandardSeams({ appDir: app }))
    assert.equal(check.ready, true, tag + ' 施缝后必须 ready：' + JSON.stringify(check))
    assert.deepEqual(check.pending, [], tag + ' 施缝后仍有待施项')
    const stillAbsent = NEW_SHIMS.filter(rel => !existsSync(path.join(app, rel)))
    assert.deepEqual(stillAbsent, [], tag + ' 施缝后这些新建垫片未落盘：' + stillAbsent.join(', '))
    assert.equal(seams.applyStandardSeams({ appDir: app }).changed, false, tag + ' 复跑必须幂等')
    assert.equal(readFileSync(indexAbs, 'utf8').includes(CORE_HOST_MARK), true, tag + ' 入口未接核心宿主')
    stages.push('apply changed=true／check ready=true／幂等 changed=false／垫片在场 ' + NEW_SHIMS.length)

    const recordAbs = path.join(app, RECORD)
    assert.equal(existsSync(recordAbs), true, tag + ' 标准记录缺失')
    const record = JSON.parse(readFileSync(recordAbs, 'utf8'))
    const afterKeys = Object.keys(record.after)
    // S5 新增受管目标（background-task-coordinator）是真作者文件、但不在导出的 maintenanceTargets 里：
    // 必须按"记录 before 是否存在且为 null（＝插件新建）"判新建件，而不是用 targets 名单代理。
    const COORDINATOR_REL = 'tavern-plugin/lib/domain/background-task-coordinator.js'
    const coordinatorAbs = path.join(app, COORDINATOR_REL)
    assert.equal(coordinatorOriginal !== null, true, tag + ' 夹具应预存真作者文件：' + COORDINATOR_REL)
    assert.equal(Object.hasOwn(record.before, COORDINATOR_REL), true, tag + ' 记录必须为该作者文件留前像键：' + COORDINATOR_REL)
    assert.equal(typeof record.before[COORDINATOR_REL], 'string', tag + ' 作者文件前像必须是字节（不是 null＝新建）：' + COORDINATOR_REL)

    const result = stage(tag, 'uninstallStandardSeams', () => seams.uninstallStandardSeams({ appDir: app }))
    assert.equal(result.changed, true, tag + ' 卸载必须真的撤缝')
    // 逐字回原像：在场件字节一致 ＋ 施缝新建件（记录 before 缺键或显式 null）全部移除（含记录里事后发现的备份件）。
    const drift = [], restored = [], removed = []
    for (const [rel, image] of pristine) {
      const abs = path.join(app, rel), present = existsSync(abs)
      if (image === null) { if (present) drift.push('应移除仍在：' + rel); else removed.push(rel); continue }
      if (!present) { drift.push('原件丢失：' + rel); continue }
      if (readFileSync(abs).equals(image)) restored.push(rel)
      else drift.push('字节漂移：' + rel)
    }
    for (const rel of afterKeys) {
      const hasBefore = Object.hasOwn(record.before, rel)
      const createdByPlugin = !hasBefore || record.before[rel] === null
      if (createdByPlugin && existsSync(path.join(app, rel))) drift.push('记录内新建件未移除：' + rel)
    }
    // 作者文件的精确字节等同（不只是"存在"）：不得因不在 targets 名单就被当新建件或漏还原
    assert.equal(existsSync(coordinatorAbs), true, tag + ' 作者文件在卸载后应仍在（其前像是作者字节）：' + COORDINATOR_REL)
    assert.equal(readFileSync(coordinatorAbs).equals(coordinatorOriginal), true, tag + ' 作者文件卸载后必须逐字节等于原件：' + COORDINATOR_REL)
    assert.deepEqual(drift, [], tag + ' 卸载未逐字回原像：' + drift.join('；'))
    assert.equal(readFileSync(indexAbs, 'utf8'), protectedOriginal, tag + ' 入口未逐字节回 protect 后原像')
    assert.equal(readFileSync(indexAbs, 'utf8').includes(CORE_HOST_MARK), false, tag + ' 卸载后入口仍含核心接缝')
    for (const rel of KEY_FILES) assert.equal(restored.includes(rel), true, tag + ' 关键件未纳入逐字恢复核对：' + rel)
    assert.equal(existsSync(recordAbs), false, tag + ' 标准记录必须已删')
    stages.push('uninstall 逐字恢复 ' + restored.length + ' 件／移除 ' + removed.length + ' 件／漂移 0')

    assert.equal(seams.applyStandardSeams({ appDir: app }).changed, true, tag + ' 重接入必须 changed=true')
    assert.equal(seams.checkStandardSeams({ appDir: app }).ready, true, tag + ' 重接入后必须 ready')
    stages.push('reapply changed=true／ready=true')
    return { tag, stages, restored: restored.length, removed: removed.length, targets: pristine.size }
  } finally {
    rmSync(app, { recursive: true, force: true })
  }
}

const GENERATIONS = [
  ['① 5c69907 最新树（v2.5.0＋bounded/scoped 新导出）', '5c69907994df9f432b8898168ce5dff371929c2a', identifyLatest],
  ['② 9e9b26d 2.5 晚间树', '9e9b26d52d820e4f70a23c2cf3a3b39bcaf28544', identifyEvening],
  ['③ 5d2ffac 2.5.0 初版树', '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60', identifyInitial],
]

for (const [tag, sha, identify] of GENERATIONS) {
  test(tag + '：完整标准接缝链＋逐字卸载回原像', () => {
    const summary = runStandardChain(tag, sha, identify)
    console.log(tag + ' 汇总：' + summary.stages.join(' → ') + '（TARGETS ' + summary.targets + '）')
  })
}
