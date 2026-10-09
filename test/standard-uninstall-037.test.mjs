// 0.3.7 收口：三个顶层 legacy 文件里**具体失败点**的具名独立覆盖（每测试各自 fixture，互不依赖；
// 不整跑 standard-bare-install / standard-seams / upstream-25-standard-consumer 的已通过阶段）。
//
// 覆盖（对应原全量 gate-2026-10-09T02-06-24-721Z.log 的三处文件级失败）：
//   ① 裸树标准卸载：精确回 before、标准记录删除、卸载幂等（原 standard-bare-install 失败点）
//   ② 真施缝后 round-history append 漂移：check/apply/uninstall 三全拒且现场零改（原 standard-seams 失败点，
//      row 标记根因已由主修在 author-rebase-plan 的 SEAM_MARKERS，期望保持原样不改）
//   ③ 真 rehearseSource('uninstall')：expected[STANDARD_RECORD]===null 且作者 before 全字节零改
//      （原 upstream-25-standard-consumer 失败点位于卸载预演）
//
// 只读有限 fixture（2.5.0 固定 tarball，与三个旧文件同源同身份门）；缺 fixture 一律响亮失败，不 SKIP 冒绿。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { checkAllSeams } from '../deploy/apply-seams.mjs'
import { maintenanceAdapter as ADAPTER } from '../deploy/maintenance.mjs'
import { sourceAccess, rehearseSource } from '../deploy/maintenance/source.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = path.resolve(HERE, '..')
const AUTHOR_SHA = '5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const AUTHOR_VERSION = '2.5.0'
const TARBALL = path.resolve(PACKAGE, '../../tmp/upstream25-author-fixture', 'dsh-tavern-' + AUTHOR_SHA + '.tar.gz')
const INDEX_REL = 'tavern-plugin/lib/index.js'
const SHIM_REL = 'tavern-plugin/lib/domain/chat-sqlite-store.js'
const ROUND_HISTORY_REL = 'tavern-plugin/lib/domain/round-history.js'
const RECORD_REL = '.tavern-standard-seams.json'
const MANIFEST_REL = '.tavern-seams.json'
const LEGACY_RECORD_REL = '.tavern-seams.json'
const RECORD_RELS = [RECORD_REL, '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json']
const TARGETS = [...ADAPTER.targets]
const roots = []
const read = (app, rel) => readFileSync(path.join(app, rel), 'utf8')

/** 有限 fixture：固定 tarball 解出整棵 tavern-plugin 到自有 tmp（与旧三文件同源）。 */
function buildTree(label) {
  assert.equal(existsSync(TARBALL), true, '缺固定 2.5.0 tarball：' + TARBALL)
  const base = mkdtempSync(path.join(os.tmpdir(), 'tavern-037-uninstall-' + label + '-'))
  roots.push(base)
  const unpack = path.join(base, 'unpack')
  mkdirSync(unpack, { recursive: true })
  assert.equal(spawnSync('tar', ['-xzf', TARBALL, '-C', unpack], { stdio: 'inherit' }).status, 0, 'tarball 必须可解压')
  const tops = readdirSync(unpack, { withFileTypes: true }).map(entry => entry.name)
  assert.deepEqual(tops, ['dsh-tavern-' + AUTHOR_SHA], 'tarball 必须只有一个固定 SHA 顶层目录')
  const app = path.join(base, 'app')
  cpSync(path.join(unpack, tops[0], 'tavern-plugin'), path.join(app, 'tavern-plugin'), { recursive: true })
  assert.equal(JSON.parse(read(app, 'tavern-plugin/package.json')).version, AUTHOR_VERSION, '夹具必须是已适配作者 2.5.0')
  return app
}
test.after(() => { for (const root of roots) { assert.ok(path.basename(root).startsWith('tavern-037-uninstall-'), '只清本文件自建临时目录：' + root); rmSync(root, { recursive: true, force: true }) } })

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
/** 全树字节快照（含作者 dotfile；用于"零改"判定）。 */
const imageOf = app => Object.fromEntries(listFiles(app).sort().map(rel => [rel, readFileSync(path.join(app, rel)).toString('base64')]))
/** 接缝自有产物（记录 / manifest / 备份）——与旧闸同判据。 */
const ARTIFACT_RE = /(?:^|\/)(?:\.tavern-[^/]+\.json|index\.js\.pre-seams-[\w-]+\.bak|[\w.-]*\.bak|[\w.-]*\.backup|[\w.-]*\.save-ui-seam\.backup)$/
const generated = app => listFiles(app).filter(rel => ARTIFACT_RE.test(rel)).sort()
const managedArtifacts = app => listFiles(app).filter(rel => /(?:^|\/)(?:\.tavern-[^/]+\.json|[\w.-]*\.bak|[\w.-]*\.backup)$/.test(rel)).sort()

