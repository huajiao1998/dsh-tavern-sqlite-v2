// 兜底卸载 plan/apply 六项快断言：只用有限官方资产在自建GUID tmp 合成 app，不碰实机/真实数据/装配。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { sourceAccess } from '../deploy/maintenance/source.mjs'
import { protectAuthorStartup } from '../deploy/maintenance/author-safety.mjs'
import { loadAuthorCleanImages, planResidualUninstall, applyResidualPlan } from '../deploy/maintenance/residual-uninstall.mjs'

const catalog = loadAuthorCleanImages()
const tree = catalog.trees.find(item => item.commit.startsWith('8480f7de'))
const ownMarker = '// [dsh-tavern-standard-owned:v1]\n'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const official = (rel, commit = '8480f7de') => Buffer.from(catalog.trees.find(item => item.commit.startsWith(commit)).files[rel].body, 'base64')
const record = (before, after) => Buffer.from(JSON.stringify({ version: 1, authorVersion: '2.5.0', before, after }) + '\n', 'utf8')
const planOf = (f, extra) => planResidualUninstall({ source: f.source, adapter, catalog: extra || catalog })

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'residual-uninstall-' + randomUUID().slice(0, 8) + '-'))
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'residual-uninstall-'))); rmSync(root, { recursive: true, force: true }) })
  const app = path.join(root, 'apps', 'dsh-tavern'), evidence = path.join(root, 'evidence')
  mkdirSync(evidence, { recursive: true })
  for (const [rel, item] of Object.entries(tree.files)) if (item) { const file = path.join(app, rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, Buffer.from(item.body, 'base64')) }
  const sentinel = path.join(root, 'user-data', 'synthetic-sentinel.db')
  mkdirSync(path.dirname(sentinel), { recursive: true }); writeFileSync(sentinel, '合成用户数据，卸载不得读写\n', 'utf8')
  const source = sourceAccess(app, adapter.targets)
  const write = (rel, bytes) => { const file = source.file(rel); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes) }
  return { app, evidence, source, sentinel, write }
}

test('残留卸载1：record.after漂移但当前是可信官方新文件，保留new不写before旧像', t => {
  const f = fixture(t), rel = 'tavern-plugin/src/client/main.js'
  const now = official(rel), old = official(rel, '5d2ffacf')
  f.write('.tavern-standard-seams.json', record({ [rel]: old.toString('base64') }, { [rel]: sha(Buffer.from('drift')) }))
  const plan = planOf(f)
  assert.notEqual(plan.before[rel], old.toString('base64'))
  assert.equal(plan.expected[rel], plan.before[rel])
  assert.ok(plan.summary.keptOfficialFiles.includes(rel))
  assert.equal(plan.summary.changedFiles.some(item => item.relative === rel), false)
  applyResidualPlan(f.source, plan, f.evidence)
  assert.deepEqual(readFileSync(f.source.file(rel)), now)
})

test('残留卸载2：脏作者目标+准确receipt，回官方字节', t => {
  const f = fixture(t), rel = 'tavern-plugin/lib/domain/round-history.js'
  const clean = official(rel), dirty = Buffer.concat([Buffer.from(ownMarker), clean])
  f.write(rel, dirty)
  f.write('.tavern-standard-seams.json', record({ [rel]: official(rel, '5d2ffacf').toString('base64') }, { [rel]: sha(dirty) }))
  writeFileSync(path.join(f.app, '.dsh-tavern-release.json'), JSON.stringify({ commit: tree.commit }), 'utf8')
  const plan = planOf(f)
  assert.equal(plan.summary.authorReceipt, tree.commit)
  assert.equal(plan.expected[rel], clean.toString('base64'))
  assert.notEqual(plan.expected[rel], official(rel, '5d2ffacf').toString('base64'))
  const applied = applyResidualPlan(f.source, plan, f.evidence)
  assert.deepEqual(readFileSync(f.source.file(rel)), clean)
  applied.verify()
})

test('残留卸载3：安装中断无record，catalog.ownedFiles证明addon归属并撤除', t => {
  const f = fixture(t), rel = 'tavern-plugin/lib/domain/chat-sqlite-store.js'
  const addon = Buffer.from("export const kind = 'plugin addon'\n" + ownMarker)
  f.write(rel, addon)
  const plan = planOf(f, { ...catalog, ownedFiles: { [rel]: [sha(addon)] } })
  assert.equal(plan.expected[rel], null)
  assert.ok(plan.summary.changedFiles.some(item => item.relative === rel))
  const applied = applyResidualPlan(f.source, plan, f.evidence)
  assert.equal(existsSync(f.source.file(rel)), false)
  applied.verify()
})

test('残留卸载4：无标记但仍有插件import，不能假认纯作者', t => {
  const f = fixture(t), rel = 'tavern-plugin/src/client/main.js'
  const dirty = Buffer.concat([Buffer.from("import 'dsh-tavern-sqlite-v2'\n"), official(rel)])
  assert.equal(dirty.toString('utf8').includes('[dsh-tavern-'), false)
  f.write(rel, dirty)
  const plan = planOf(f)
  assert.equal(plan.summary.keptOfficialFiles.includes(rel), false, '零标记不能冒认作者纯净')
  assert.equal(plan.expected[rel], official(rel).toString('base64'), '其余可信现行字节唯一定位官方树后，可恢复而不是卡死')
  assert.deepEqual(readFileSync(f.source.file(rel)), dirty, 'plan仍只读')
})

