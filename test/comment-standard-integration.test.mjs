// 阶段③ 标准接入集成：真实裸作者树（有限复制的 source fixture）上的注释区块装卸。
// 纪律：不 eval 产物、不读任何用户数据/真实档、不碰旧作者资产；产物只做语法与块结构校验（parseSeamSource）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { applyStandardSeams, checkStandardSeams, inspectStandardSeamsPlan, maintenanceTargets, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { COMMENT_SEAMS_RECORD } from '../deploy/comment-seam-files.mjs'
import { parseSeamSource } from '../deploy/comment-seam-blocks.mjs'
import { commentAuthorTreeSource, prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const OWNER = 'dsh-tavern-sqlite-v2'
const INDEX = 'tavern-plugin/lib/index.js'
const CLIENT_BUILT = 'tavern-plugin/lib/client.js'
const OLD_RECORDS = ['.tavern-standard-seams.json', '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json']
const MISSING = '缺少作者 source fixture：设 DSH_TAVERN_TEST_APP 或准备本地 author-fixture'
const COPIED = ['tavern-plugin/package.json', ...maintenanceTargets]   // 与 helper 复制范围一致（含作者包身份）
const readText = (appDir, rel) => readFileSync(path.join(appDir, rel), 'utf8')
const snapshot = appDir => new Map(COPIED.filter(rel => existsSync(path.join(appDir, rel))).map(rel => [rel, readText(appDir, rel)]))
const identical = (left, right, label) => assert.deepEqual([...left], [...right], label)

test('块产品1 真实裸树全部接缝安装卸载及源码构建双路径', async (t) => {
  const tree = prepareCommentAuthorTree()
  if (!tree) return t.skip(MISSING)
  const { appDir, original, cleanup } = tree
  t.after(cleanup)

  // ① 纯预检：只算不写
  const inspected = inspectStandardSeamsPlan({ appDir })
  assert.equal(inspected.preflight, 'passed', inspected.reason)
  assert.equal(inspected.authorVersion, JSON.parse(readText(appDir, 'tavern-plugin/package.json')).version)
  assert.equal(inspected.ready, false, '裸树尚未接入')
  identical(snapshot(appDir), original, '预检不得改写源码')

  // ② 真实裸树安装
  const applied = applyStandardSeams({ appDir, assertStopped: () => true })
  assert.equal(applied.ready, true)
  assert.equal(applied.changed, true)
  assert.ok(applied.written.length > 0, '安装必须真的写文件')
  assert.equal(checkStandardSeams({ appDir }).ready, true)
  const record = JSON.parse(readText(appDir, COMMENT_SEAMS_RECORD))
  assert.equal(record.format, 1)
  assert.equal(record.owner, OWNER)
  assert.equal(Object.keys(record).length, 4)
  assert.ok(Object.keys(record.files).length > 0, '必须有注释块文件')
  assert.ok(Object.keys(record.owned).length > 0, '必须有 owned-new')

  // ③ 产物只做语法/块校验（不 eval、不读用户数据）
  const after = snapshot(appDir)
  for (const [rel, text] of after) if (rel.endsWith('.js')) parseSeamSource(text, { rel })
  for (const rel of [...Object.keys(record.files), ...Object.keys(record.owned)]) assert.ok(after.has(rel), '记录文件必须存在：' + rel)
  for (const [rel, entry] of Object.entries(record.owned)) {
    // 新契约：owned 记录只留 metadata 四键（不存 body）；自有实现从现场 owned-file 块的 ACTIVE 投影读。
    assert.deepEqual(Object.keys(entry).sort(), ['format', 'mode', 'owner', 'rel'], 'owned 记录只留 metadata 四键：' + rel)
    assert.equal(entry.mode, 'owned-new')
    const owned = parseSeamSource(after.get(rel), { rel }).blocks
    assert.equal(owned.length, 1, rel + ' 必须是 id=owned-file 的 insert 块')
    assert.equal(owned[0].metadata.id, 'owned-file')
    const active = after.get(rel).slice(owned[0].regions.active.beginEnd, owned[0].regions.active.endStart)
    assert.ok(active.trim().length > 0, rel + ' ACTIVE 必须承载自有实现（非空）')
  }

  // ④ source / built 双路径都带真实块
  const sourceRels = Object.keys(record.files).filter(rel => rel.startsWith('tavern-plugin/src/client/'))
  assert.ok(sourceRels.length > 0, '拆分源码路径必须有块')
  assert.ok(Object.hasOwn(record.files, CLIENT_BUILT), '构建产物 lib/client.js 必须有块')
  for (const rel of [...sourceRels, CLIENT_BUILT]) assert.match(after.get(rel), /\[dsh-tavern-seam:ACTIVE_BEGIN\]/)

  // ⑤ 必要接线确实进了产物（failTarget / legacy guard / 宿主补丁共享入口）
  assert.match(after.get(CLIENT_BUILT), /failureTarget: state\.view && state\.view\.failureTarget/)
  assert.match(after.get(INDEX), /installAuthorHostSessionPatch\(ctx\)/)
  assert.match(after.get('tavern-plugin/lib/domain/tavern-conversation-registry.js'), /legacyViewSeams\.assertWritable\(/)
  assert.match(after.get('tavern-plugin/lib/domain/legacy-view-seams.js'), /installAuthorHostSessionPatch/)

  // ⑥ 重装零写
  const again = applyStandardSeams({ appDir, assertStopped: () => true })
  assert.equal(again.changed, false)
  assert.equal(again.written.length, 0)
  identical(snapshot(appDir), after, '重装必须零写')

  // ⑦ 块外用户编辑必须保留，卸载逐字节还原
  writeFileSync(path.join(appDir, INDEX), after.get(INDEX) + '\n// 用户说明\n', 'utf8')
  const uninstalled = uninstallStandardSeams({ appDir, assertStopped: () => true })
  assert.equal(uninstalled.changed, true)
  assert.equal(readText(appDir, INDEX), original.get(INDEX) + '\n// 用户说明\n', '块外编辑必须保留')
  const restored = snapshot(appDir)
  for (const [rel, text] of original) if (rel !== INDEX) assert.equal(restored.get(rel) ?? null, text, '必须逐字节还原：' + rel)
  for (const rel of Object.keys(record.owned)) assert.equal(existsSync(path.join(appDir, rel)), false, 'owned-new 必须删除：' + rel)
  assert.equal(existsSync(path.join(appDir, COMMENT_SEAMS_RECORD)), false, '记录必须删除')
  for (const rel of OLD_RECORDS) assert.equal(existsSync(path.join(appDir, rel)), false)
  assert.deepEqual(readdirSync(appDir).filter(name => name.startsWith('.tavern-')), [], '不得留下记录/备份')

  // ⑧ 重复卸载幂等
  const repeat = uninstallStandardSeams({ appDir, assertStopped: () => true })
  assert.equal(repeat.changed, false)
  identical(snapshot(appDir), restored, '重复卸载必须零写')
})

test('块产品2 旧机制拒与无记录现场区块可撤', async (t) => {
  if (!commentAuthorTreeSource()) return t.skip(MISSING)
  const fresh = () => { const tree = prepareCommentAuthorTree(); t.after(tree.cleanup); return tree }
  const install = appDir => { const result = applyStandardSeams({ appDir, assertStopped: () => true }); assert.equal(result.ready, true); return result }

  // ① 旧机制记录残留 ⇒ 旧 CLI 语义拒绝、零写
  const first = fresh(), firstBefore = snapshot(first.appDir)
  writeFileSync(path.join(first.appDir, '.tavern-standard-seams.json'), '{}\n', 'utf8')
  assert.throws(() => applyStandardSeams({ appDir: first.appDir, assertStopped: () => true }), /旧机制记录/)
  identical(snapshot(first.appDir), firstBefore, '旧记录拒绝必须零写')

  // ② 有自有块、记录缺失（记录删/换代）⇒ 允许按**现场块**处理：install 幂等零写、uninstall 允许
  const second = fresh(); install(second.appDir)
  const secondInstalled = snapshot(second.appDir)
  rmSync(path.join(second.appDir, COMMENT_SEAMS_RECORD), { force: true })
  const replan = applyStandardSeams({ appDir: second.appDir, assertStopped: () => true })
  assert.equal(replan.changed, true, '恢复 metadata 记录也算写：无记录重装必须 changed:true')
  identical(snapshot(second.appDir), secondInstalled, '但源码必须逐字节不变（只补记录）')
  assert.equal(uninstallStandardSeams({ appDir: second.appDir, assertStopped: () => true }).changed, true, '无记录也必须能按现场块卸载')

  // ③ 块内（ACTIVE）漂移 ⇒ 拒绝卸载且不覆盖现场
  const third = fresh(); install(third.appDir)
  const text = readText(third.appDir, CLIENT_BUILT)
  const open = '[dsh-tavern-seam:ACTIVE_BEGIN]\n'
  const at = text.indexOf(open)
  assert.ok(at > 0, '夹具产物必须含 ACTIVE 块：' + CLIENT_BUILT)
  const tampered = text.slice(0, at + open.length) + 'const 用户块内改动 = 1\n' + text.slice(at + open.length)
  writeFileSync(path.join(third.appDir, CLIENT_BUILT), tampered, 'utf8')
  // ③ ACTIVE 被改 ⇒ 仍按现场块删除（不保留用户改在 ACTIVE 里的插件实现；只有 ORIGINAL 侧才保留用户改动）
  assert.equal(uninstallStandardSeams({ appDir: third.appDir, assertStopped: () => true }).changed, true, 'ACTIVE 被改也要能撤块')
  assert.equal(readText(third.appDir, CLIENT_BUILT).includes('用户块内改动'), false, 'ACTIVE 里的改动随块一起撤掉')
})