test('037-① 裸树标准卸载精确回before且记录删除并幂等', async () => {
  const app = buildTree('bare')
  const bareIndex = read(app, INDEX_REL)
  assert.equal(existsSync(path.join(app, RECORD_REL)), false, '前置：裸树不得预带标准记录')
  assert.equal(existsSync(path.join(app, SHIM_REL)), false, '前置：裸树不得预带 Chat 垫片')
  assert.deepEqual(checkStandardSeams({ appDir: app }), { ready: false, coverage: 'standard-core', reason: '尚未标准接入' })

  const applied = applyStandardSeams({ appDir: app })
  assert.equal(applied.changed, true)
  assert.equal(applied.ready, true)
  assert.equal(checkAllSeams({ appDir: app }).ready, true, '首装后 S1/S2/legacy/UI 必须全就绪')
  const record = JSON.parse(read(app, RECORD_REL))
  assert.equal(record.before[INDEX_REL], Buffer.from(bareIndex, 'utf8').toString('base64'), '前像必须逐字等于裸 index')
  assert.equal(record.before[SHIM_REL], null, '前像里垫片必须是"不存在"（null）')
  assert.equal(applyStandardSeams({ appDir: app }).changed, false, '首装后复跑必须幂等')

  const removed = uninstallStandardSeams({ appDir: app })
  assert.equal(removed.changed, true)
  assert.equal(removed.requiresRestart, true)
  assert.equal(removed.restored, 'standard-generation-before-image')
  assert.equal(read(app, INDEX_REL), bareIndex, '卸载必须逐字回到首装前裸源码')
  assert.equal(existsSync(path.join(app, SHIM_REL)), false, '首装前不存在的垫片，卸载后必须仍不存在')
  assert.equal(existsSync(path.join(app, MANIFEST_REL)), false, '卸载必须移除主缝 manifest')
  assert.equal(existsSync(path.join(app, RECORD_REL)), false, '卸载必须移除标准记录')
  assert.deepEqual(generated(app), [], '卸载不得留下记录/备份产物')
  assert.deepEqual(uninstallStandardSeams({ appDir: app }), { changed: false }, '卸载复跑必须幂等')
})

test('037-② round-history追加漂移时check/apply/uninstall三全拒且现场零改', async () => {
  const app = buildTree('drift')
  assert.equal(applyStandardSeams({ appDir: app }).changed, true, '前置：标准接入成功')
  assert.equal(checkStandardSeams({ appDir: app }).ready, true, '前置：接入后必须 ready')
  // 真施缝后漂移：往 round-history 追加一行（row 标记根因已修，期望保持原样）
  writeFileSync(path.join(app, ROUND_HISTORY_REL), read(app, ROUND_HISTORY_REL) + '\n// 漂移\n', 'utf8')
  const drifted = imageOf(app)
  for (const [label, attempt] of [
    ['check', () => checkStandardSeams({ appDir: app })],
    ['apply', () => applyStandardSeams({ appDir: app })],
    ['uninstall', () => uninstallStandardSeams({ appDir: app })],
  ]) {
    assert.throws(attempt, /漂移|作者更新不兼容/, label + ' 必须在漂移时响亮拒绝（兼容重接分支不得吞掉不匹配）')
    assert.deepEqual(imageOf(app), drifted, label + ' 被拒后现场必须零改（含记录与全部源码）')
  }
  // 把漂移字节放回后必须恢复 ready（拒绝不留下半状态）
  const appliedBytes = { ...drifted }
  writeFileSync(path.join(app, ROUND_HISTORY_REL), Buffer.from(appliedBytes[ROUND_HISTORY_REL], 'base64').toString('utf8').replace(/\n\/\/ 漂移\n$/, ''), 'utf8')
  assert.equal(checkStandardSeams({ appDir: app }).ready, true, '把漂移字节放回后必须重新 ready')
})