test('残留卸载中断：受管文件截断丢失标记，按准确官方原像恢复，addon残字节清除', t => {
  const f = fixture(t), rel = 'tavern-plugin/lib/domain/round-history.js', addon = 'tavern-plugin/lib/domain/storage-package.js'
  f.write(rel, Buffer.from('expor')); f.write(addon, Buffer.from('impo'))
  writeFileSync(path.join(f.app, '.dsh-tavern-release.json'), JSON.stringify({ commit: tree.commit }), 'utf8')
  f.write('.tavern-standard-seams.json', record({ [rel]: official(rel).toString('base64'), [addon]: null }, { [rel]: sha(Buffer.from('完整安装态')), [addon]: sha(Buffer.from('完整垫片')) }))
  const plan = planOf(f)
  assert.equal(plan.expected[rel], official(rel).toString('base64')); assert.equal(plan.expected[addon], null)
  const applied = applyResidualPlan(f.source, plan, f.evidence); applied.verify()
  assert.deepEqual(readFileSync(f.source.file(rel)), official(rel)); assert.equal(existsSync(f.source.file(addon)), false)
})

test('残留卸载路径：伪造before指向业务数据，必须在读取它之前拒绝', t => {
  const f = fixture(t)
  f.write('.tavern-standard-seams.json', record({ 'profile-data/tavern/data/secret.db': null }, {}))
  assert.throws(() => planOf(f), /不属于有限源码维护范围/)
  assert.equal(readFileSync(f.sentinel, 'utf8'), '合成用户数据，卸载不得读写\n')
})

test('残留卸载无receipt：污染before不能卡死，由当前可信字节定位原像', t => {
  const f = fixture(t), rel = 'tavern-plugin/lib/index.js'
  const dirty = Buffer.concat([Buffer.from(ownMarker), official(rel)])
  f.write(rel, dirty)
  f.write('.tavern-standard-seams.json', record({ [rel]: Buffer.from(ownMarker + '污染旧前像').toString('base64') }, { [rel]: sha(dirty) }))
  const plan = planOf(f)
  assert.equal(plan.expected[rel], Buffer.from(protectAuthorStartup(official(rel).toString('utf8')), 'utf8').toString('base64'))
  assert.equal(plan.summary.authorReceipt, null)
})

test('残留卸载坏before：编码损坏不覆盖对应的可信官方恢复材料', t => {
  const f = fixture(t), rel = 'tavern-plugin/lib/domain/round-history.js'
  const dirty = Buffer.concat([Buffer.from(ownMarker), official(rel)])
  f.write(rel, dirty)
  f.write('.tavern-standard-seams.json', record({ [rel]: '??' }, { [rel]: sha(dirty) }))
  writeFileSync(path.join(f.app, '.dsh-tavern-release.json'), JSON.stringify({ commit: tree.commit }), 'utf8')
  const plan = planOf(f)
  assert.equal(plan.expected[rel], official(rel).toString('base64'))
  assert.ok(plan.summary.notes.some(note => note.includes('损坏')))
})

test('残留卸载未知新版：缺准确官方材料不按旧before误降级', t => {
  const f = fixture(t), rel = 'tavern-plugin/src/client/main.js'
  const dirty = Buffer.concat([Buffer.from(ownMarker), official(rel)])
  f.write(rel, dirty)
  writeFileSync(path.join(f.app, '.dsh-tavern-release.json'), JSON.stringify({ commit: 'f'.repeat(40) }), 'utf8')
  assert.throws(() => planOf(f), /需要当前酒馆准确官方源码/)
  assert.deepEqual(readFileSync(f.source.file(rel)), dirty)
})

test('残留卸载5：计划后CAS变化，apply拒不写入也不留journal', t => {
  const f = fixture(t), rel = 'tavern-plugin/lib/index.js'
  const plan = planOf(f)
  assert.ok(plan.summary.changedFiles.some(item => item.relative === rel))
  const outside = Buffer.from('// 计划后的外部新代\n')
  f.write(rel, outside)
  assert.throws(() => applyResidualPlan(f.source, plan, f.evidence), new RegExp('源码前像不匹配：' + rel.replace(/[/.]/g, '\\$&')))
  assert.deepEqual(readFileSync(f.source.file(rel)), outside)
  assert.equal(existsSync(path.join(f.evidence, 'residual-source-before.json')), false)
})

test('残留卸载6：apply返回的undo完整还原源码，合成用户数据sentinel不动', t => {
  const f = fixture(t)
  const dirtyRel = 'tavern-plugin/lib/domain/session-resource-access.js', addonRel = 'tavern-plugin/lib/domain/storage-package.js'
  const clean = official(dirtyRel), dirty = Buffer.concat([Buffer.from(ownMarker), clean])
  const addon = Buffer.from("export const kind = 'plugin addon'\n" + ownMarker)
  f.write(dirtyRel, dirty); f.write(addonRel, addon)
  const before = f.source.capture()
  const plan = planOf(f, { ...catalog, ownedFiles: { [addonRel]: [sha(addon)] } })
  const applied = applyResidualPlan(f.source, plan, f.evidence)
  assert.deepEqual(readFileSync(f.source.file(dirtyRel)), clean)
  assert.equal(existsSync(f.source.file(addonRel)), false)
  applied.verify()
  applied.undo()
  assert.deepEqual(f.source.capture(), before)
  assert.equal(readFileSync(f.sentinel, 'utf8'), '合成用户数据，卸载不得读写\n')
})
