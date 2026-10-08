// 锚点准入（anchor-only）具名断言（**只写不跑**，待主执行授权后跑）。
//
// 契约（本测试即验收标准）：
//   · 无 runtime manifest、非锚点被用户改过（注释/变量）、作者版本非固定身份的作者树：
//     安装只按"必要锚点全部命中 + 隔离整树施缝 + 语法 + ready"准入，**不按冻结树/catalog 字节放行**，
//     记录 compatibilityMode = 'anchor-only'。
//   · 三条断言全部走**真实消费者**：inspectStandardSeamsPlan（driver 未知版本预演放行层）、
//     sourceAccess + assertPackageSource + rehearseSource('install'|'uninstall')、applyStandardSeams/
//     checkStandardSeams/uninstallStandardSeams、planResidualUninstall + applyResidualPlan。
//
// 夹具：catalog 末树的有限作者源码集（catalog 本身**不含** coordinator）+ **真实** coordinator 字节
//   （来自上游真源 `tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47…/tavern-plugin/lib/domain/
//   background-task-coordinator.js`，含 setMessageFloor 锚，非 stub）→ 因此 coordinator 断言**无条件**执行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { loadAuthorCleanImages, planResidualUninstall, applyResidualPlan } from '../deploy/maintenance/residual-uninstall.mjs'
import { sourceAccess, assertPackageSource, rehearseSource } from '../deploy/maintenance/source.mjs'
import {
  applyStandardSeams, checkStandardSeams, uninstallStandardSeams, inspectStandardSeamsPlan,
} from '../deploy/standard-seams.mjs'
import { MESSAGE_ANCHORS } from '../deploy/native-data-transform.mjs'
// 真实维护 adapter（含 otherHostMarker/line/hostMarker/uninstallAllSeams 等真实字段）：
// 导入无副作用——runner 的 runCli 在 `process.argv[1] !== 本模块` 时立即 return（runner.mjs:201）。
import { maintenanceAdapter } from '../deploy/maintenance.mjs'

const RECORD_REL = '.tavern-standard-seams.json'
const PKG_REL = 'tavern-plugin/package.json'
const MANIFEST_REL = 'dsh-tavern-runtime.json'
const INDEX_REL = 'tavern-plugin/lib/index.js'
const COORDINATOR_REL = 'tavern-plugin/lib/domain/background-task-coordinator.js'
// 非锚点文件：只在文件尾追加注释/变量声明，绝不落在任何 transform 锚点上。
const COMMENT_REL = 'tavern-plugin/lib/domain/settlement-jobs.js'
const VARIABLE_REL = 'tavern-plugin/lib/domain/auto-compaction.js'
const OWN_MARKER_RE = /dsh-tavern-(?:storage-)?sqlite(?:-v[12])?|\[dsh-tavern-standard-owned:v1\]|\[dsh-tavern-core-host:v1\]/
const ANCHOR_MODE = 'anchor-only'
/** 真实 coordinator 真源（release-034 author-fixture，68215e47 代；含 setMessageFloor 锚恰一处）。 */
const REAL_COORDINATOR = fileURLToPath(new URL(
  '../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425/tavern-plugin/lib/domain/background-task-coordinator.js',
  import.meta.url))

const fileOf = (appDir, rel) => path.join(appDir, ...rel.split('/'))
const decodeImage = body => (body === null || body === undefined ? null : Buffer.from(body, 'base64'))
// 直接用真实 maintenance adapter（不再自造精简版：自造版缺 otherHostMarker 等字段会让
// assertPackageSource 的 `index.includes(undefined)` 误命中作者源码里的 'undefined' 字面量）。
const ADAPTER = maintenanceAdapter

