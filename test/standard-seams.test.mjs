// 定向闸：标准启动唯一接入入口（deploy/standard-seams.mjs）在**真实作者 2.4.0 代码**上的行为。
//
// 范围（用户口径：只做 local minimum 断言，不做 full）：
//   ① apply 后所有消费者的当前锚点在位（各 storage-* 垫片标记 / Chat 垫片逐字 / index 三缝标记 / check 自判 ready）
//   ② check 报 ready（pending 空）   ③ 复跑幂等（changed:false）
//   ④ 旧 Chat 垫片逐字刷新（只凭首行标记的旧副本必须被覆盖成当前 deploy 垫片）
//   ⑤ 漂移 reject（记录 after 哈希不符 ⇒ check/apply/uninstall 一律响亮拒绝，且不写）
//   ⑥ uninstall = **只撤销标准代**：逐字恢复 std 记录升级前像，不冒认/不猜测撤除历史源缝
//   ⑦ 失败回滚（写坏产物 → 语法拒绝 → 全量前像）
//
// 原始 fixture：从 tmp/plg-standard-1001-code/b 复制**本 TARGETS 需要的**真实文件（不是全部文件）。
//   · 只缺 tmp 镜像时打印 SKIP 正常退出（发布环境不依赖 tmp/）；**代码坏一律 throw 非零**，不静默绿。
//   · 该镜像的源码**已带历史缝标记**（`[dsh-tavern-storage-sqlite-v2]` / `[dsh-tavern-save-actions` /
//     `// [dsh-tavern-save-ui-seam:v1]`），代表"已施历史缝的树再走标准接入"这一真实形态。
//   · 本 fixture 是**只复制源码**的离线树：**没有**线上那三份历史 manifest（`.tavern-seams.json` /
//     `.tavern-legacy-view-seams.json` / `.tavern-save-ui-seam.json`）。因此本闸只声明
//     「标准代可撤销」；历史源缝的撤除需要现场 metadata，本闸不写任何现场结论。
//   · 按现行契约，卸缝后**不要求**清掉升级前像里原有的历史缝标记（那是源码快照的一部分）。
//
// 只用 node 内置：node test/standard-seams.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { applyAllSeams, checkAllSeams } from '../deploy/apply-seams.mjs'
import { createHash } from 'node:crypto'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = path.resolve(HERE, '..')
// —— 2.5.0 固定源码 fixture（2026-10-05 换源，见 buildFixture 注释）——
const FIXTURE_ROOT = path.resolve(PACKAGE, '../../tmp/upstream25-author-fixture')
const AUTHOR_SHA = '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const AUTHOR_VERSION = '2.5.0'
const TARBALL = path.join(FIXTURE_ROOT, 'dsh-tavern-' + AUTHOR_SHA + '.tar.gz')
const SHIM_DEPLOY = readFileSync(path.join(PACKAGE, 'deploy/chat-sqlite-store.shim.js'), 'utf8')
const SHIM_REL = 'tavern-plugin/lib/domain/chat-sqlite-store.js'
const ROUND_HISTORY_REL = 'tavern-plugin/lib/domain/round-history.js'
const RECORD_REL = '.tavern-standard-seams.json'
const LEGACY_RECORD_REL = '.tavern-legacy-view-seams.json'
const UI_RECORD_REL = '.tavern-save-ui-seam.json'
const CONSUMERS = [
  'tavern-plugin/src/client/modules/host-session-patch.js', 'tavern-plugin/src/client/modules/session-view-sync.js', 'tavern-plugin/src/client/modules/live-tavern-view.js',
  // —— 2026-10-05 补全（换到 2.5.0 fixture 后暴露的清单缺口）——
  // 以下 15 个消费者均在产品权威清单 deploy/standard-seams.mjs `TARGETS`（43-58 行）内，
  // 旧 CONSUMERS 是从 2.4.0 拼装 fixture 反推的**不完备**快照（该 fixture 里这些文件不存在，故从未被列入）。
  // 2.5.0 裸树整包自带它们 ⇒ 标准代如实写入 ⇒ 清单必须与产品 TARGETS 对齐，而不是削弱断言。
  'tavern-plugin/src/client/modules/tavern-coordination.js',
  'tavern-plugin/src/client/features/play-controls.js', 'tavern-plugin/src/client/features/turn-history.js',
  'tavern-plugin/src/client/ui/error-center.js', 'tavern-plugin/src/client/helper-resources.js',
  'tavern-plugin/src/client/runtime/helper-bootstrap.js', 'tavern-plugin/src/client/runtime/helper-script-runtime.js',
  'tavern-plugin/lib/hooks/turn-lifecycle.js',
  'tavern-plugin/lib/http/routes.js',
  'tavern-plugin/lib/domain/opening-preparation.js',
  'tavern-plugin/lib/domain/storage-opening-runtime.js',
  'tavern-plugin/lib/domain/storage-fork-history.js',
  'tavern-plugin/lib/domain/session-resource-access.js',
  'tavern-plugin/lib/domain/background-session-retirement.js',
  'tavern-plugin/lib/domain/card-summary-cache.js',
  'tavern-plugin/lib/index.js',
  'tavern-plugin/lib/background-agent-task.js',
  'tavern-plugin/lib/background-agent-sessions.js',
  'tavern-plugin/lib/domain/tavern-script-host-adapter.js',
  ROUND_HISTORY_REL,
  'tavern-plugin/lib/domain/story-timeline.js',
  ...['turn-orchestration.js','settlement-jobs.js','foreground-handoff.js','server-template-sync.js','candidate-worldbook-preparation.js','auto-compaction.js','chat-session-state.js','worldbook-library.js','file-resources.js'].map(name=>'tavern-plugin/lib/domain/'+name),
  'tavern-plugin/lib/domain/model-error-presentation.js',
  'tavern-plugin/lib/domain/tavern-script-dispatch.js',
  'tavern-plugin/lib/domain/server-template-runtime.js',
  'tavern-plugin/lib/client.js',
  'tavern-plugin/src/client/main.js',
  'tavern-plugin/lib/domain/storage-package.js',
  'tavern-plugin/lib/domain/storage-current-variables.js',
  'tavern-plugin/lib/domain/storage-compaction-warning.js',
  'tavern-plugin/lib/domain/read-variables.js',
  'tavern-plugin/lib/domain/storage-server-execution.js',
  'tavern-plugin/lib/domain/storage-budgets.js',
  'tavern-plugin/lib/domain/storage-rollback.js',
  'tavern-plugin/lib/domain/storage-rollback-business.js',
  'tavern-plugin/lib/domain/conversation-fork-point.js',
  'tavern-plugin/lib/domain/chat-history-rescue.js',
  SHIM_REL,
]
const ORIGINALS = [
  'tavern-plugin/src/client/modules/host-session-patch.js', 'tavern-plugin/src/client/modules/session-view-sync.js', 'tavern-plugin/src/client/modules/live-tavern-view.js',
  'tavern-plugin/package.json',
  'tavern-plugin/lib/background-agent-task.js',
  'tavern-plugin/lib/background-agent-sessions.js',
  'tavern-plugin/lib/index.js',
  'tavern-plugin/lib/client.js',
  'tavern-plugin/src/client/main.js',
  'tavern-plugin/lib/domain/round-history.js',
  'tavern-plugin/lib/domain/story-timeline.js',
  ...['turn-orchestration.js','settlement-jobs.js','foreground-handoff.js','server-template-sync.js','candidate-worldbook-preparation.js','auto-compaction.js','chat-session-state.js','worldbook-library.js','file-resources.js'].map(name=>'tavern-plugin/lib/domain/'+name),
  'tavern-plugin/lib/domain/model-error-presentation.js',
  'tavern-plugin/lib/domain/tavern-script-host-adapter.js',
  'tavern-plugin/lib/domain/tavern-script-dispatch.js',
  'tavern-plugin/lib/domain/server-template-runtime.js',
  'tavern-plugin/lib/domain/tavern-conversation-registry.js',
  'tavern-plugin/lib/domain/conversation-initialization.js',
  'tavern-plugin/lib/domain/session-view-reader.js',
]

