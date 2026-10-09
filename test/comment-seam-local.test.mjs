// 注释接缝块·本地装卸协议（合成小源码 + 真实 plan/parse API；不 mock 业务）。
// 口径：无源码历史（record 仅纯块 metadata）、卸载只看现场块自描述、块消失即零写不回 before。
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSeamSource } from '../deploy/comment-seam-blocks.mjs'
import { planSeamInstall, planSeamUninstall } from '../deploy/comment-seam-plan.mjs'
import { describeSeamChanges } from '../deploy/comment-seam-descriptors.mjs'

const OWNER = 'dsh-tavern-sqlite-v2', REL = 'author.js'
const install = (source, after) => planSeamInstall(source, { rel: REL, owner: OWNER, descriptors: describeSeamChanges(source, after, { rel: REL, owner: OWNER }) })
const uninstall = source => planSeamUninstall(source, { rel: REL, owner: OWNER })

test('现场块1 无记录ORIGINAL变量修改与ACTIVE修改卸载', () => {
  const before = ['export function pick(flag) {', '  let unused = 1', '  const kept = flag', '  return kept', '}', ''].join('\n')
  const after = ['export function pick(flag) {', '  const kept = flag', '  return kept + 1', '}', ''].join('\n')
  const installed = install(before, after)
  assert.equal(installed.changed, true)
  // ① record 是纯 metadata：无 before/after/anchor 历史键
  assert.deepEqual(Object.keys(installed.record).sort(), ['blocks', 'format', 'owner', 'rel'])
  assert.equal(installed.record.format, 1)
  assert.equal(installed.record.owner, OWNER)
  assert.ok(installed.record.blocks.length >= 1)
  for (const meta of installed.record.blocks) {
    assert.equal(typeof meta.id, 'string')
    for (const key of ['beforeFragment', 'afterFragment', 'anchor', 'body']) assert.equal(Object.hasOwn(meta, key), false, 'record 不得留历史键：' + key)
  }
  // ② 用户改 ACTIVE 区里的插件实现 ⇒ 卸载不看实现字节，仍成功还原（ORIGINAL 未被改）
  const activeEdited = installed.source.replace('return kept + 1', 'return kept + 2')
  assert.notEqual(activeEdited, installed.source)
  assert.equal(uninstall(activeEdited).source, before, '卸载只解除我们加的一层注释，不核 ACTIVE 实现')
  // ③ 用户在 ORIGINAL 注释区改变量 ⇒ 卸载保留用户改动（逐行只剥 `// `）
  const originalEdited = installed.source.replace('//   let unused = 1', '//   let unused = 42')
  assert.notEqual(originalEdited, installed.source)
  assert.equal(uninstall(originalEdited).source, before.replace('let unused = 1', 'let unused = 42'), 'ORIGINAL 现场改动必须保留')
  // ④ 传入坏 record 也不影响卸载（record 不参与判定）
  assert.equal(planSeamUninstall(installed.source, { rel: REL, owner: OWNER, record: { format: 1, rel: REL, owner: OWNER, blocks: [] } }).source, before)
  assert.equal(planSeamUninstall(installed.source, { rel: REL, owner: OWNER, record: 'not-a-record' }).source, before)
})