function rewritePackageVersion(appDir, version) {
  const file = fileOf(appDir, PKG_REL)
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(pkg.name, 'dsh-tavern-plugin', '夹具 package 必须是作者包名')
  pkg.version = version
  writeFileSync(file, Buffer.from(JSON.stringify(pkg, null, 2) + '\n', 'utf8'))
}
/** 用户自改（非锚点）：注释 + 变量声明，全在文件尾。 */
function userEditNonAnchor(appDir, rel, note) {
  const file = fileOf(appDir, rel)
  assert.equal(existsSync(file), true, '夹具缺该文件：' + rel)
  writeFileSync(file, Buffer.concat([readFileSync(file),
    Buffer.from('\n// ' + note + '\nconst LOCAL_USER_TWEAK = { note: ' + JSON.stringify(note) + ' }\n', 'utf8')]))
}
/**
 * 公共夹具：catalog 末树 + **真实** coordinator + 无清单 + 版本 2.5.91 + 三处非锚点自改。
 * coordinator 无条件注入（真源缺文件时 assert.fail 亮失败，不静默跳过）。
 */
function anchorFixture(t, label) {
  assert.equal(existsSync(REAL_COORDINATOR), true, '缺真实 coordinator 真源（上游 fixture）：' + REAL_COORDINATOR)
  const catalog = loadAuthorCleanImages()
  const tree = catalog.trees.at(-1)
  assert.ok(tree, '缺 catalog 末树')
  const appDir = mkdtempSync(path.join(tmpdir(), 'anchor-only-' + label + '-'))
  t.after(() => rmSync(appDir, { recursive: true, force: true }))
  for (const [rel, item] of Object.entries(tree.files)) {
    if (item === null) continue
    const file = fileOf(appDir, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(item.body, 'base64'))
  }
  // catalog 无 coordinator：用真实上游字节补入（并核其 setMessageFloor 锚恰一处 ⇒ 施缝可命中）
  const coordinatorBytes = readFileSync(REAL_COORDINATOR)
  const escaped = MESSAGE_ANCHORS.setMessageFloor
  assert.equal(coordinatorBytes.toString('utf8').split(escaped).length - 1, 1,
    '真实 coordinator 真源必须恰含一处 setMessageFloor 锚（否则不是可施缝真源）')
  mkdirSync(path.dirname(fileOf(appDir, COORDINATOR_REL)), { recursive: true })
  writeFileSync(fileOf(appDir, COORDINATOR_REL), coordinatorBytes)
  if (existsSync(fileOf(appDir, MANIFEST_REL))) rmSync(fileOf(appDir, MANIFEST_REL))   // 确保"无清单"
  rewritePackageVersion(appDir, '2.5.91')
  userEditNonAnchor(appDir, COMMENT_REL, 'user note: ' + label)
  userEditNonAnchor(appDir, VARIABLE_REL, 'user variable: ' + label)
  userEditNonAnchor(appDir, COORDINATOR_REL, 'user note: coordinator ' + label)
  // 既定行为：独立原档保护（protectAuthorStartup）属于作者入口的既有护栏，不削弱。
  // 在用户自改之后、捕 snapshot 之前施护 ⇒ 记录/预演/残留恢复的 before 都是**受保护源码**。
  sourceAccess(appDir, ADAPTER.targets).protect()
  const protectedIndex = readFileSync(fileOf(appDir, INDEX_REL))
  const authorRels = [COMMENT_REL, VARIABLE_REL, COORDINATOR_REL, PKG_REL]
  return {
    appDir, tree, protectedIndex,
    authorBytes: new Map(authorRels.map(rel => [rel, readFileSync(fileOf(appDir, rel))])),
  }
}

