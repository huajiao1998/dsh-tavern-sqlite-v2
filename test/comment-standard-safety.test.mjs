// 块产品3：旧接管伪标记 / 自有记录归属 / 外来区块边界（真实 helper 作者树 + 真实 standard adapter；小 case 缺基线即 skip）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { maintenanceAdapter as adapter } from '../deploy/maintenance.mjs'
import { sourceAccess, assertPackageSource, STANDARD_RECORD } from '../deploy/maintenance/source.mjs'
import { applyStandardSeams, checkStandardSeams, uninstallStandardSeams } from '../deploy/standard-seams.mjs'
import { prepareCommentAuthorTree } from './fixtures/comment-author-tree.mjs'

const INDEX = 'tavern-plugin/lib/index.js'
const PKG = 'tavern-plugin/package.json'
const FOREIGN = id => `// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=foreign id=${id} mode=insert purpose="foreign"\n// [dsh-tavern-seam:ACTIVE_BEGIN]\nconst foreignNote = 1\n// [dsh-tavern-seam:ACTIVE_END]\n// [dsh-tavern-seam:END] format=1 owner=foreign id=${id}\n`
const OLD_LINE = '// [dsh-tavern-sqlite-v2] 旧接管行\n'
const noProcess = () => true

test('块产品3 旧接管伪标记自有记录归属与外来区块边界', async t => {
  const tree = prepareCommentAuthorTree()
  if (!tree) return t.skip('无真实作者 source fixture（DSH_TAVERN_TEST_APP 与本地 author-fixture 都不可用）')
  t.after(() => tree.cleanup())
  const src = sourceAccess(tree.appDir, adapter.targets), index = src.file(INDEX)
  const original = src.text(INDEX)
  if (original === null) return t.skip('夹具缺作者入口：' + INDEX)
  // case1 字符串伪标记 + 外来块（owner=foreign，id 与必需块号不同）：inspect 通过，装/卸都逐字节保留
  fs.writeFileSync(index, `const str = '[dsh-tavern-core-host:v1]'\n` + FOREIGN('foreign-note') + original, 'utf8')
  const injected = src.text(INDEX)
  assertPackageSource(src, adapter, { operation: 'install' })
  assert.equal(applyStandardSeams({ appDir: tree.appDir, assertStopped: noProcess }).changed, true)
  assert.equal(checkStandardSeams({ appDir: tree.appDir }).ready, true)
  assert.equal(uninstallStandardSeams({ appDir: tree.appDir, assertStopped: noProcess }).changed, true)
  assert.equal(src.text(INDEX), injected, '外来块与字符串伪标记必须逐字节保留')
  // case2 旧接管真实行注释（且出现在 index 顶部）：拒绝且零写入
  fs.writeFileSync(index, OLD_LINE + original, 'utf8')
  assert.throws(() => assertPackageSource(src, adapter, { operation: 'install' }), /旧|接管|拒绝/, '旧注释必须拒')
  assert.ok(src.text(INDEX).startsWith(OLD_LINE), '被拒时现场零写入')
  // case3 篡改 owned 记录 mode=insert（现场 body 不动）：check 与卸载都必须拒且不改 body
  fs.writeFileSync(index, injected, 'utf8')
  assert.equal(applyStandardSeams({ appDir: tree.appDir, assertStopped: noProcess }).changed, true)
  const record = JSON.parse(fs.readFileSync(src.file(STANDARD_RECORD), 'utf8'))
  const ownedRel = Object.keys(record.owned ?? {})[0]
  if (!ownedRel) t.diagnostic('本代工厂未产生 owned-new：case3 的 owned 篡改子项跳过（无基线，不假 pass）')
  else {
    // case3（新契约）：记录里的 mode 元数据错了也**不阻**按现场解除 —— 现场自有块才是证据
    record.owned[ownedRel].mode = 'insert'
    fs.writeFileSync(src.file(STANDARD_RECORD), JSON.stringify(record, null, 2) + '\n')
    assert.equal(checkStandardSeams({ appDir: tree.appDir }).ready, true, '记录 mode 错不该影响 ready（按现场块判定）')
    const off = uninstallStandardSeams({ appDir: tree.appDir, assertStopped: noProcess })
    assert.equal(off.changed, true, '记录 mode 错也必须能按现场卸载')
    assert.equal(fs.existsSync(ownedFile), false, '现场 owned 块被撤后该文件必须删除')
  }
  // case4 根 standard：合法作者包身份走 helper（version 只作诊断）
  const pkg = JSON.parse(fs.readFileSync(src.file(PKG), 'utf8'))
  assert.equal(pkg.name, 'dsh-tavern-plugin'); assert.equal(typeof pkg.version, 'string')
})