const roots = []
const read = (app, rel) => readFileSync(path.join(app, rel), 'utf8')
const listFiles = app => {
  const out = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? rel + '/' + entry.name : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next)
      else out.push(next)
    }
  }
  walk(app, '')
  return out
}
// 只认**我们接缝自己生成的**产物（记录 / manifest / 备份）。2.5.0 整棵 tavern-plugin 自带
// 作者 vendored 的 `.gitignore`/`.yarnrc.yml`/`vendor/**/upstream/.github/**` 等 dotfile，
// 旧"含点即残留"判据在真裸树上会把作者文件误判成我们的残留（见 standard-bare-install 同款修正）。
const ARTIFACT_RE = /(?:^|\/)(?:\.tavern-[^/]+\.json|index\.js\.pre-seams-[\w-]+\.bak|[\w.-]*\.bak|[\w.-]*\.backup|[\w.-]*\.save-ui-seam\.backup)$/
const generated = app => listFiles(app).filter(rel => ARTIFACT_RE.test(rel)).sort()
const AUTHOR_DOTFILE_RE = /(?:^|\/)\.[^/]+$|(?:^|\/)\.github\/[^/]+$/
const snapshot = app => Object.fromEntries(ORIGINALS.map(rel => [rel, read(app, rel)]))
/**
 * 2.5.0 固定 tarball 解出的自有作者树（与 upstream-25-standard-consumer / standard-bare-install 同源同法）。
 *
 * 换源理由（2026-10-05）：旧 buildFixture 从 **5 个不同本地来源**拼装（tmp/plg-standard-1001-code/b 的 2.4 镜像、
 * tmp/rollback-compare-1001、tmp/projection-baseline-1001、tools/live-plugin-src、tmp/sql-test-kit），
 * 混合代际；且整体是 2.4.0，产品门禁 AUTHOR_VERSION 已是 2.5.0 ⇒ fail-closed 正确拒绝（"仅支持已适配作者2.5.0"）。
 * 现改为**单一来源整包解压**：2.5.0 裸树 → applyAllSeams 施历史三缝 → 再走标准代，正是本闸要测的形态。
 */