test('无清单自改源码经真实inspect计划放行并落盘ready', async t => {
  const { appDir, tree } = anchorFixture(t, 'inspect')
  const authorVersion = JSON.parse(readFileSync(fileOf(appDir, PKG_REL), 'utf8')).version
  assert.equal(authorVersion, '2.5.91', '夹具作者版本不复刻固定身份')
  // 真实消费者①：driver 的未知版本预演放行层
  const plan = inspectStandardSeamsPlan({ appDir, authorVersion })
  assert.equal(plan.ready === true || plan.compatible?.ok === true, true,
    '无清单 + 非锚点自改 + 含 coordinator 的作者树必须被 inspect 计划放行；actual=' +
    JSON.stringify({ ready: plan.ready, reason: plan.reason, failures: plan.compatible?.failures?.slice(0, 3) }))
  assert.equal(plan.authorVersion, authorVersion, '计划必须回报现场作者版本')
  // 真实落盘：安装成功 → 严格 ready → 记录为 anchor-only
  assert.equal(applyStandardSeams({ appDir }).changed, true, '放行的树必须能安装')
  assert.equal(checkStandardSeams({ appDir }).ready, true, '安装后严格 check 必须 ready')
  assert.equal(checkStandardSeams({ appDir, authorVersion }).ready, true, '带 authorVersion 的 check 也必须 ready')
  const record = JSON.parse(readFileSync(fileOf(appDir, RECORD_REL), 'utf8'))
  assert.equal(record.compatibilityMode, ANCHOR_MODE, '无清单锚点准入必须记为 ' + ANCHOR_MODE)
  assert.equal(record.authorVersion, '2.5.91', 'record.authorVersion 取现场作者包版本')
  assert.equal(Object.hasOwn(record.before, COORDINATOR_REL), true, 'coordinator 必须进记录前像')
  assert.equal(Object.hasOwn(record.after, COORDINATOR_REL), true, 'coordinator 必须进 after')
  void tree
})

test('已装自改源码的真实source安装与卸载预演保真且只读', async t => {
  const { appDir, authorBytes, protectedIndex } = anchorFixture(t, 'rehearse')
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'anchor-only-evidence-'))
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }))
  const source = sourceAccess(appDir, ADAPTER.targets)
  // 无记录时：真实准入断言不得因"无冻结字节/无清单"而拒
  assert.doesNotThrow(() => assertPackageSource(source, ADAPTER, { allowRebase: true }),
    '无记录 + 无清单 + 非锚点自改时 assertPackageSource 不得拒绝')
  // 真实安装预演（隔离整树施缝 + 语法 + ready），且不得改动现场
  const installRehearsal = rehearseSource('install', source, ADAPTER, evidenceDir)
  assert.ok(installRehearsal?.before && installRehearsal?.expected, '安装预演必须返回 before/expected')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '安装预演不得改动现场（现场仍无记录）')
  assert.equal(applyStandardSeams({ appDir }).changed, true, '预演通过后真实施缝必须成功')
  assert.equal(checkStandardSeams({ appDir }).ready, true, '真实安装后必须 ready')
  // 真实卸载预演：只读 + 记录前像＝受保护的实际作者字节（含用户注释/变量/coordinator）
  const beforeSnapshot = source.capture()
  assert.doesNotThrow(() => assertPackageSource(source, ADAPTER), '已装未漂移树的 assertPackageSource 必须放行')
  const uninstallRehearsal = rehearseSource('uninstall', source, ADAPTER, evidenceDir)
  assert.ok(uninstallRehearsal?.before && uninstallRehearsal?.expected, '卸载预演必须返回 before/expected')
  assert.deepEqual(source.capture(), beforeSnapshot, '卸载预演必须只读：现场源码不得变化')
  for (const [rel, bytes] of authorBytes) {
    const expected = decodeImage(uninstallRehearsal.expected[rel])
    assert.ok(expected, '卸载预演必须给出该受管目标的 before 字节：' + rel)
    assert.equal(expected.equals(bytes), true, '卸载预演必须回到真实作者字节（含用户自改）：' + rel)
  }
  // 入口：既定独立原档保护仍在（受保护字节、且带保护内容），不被预演/卸载抹掉
  const expectedIndex = decodeImage(uninstallRehearsal.expected[INDEX_REL])
  assert.ok(expectedIndex, '卸载预演必须给出作者入口的 before 字节')
  assert.equal(expectedIndex.equals(protectedIndex), true, '入口 before 必须是受保护源码（既定护栏）')
  assert.equal(expectedIndex.equals(Buffer.from('')), false, '入口 before 不得为空')
  // 真实落盘卸载：逐字节回到实际 before
  assert.equal(uninstallStandardSeams({ appDir }).changed, true, '真实卸载必须产生变更')
  for (const [rel, bytes] of authorBytes) {
    assert.deepEqual(readFileSync(fileOf(appDir, rel)), bytes, '卸载必须逐字节回到实际 before：' + rel)
  }
  assert.deepEqual(readFileSync(fileOf(appDir, INDEX_REL)), protectedIndex, '卸载后作者入口必须仍是受保护源码')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '卸载后不得残留标准记录')
})