test('现场块2 注释嵌套CRLF BOM EOF与重复装卸', () => {
  // ① CRLF + ORIGINAL 内含块注释（嵌套形态）⇒ 逐行 `// ` 不破坏内容
  const crlfBefore = ['export function pick(flag) {', '  /* 作者说明 */', '  return flag', '}', ''].join('\r\n')
  const crlfAfter = ['export function pick(flag) {', '  /* 作者说明 */', '  return flag + 1', '}', ''].join('\r\n')
  const crlf = install(crlfBefore, crlfAfter)
  assert.equal(crlf.source.includes('\r\n'), true, 'CRLF 现场的块外 EOL 必须原样保留')
  assert.equal(uninstall(crlf.source).source, crlfBefore, 'CRLF 现场逐字节还原')
  // ② EOF 无尾 LF ⇒ 该 replace 块必须带 tail=none；卸载不得凭空补 LF
  const noTail = install('export const a = 1', 'export const a = 2')
  const tailBlock = parseSeamSource(noTail.source, { rel: REL }).blocks[0]
  assert.equal(tailBlock.metadata.tail, 'none', '无尾 LF 的 replace 必须带 tail=none')
  assert.equal(uninstall(noTail.source).source, 'export const a = 1', 'EOF 无尾 LF 必须原样还原')
  // ③ 有尾 LF ⇒ 不写 tail 字段（LF 走正常还原）
  const withLf = install('export const a = 1\n', 'export const a = 2\n')
  assert.equal(Object.hasOwn(parseSeamSource(withLf.source, { rel: REL }).blocks[0].metadata, 'tail'), false, '有尾 LF 时不得写 tail')
  assert.equal(uninstall(withLf.source).source, 'export const a = 1\n')
  // ④ BOM：首行原文带 BOM ⇒ 注释后 BOM 仍在现场串里，装卸逐字节可逆（不是 hashbang 文件）
  const bomBefore = '\uFEFFexport const a = 1\n'
  const bom = install(bomBefore, '\uFEFFexport const a = 2\n')
  assert.equal(uninstall(bom.source).source, bomBefore, 'BOM 必须原样保留')
  // ⑤ 重复装卸：装→卸→再装→再卸 幂等，且第二次卸载零写
  const again = install(uninstall(withLf.source).source, 'export const a = 2\n')
  const off = uninstall(again.source)
  assert.equal(off.source, 'export const a = 1\n')
  assert.equal(uninstall(off.source).changed, false, '已无自有块 ⇒ 零写')
  // ⑥ 负例：insert 块不得带 tail=none（tail 只属 replace）
  const insertWithTail = ['// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=' + OWNER + ' id=owned-file mode=insert tail=none purpose="整文件"', '// [dsh-tavern-seam:ACTIVE_BEGIN]', 'export const a = 1', '// [dsh-tavern-seam:ACTIVE_END]', '// [dsh-tavern-seam:END] format=1 owner=' + OWNER + ' id=owned-file', ''].join('\n')
  assert.throws(() => parseSeamSource(insertWithTail, { rel: REL }), /tail|insert/, 'insert 带 tail=none 必须拒')
})
test('现场块3 消失块零写与半截块拒误删', () => {
  const before = ['export function pick(flag) {', '  return flag', '}', ''].join('\n')
  const after = ['export function pick(flag) {', '  return flag + 1', '}', ''].join('\n')
  const installed = install(before, after)
  // ① 块被整段覆盖（Tavern 升级形态）⇒ 卸载零写、不回写 before
  const gone = installed.source.replace(/\/\/ \[dsh-tavern-seam:BEGIN\][\s\S]*?\/\/ \[dsh-tavern-seam:END\][^\n]*\n/, '')
  assert.equal(gone.includes('[dsh-tavern-seam:'), false)
  const off = uninstall(gone)
  assert.equal(off.changed, false, '块消失必须零写')
  assert.equal(off.source, gone, '绝不按旧记录回写 before')
  assert.equal(off.record, null)
  // ② 块消失后重新命中当前接缝即可重接（清残留→重接路径）
  assert.equal(install(gone, after).changed, true, '块消失后必须能重新接缝')
  // ③ 半截块（缺 END）⇒ 解析即拒，不得据此猜区间删代码
  const half = installed.source.replace(/\/\/ \[dsh-tavern-seam:END\][^\n]*\n/, '')
  assert.throws(() => parseSeamSource(half, { rel: REL }), /未闭合|缺 END/)
  assert.throws(() => uninstall(half), /未闭合|缺 END/)
  // ④ ORIGINAL 行被用户去掉前缀（改坏）⇒ 拒，不误删
  const broken = installed.source.replace('//   return flag\n', '  return flag\n')
  assert.notEqual(broken, installed.source)
  assert.throws(() => uninstall(broken), /前缀/)
})
