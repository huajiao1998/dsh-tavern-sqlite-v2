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

// 注（T4）：原第 1 条「块产品1 真实裸树全部接缝安装卸载及源码构建双路径」已迁至薄入口 test/standard-positive.test.mjs
// （断言体在 support/standard-positive-observers.mjs，按共享生命周期阶段快照核）；本文件只保留故障用例。
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