test('残留恢复保真实际before且coordinator不被当新建删除', async t => {
  const { appDir, authorBytes, protectedIndex } = anchorFixture(t, 'residual')
  assert.equal(applyStandardSeams({ appDir }).changed, true, '前置：锚点准入安装成功')
  const evidenceDir = mkdtempSync(path.join(tmpdir(), 'anchor-only-evidence-residual-'))
  t.after(() => rmSync(evidenceDir, { recursive: true, force: true }))
  const source = sourceAccess(appDir, ADAPTER.targets)
  const snapshot = source.capture()
  const plan = planResidualUninstall({ source, adapter: ADAPTER })
  assert.deepEqual(source.capture(), snapshot, '计划必须只读：不得改动源码')
  // ① 记录前像优先：期望结果＝真实作者 before（含注释/变量），不是 catalog 字节
  for (const [rel, bytes] of authorBytes) {
    const expected = decodeImage(plan.expected[rel])
    assert.ok(expected, '计划必须给出该受管目标的卸载后字节：' + rel)
    assert.equal(expected.equals(bytes), true, '残留恢复必须回到实际 before 字节：' + rel)
  }
  // ①b 作者入口：既定独立原档保护是 before 的一部分（受保护源码），不是裸作者字节
  const expectedIndex = decodeImage(plan.expected[INDEX_REL])
  assert.ok(expectedIndex, '计划必须给出作者入口的 before 字节')
  assert.equal(expectedIndex.equals(protectedIndex), true, '入口 before 必须是受保护源码（既定护栏）')
  // ② coordinator 无条件核（夹具已注入真实真源）：不得被判"插件新建"删除，必须回到其 before
  const expectedCoordinator = decodeImage(plan.expected[COORDINATOR_REL])
  assert.notEqual(expectedCoordinator, null, 'coordinator 不得被判为插件新建而删除')
  assert.equal(expectedCoordinator.equals(authorBytes.get(COORDINATOR_REL)), true, 'coordinator 必须回到其实际 before 字节')
  assert.equal(JSON.parse(decodeImage(plan.expected[PKG_REL]).toString('utf8')).version, '2.5.91', '作者包版本必须保留，不得退回冻结代')
  // ③ 计划结果零接管标记（含 coordinator）
  for (const rel of [...ADAPTER.targets, COORDINATOR_REL]) {
    if (!rel.endsWith('.js')) continue
    const expected = decodeImage(plan.expected[rel])
    if (expected === null) continue
    assert.equal(OWN_MARKER_RE.test(expected.toString('utf8')), false, '计划结果不得残留接管标记：' + rel)
  }
  assert.deepEqual(plan.summary.notes ?? [], [], '计划不得报告无法证明/损坏项：' + JSON.stringify(plan.summary.notes))
  // ④ 落盘后同样保真
  const applied = applyResidualPlan(source, plan, evidenceDir)
  applied.verify()
  for (const [rel, bytes] of authorBytes) {
    assert.deepEqual(readFileSync(fileOf(appDir, rel)), bytes, '落盘后必须保真实际 before：' + rel)
  }
  assert.deepEqual(readFileSync(fileOf(appDir, INDEX_REL)), protectedIndex, '落盘后作者入口仍是受保护源码')
  assert.equal(existsSync(fileOf(appDir, RECORD_REL)), false, '残留卸载必须撤除标准记录')
})
