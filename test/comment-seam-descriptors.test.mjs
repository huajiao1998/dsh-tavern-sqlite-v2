// 注释块差分（descriptor）最小具名断言：空 body 的 replace（撤掉原语句）不得注入任何占位，
// 且 ACTIVE 投影必须与工厂 after **逐字节**一致（不是只 AST 等价）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { describeSeamChanges } from '../deploy/comment-seam-descriptors.mjs'
import { planSeamInstall, planSeamUninstall } from '../deploy/comment-seam-plan.mjs'
import { activeSource } from './fixtures/comment-author-tree.mjs'

const owner = 'dsh-tavern-sqlite-v2', rel = 'author.js'
const before = [
  'export function pick(flag) {',
  '  let unused = 1',
  '  const kept = flag',
  '  return kept',
  '}',
  ''
].join('\n')
const after = [
  'export function pick(flag) {',
  '  const kept = flag',
  '  return kept + unusedValue',
  '}',
  ''
].join('\n')

test('块差分1 空replace只撤原语句并精确还原', () => {
  // ① 差分：一处删语句（空 body 的 replace）+ 一处 return 改写
  const descriptors = describeSeamChanges(before, after, { rel, owner })
  assert.ok(descriptors.length >= 1, '必须产出描述符')
  // ② 落块后 ACTIVE 投影必须与 after 逐字节一致（占位注释会立刻打破）
  const installed = planSeamInstall(before, { rel, owner, descriptors })
  assert.equal(installed.changed, true)
  assert.equal(activeSource(installed.source, rel), after, 'ACTIVE 投影必须逐字节等于 after（不得注入占位）')
  assert.equal(installed.source.includes('作者路径由插件接管'), false, '不得注入兜底占位注释')
  // ③ 幂等：同 descriptors + record 复跑零写
  const again = planSeamInstall(installed.source, { rel, owner, descriptors, record: installed.record })
  assert.equal(again.changed, false, '复跑必须幂等')
  assert.equal(again.source, installed.source)
  // ④ 卸载：按记录逐字节还原作者原文
  assert.equal(planSeamUninstall(installed.source, { rel, owner, record: installed.record }).source, before)
  // ⑤ 自有块但无记录 ⇒ 仍按**现场**块还原（不核历史、不拒；记录只影响归属摘要）
  assert.equal(planSeamUninstall(installed.source, { rel, owner, record: null }).source, before, '无记录也必须只按现场块还原')
})