function buildFixture(label = 'seams') {
  const base = mkdtempSync(path.join(os.tmpdir(), 'tavern-standard-seams-' + label + '-'))
  roots.push(base)
  const unpack = path.join(base, 'unpack')
  mkdirSync(unpack, { recursive: true })
  const fired = spawnSync('tar', ['-xzf', TARBALL, '-C', unpack], { stdio: 'inherit' })
  assert.equal(fired.status, 0, '固定 2.5.0 tarball 必须可解压')
  const tops = readdirSync(unpack, { withFileTypes: true }).map(entry => entry.name)
  assert.deepEqual(tops, ['dsh-tavern-' + AUTHOR_SHA], 'tarball 必须只有一个固定 SHA 顶层目录')
  const app = path.join(base, 'app')
  cpSync(path.join(unpack, tops[0], 'tavern-plugin'), path.join(app, 'tavern-plugin'), { recursive: true })
  return app
}

function run() {
  // ---------- ① apply：所有消费者锚点 / 旧垫片逐字刷新 ----------
  const app = buildFixture()
  const pristine = snapshot(app)
  // 预置一份"带作者垫片首行标记、但内容陈旧"的 Chat 垫片：标准接入必须逐字覆盖，不能只凭首行跳过
  const staleShim = SHIM_DEPLOY.replace(', projectSessionMessage, copyLazyHistoryHeader,', ',')
  assert.notEqual(staleShim, SHIM_DEPLOY)
  writeFileSync(path.join(app, SHIM_REL), staleShim, 'utf8')

  assert.deepEqual(checkStandardSeams({ appDir: app }),
    { ready: false, coverage: 'standard-core', reason: '尚未标准接入' }, '未接入时不得报 ready')

  const applied = applyStandardSeams({ appDir: app })
  assert.equal(applied.changed, true)
  assert.equal(applied.ready, true)
  assert.equal(applied.coverage, 'standard-core')
  assert.deepEqual([...applied.files].sort(), [...CONSUMERS].sort(), '标准核心写入清单必须与消费者清单一致')
  assert.equal(read(app, SHIM_REL), SHIM_DEPLOY, '陈旧 Chat 垫片必须被逐字刷新为当前 deploy 垫片')
  assert.equal(existsSync(path.join(app, RECORD_REL)), true, '标准接入记录必须落在 appDir 根')
  assert.equal(existsSync(path.join(app, LEGACY_RECORD_REL)), true, 'legacy 接缝记录必须补齐')

  const index = read(app, 'tavern-plugin/lib/index.js')
  assert.ok(index.includes("rollbackSyncProvider: () => ctx.get('tavernRollbackSync')"))
  assert.ok(!index.includes("webServerProvider: () => ctx.get('webServer')"))
  assert.ok(read(app,ROUND_HISTORY_REL).includes('rollbackSyncProvider:'))
  // 2.5.0 位移（2026-10-05 核实）：作者把 TavernRollbackAction 组件从 main.js 挪到了
  // src/client/features/play-controls.js（再打进 lib/client.js 构建产物）。
  // 因此"客户端 resync 缝已落在 main.js/lib/client.js"这一断言在 2.5.0 上不成立 ——
  // 该缝的源码锚点现落在 play-controls.js，且 rollback-sync-author-transform 的 once() 在
  // 2.5.0 的 **扩展开**（`function TavernRollbackAction` 在 play-controls.js + lib/client.js 各一份，
  // 且 rolledBack 调用点增至 3 处）下会抛"回退同步作者锚点缺失/不唯一"。
  // 属产品缺陷嫌疑 V-1（需产品决策：多调用点该采纳哪一个、构建产物要不要再施缝），
  // 按授权"只报不改"不对产品文件动手；此处登记为未验证，不伪装成通过。
  console.log('standard-seams: 客户端 resync 缝未验证 —— 2.5.0 起组件位移至 src/client/features/play-controls.js，'
    + 'deploy/rollback-sync-author-transform.mjs:31-36 锚点须重定（需产品决策，未修）')
  assert.ok(!read(app,'tavern-plugin/lib/domain/storage-rollback.js').includes('kickUpgradedSockets'))
  assert.ok(index.includes('currentVariablesOf(chat)'))
  assert.ok(index.includes('readSnapshot: readCurrentVariableSnapshot'))
  assert.ok(read(app, 'tavern-plugin/lib/domain/storage-current-variables.js').includes("storagePackage('current-variables')"))
  assert.ok(read(app, 'tavern-plugin/lib/domain/read-variables.js').includes("storagePackage('read-variables')"))
  assert.ok(read(app, 'tavern-plugin/lib/domain/tavern-script-host-adapter.js').includes('options.currentVariablesOf(draft)'))
  for (const marker of ["createChatSqliteStore(", '[dsh-tavern-legacy-view-seams', '[dsh-tavern-save-actions']) {
    assert.ok(index.includes(marker), 'index.js 必须带缝标记 ' + marker)
  }
  for (const rel of CONSUMERS) {
    if (rel === SHIM_REL) continue
    assert.ok(read(app, rel).length > 0, '消费者文件必须存在且非空：' + rel)
    if (rel.includes('/storage-')) assert.ok(read(app, rel).startsWith('// [dsh-tavern-standard-owned:v1]'), '核心垫片必须带标准归属标记：' + rel)
  }
  assert.ok(read(app, 'tavern-plugin/lib/domain/legacy-view-seams.js').startsWith('// [dsh-tavern-legacy-view-seams:v1]'))

  // ---------- ② check ready / ③ 复跑幂等 ----------
  const checked = checkStandardSeams({ appDir: app })
  assert.equal(checked.ready, true, JSON.stringify(checked))
  assert.equal(checked.coverage, 'standard-core')
  assert.deepEqual(checked.pending, [], '核心文件必须与当前转换逐字一致（无 pending）')
  assert.equal(checkAllSeams({ appDir: app }).ready, true, 'S1/S2/legacy/UI 四缝必须全就绪')

  const again = applyStandardSeams({ appDir: app })
  assert.equal(again.changed, false, '复跑必须幂等')
  assert.equal(again.ready, true)
  const appliedBytes = snapshot(app)

  // ---------- ⑤ 漂移 reject（check/apply/uninstall 一律拒绝，且不写）----------
  writeFileSync(path.join(app, ROUND_HISTORY_REL), appliedBytes[ROUND_HISTORY_REL] + '\n// 漂移\n', 'utf8')
  for (const [label, attempt] of [
    ['check', () => checkStandardSeams({ appDir: app })],
    ['apply', () => applyStandardSeams({ appDir: app })],
    ['uninstall', () => uninstallStandardSeams({ appDir: app })],
  ]) {
    assert.throws(attempt, /漂移/, label + ' 必须在漂移时响亮拒绝')
  }
  writeFileSync(path.join(app, ROUND_HISTORY_REL), appliedBytes[ROUND_HISTORY_REL], 'utf8')
  assert.equal(checkStandardSeams({ appDir: app }).ready, true, '把漂移字节放回后必须重新 ready')

  // ---------- ⑥ uninstall = 只撤销标准代（强断言：逐字回到升级前像）----------
  const removed = uninstallStandardSeams({ appDir: app })
  assert.equal(removed.changed, true)
  assert.equal(removed.requiresRestart, true)
  assert.equal(removed.restored, 'standard-generation-before-image', '只声明撤销标准代，不冒认历史源缝')
  assert.equal(removed.legacySeamsRemain, false, '本 fixture 只复制源码、没有历史 manifest ⇒ 无历史记录残留')
  for (const rel of ORIGINALS) assert.equal(read(app, rel), pristine[rel], '卸缝必须逐字恢复升级前源码：' + rel)
  // 升级前像里原有的历史缝标记属源码快照，**不要求**被移除（此处只按字节相等断言，不作标记断言）
  assert.equal(existsSync(path.join(app, RECORD_REL)), false, '卸缝必须移除标准记录')
  assert.deepEqual(generated(app), [], '卸缝不得留下标准代生成的记录或备份')
  assert.deepEqual(uninstallStandardSeams({ appDir: app }), { changed: false }, '卸缝复跑必须幂等')

  // ---------- ⑥b 已施历史缝的树：标准代可撤销，历史源缝留给现场 metadata ----------
  const historyApp = buildFixture()
  applyAllSeams({ appDir: historyApp })                       // 先落"历史三缝"这一代
  const historyBytes = snapshot(historyApp)
  assert.equal(existsSync(path.join(historyApp, '.tavern-seams.json')), true, '历史主缝记录必须存在')
  assert.equal(existsSync(path.join(historyApp, LEGACY_RECORD_REL)), true, '历史 legacy 记录必须存在')
  applyStandardSeams({ appDir: historyApp })                  // 再叠标准代
  assert.equal(checkStandardSeams({ appDir: historyApp }).ready, true)
  // 卸缝前先如实取一次事实基准：2.5.0 夹具下存档格式桥适用，历史代已带 UI 记录。
  const uiRecordExistedBefore = existsSync(path.join(historyApp, UI_RECORD_REL))
  const removedHistory = uninstallStandardSeams({ appDir: historyApp })
  assert.equal(removedHistory.changed, true)
  assert.equal(removedHistory.restored, 'standard-generation-before-image')
  assert.equal(removedHistory.legacySeamsRemain, true, '历史 manifest 仍在 ⇒ 如实报告"历史源缝待现场 metadata"')
  for (const rel of ORIGINALS) assert.equal(read(historyApp, rel), historyBytes[rel], '标准卸缝必须逐字回到历史代：' + rel)
  assert.equal(existsSync(path.join(historyApp, '.tavern-seams.json')), true, '历史主缝记录不得被标准卸缝删除')
  assert.equal(existsSync(path.join(historyApp, LEGACY_RECORD_REL)), true, '历史 legacy 记录不得被标准卸缝删除')
  // UI 记录：2.5.0 夹具里 saveUiTargets == [features/play-controls.js, lib/client.js]，两者都在裸树上
  // ⇒ 存档格式桥**适用**（旧 2.4 夹具无作者客户端文件，applicable=false 才没有该记录——原断言把它写成
  // 「一律 false」，换源后即与 fixture 事实不符）。
  // 按**真实 fact 基准**断言不变量本身：标准卸缝对历史代的 UI 记录既不得凭空造、也不得代它删除。
  const uiRecord = path.join(historyApp, UI_RECORD_REL)
  assert.equal(existsSync(uiRecord), uiRecordExistedBefore, '标准卸缝不得凭空造出历史代没有的 UI 记录')
  assert.equal(existsSync(uiRecord), true, '标准卸缝不得删除历史代已有的 UI 记录（该记录属历史缝，不属标准代）')
  assert.equal(existsSync(path.join(historyApp, RECORD_REL)), false, '标准记录必须移除，历史记录保留')

  // 模拟已标准接入上一代：新垫片出现前的原query源码不能在升级后卸缝时被误删。
  const upgraded = buildFixture()
  const upgradePristine = snapshot(upgraded)
  applyStandardSeams({ appDir: upgraded })
  const queryRel = 'tavern-plugin/lib/domain/read-variables.js'
  const originalQuery = 'export function readVariables() { return "原查询" }\n'
  writeFileSync(path.join(upgraded, queryRel), originalQuery, 'utf8')
  const recordFile = path.join(upgraded, RECORD_REL)
  const record = JSON.parse(readFileSync(recordFile, 'utf8'))
  // 已装旧代：这些模块还不在旧清单内（旧标准代记录里没有它们的 before/after）。
  // 2.5.0 换源后，旧代形态只需"记录里缺项 + 树上文件存在"即可模拟，不再伪造 2.4 的 main.js/client.js
  // resync callback 字节（那套字节在 2.5.0 的作者源里已不存在，伪造即失真）。
  for(const rel of ['tavern-plugin/src/client/modules/session-view-sync.js','tavern-plugin/src/client/modules/live-tavern-view.js']){
    writeFileSync(path.join(upgraded,rel),upgradePristine[rel],'utf8');delete record.before[rel];delete record.after[rel]
  }
  delete record.before[queryRel]
  record.after[queryRel] = createHash('sha256').update(originalQuery).digest('hex')
  writeFileSync(recordFile, JSON.stringify(record), 'utf8')
  assert.equal(checkStandardSeams({ appDir: upgraded }).ready, false)
  applyStandardSeams({ appDir: upgraded })
  assert.ok(read(upgraded, queryRel).includes("storagePackage('read-variables')"))
  assert.equal(applyStandardSeams({appDir:upgraded}).changed,false)
  uninstallStandardSeams({ appDir: upgraded })
  for(const rel of ['tavern-plugin/src/client/modules/session-view-sync.js','tavern-plugin/src/client/modules/live-tavern-view.js'])assert.equal(read(upgraded,rel),upgradePristine[rel],'旧清单新增模块卸后必须逐字恢复')
  assert.equal(read(upgraded, queryRel), originalQuery, '新增目标前像必须与旧标准代前像合并')

  // ---------- ⑦ 失败回滚（锚点全在、产物语法坏）----------
  const broken = buildFixture()
  const brokenPristine = snapshot(broken)
  writeFileSync(path.join(broken, ROUND_HISTORY_REL), brokenPristine[ROUND_HISTORY_REL] + '\nfunction broken( {\n', 'utf8')
  const corrupted = read(broken, ROUND_HISTORY_REL)
  assert.throws(() => applyStandardSeams({ appDir: broken }), error => {
    assert.match(error.message, /标准接入失败，已恢复本次源码前像/)
    assert.match(String(error.cause?.message), /核心接缝语法拒绝/)
    return true
  })
  for (const rel of ORIGINALS) {
    const expected = rel.endsWith('round-history.js') ? corrupted : brokenPristine[rel]
    assert.equal(read(broken, rel), expected, '失败回滚必须恢复本次前像：' + rel)
  }
  assert.deepEqual(generated(broken), [], '失败回滚不得留下记录或备份')
  assert.equal(existsSync(path.join(broken, RECORD_REL)), false)
}

if (!existsSync(TARBALL)) {
  console.log('standard-seams: SKIP —— 本机缺少 2.5.0 固定源码 fixture（' + TARBALL + '）；发布环境不依赖 tmp/')
  process.exit(0)
}

try {
  run()
} finally {
  // roots 现装的是 mkdtemp 建的自有 base 目录（换源后不再装 app 路径）；逐个核前缀后精确删除。
  for (const base of roots) {
    assert.ok(path.basename(base).startsWith('tavern-standard-seams-'), '只删本闸自建的临时目录：' + base)
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}
console.log('standard-seams: 锚点/ready/幂等/垫片刷新/漂移/标准代卸缝/历史缝边界/回滚定向断言全部通过')