test('037-③ 真rehearseSource卸载预演清记录且作者before全字节零改', async () => {
  const app = buildTree('rehearse')
  const pristine = new Map(TARGETS.filter(rel => existsSync(path.join(app, rel))).map(rel => [rel, readFileSync(path.join(app, rel))]))
  assert.equal(applyStandardSeams({ appDir: app }).changed, true, '前置：标准接入成功')
  const installedImage = imageOf(app)
  assert.equal(installedImage[RECORD_REL] !== undefined, true, '前置：已施缝树必须有标准记录')

  const evidence = path.join(mkdtempSync(path.join(os.tmpdir(), 'tavern-037-uninstall-evidence-')), 'evidence')
  roots.push(path.dirname(evidence))
  mkdirSync(evidence, { recursive: true })
  const rehearsal = rehearseSource('uninstall', sourceAccess(app, TARGETS), ADAPTER, evidence)
  assert.equal(Object.hasOwn(rehearsal.result, 'outcome'), true, '卸载预演必须返回 outcome')
  assert.equal(rehearsal.result.data, '用户数据未访问、未删除、未转换', '卸载预演必须声明未触碰用户数据')
  assert.equal(rehearsal.expected[RECORD_REL], null, '卸载预演后的期望像里标准记录必须归 null')
  for (const rel of RECORD_RELS) assert.equal(rehearsal.expected[rel], null, '预演卸载清除自有记录：' + rel)
  // 作者 before 全字节零改（INDEX 例外：维护卸载明确保留作者启动安全 guard，与标准卸缝逐字恢复分开验）；
  // 作者 .js 在标准记录里从不为 null（null 只属于我方垫片），故这里不放过 null。
  for (const [rel, body] of pristine) {
    if (rel === INDEX_REL) continue
    assert.notEqual(rehearsal.expected[rel], null, '作者文件不得在预演期望像里被归 null：' + rel)
    assert.equal(rehearsal.expected[rel], body.toString('base64'), '预演卸载必须保留作者源码字节：' + rel)
  }
  assert.equal(existsSync(path.join(evidence, 'rehearsal', RECORD_REL)), false, '预演副本卸载后不得留下标准记录')
  assert.deepEqual(managedArtifacts(path.join(evidence, 'rehearsal')), [], '预演卸载不得留下自有备份产物')
  assert.deepEqual(imageOf(app), installedImage, '预演不得改动输入已施缝树的任何字节')

  // 安全反例（同原旧闸 321-327）：**未施缝裸树**的卸载预演必须响亮拒绝缺记录，不得静默当"已卸载"；输入裸树零改。
  const bareApp = buildTree('bare-unrehearse')
  const bareImage = imageOf(bareApp)
  const bareEvidence = path.join(mkdtempSync(path.join(os.tmpdir(), 'tavern-037-uninstall-evidence-')), 'evidence')
  roots.push(path.dirname(bareEvidence))
  mkdirSync(bareEvidence, { recursive: true })
  assert.throws(() => rehearseSource('uninstall', sourceAccess(bareApp, TARGETS), ADAPTER, bareEvidence),
    /卸载缺标准记录|标准记录/, '未施缝树的卸载预演必须失败（不猜整包已卸载）')
  assert.deepEqual(imageOf(bareApp), bareImage, '被拒的卸载预演不得改动输入裸树')
})
