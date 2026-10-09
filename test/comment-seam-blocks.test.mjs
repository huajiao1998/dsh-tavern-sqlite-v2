import test from 'node:test'
import assert from 'node:assert/strict'
import {parseSeamSource} from '../deploy/comment-seam-blocks.mjs'

// 只测解析半段的词法/结构（plan/record 由主另文件测）：真伪 marker、损坏 marker 拒、结构拒、语法与入参拒。
const OB = '// [dsh-tavern-seam:ORIGINAL_BEGIN]', OE = '// [dsh-tavern-seam:ORIGINAL_END]'
const AB = '// [dsh-tavern-seam:ACTIVE_BEGIN]', AE = '// [dsh-tavern-seam:ACTIVE_END]'
const beginLine = (mode = 'replace') => `// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=${mode} purpose="接管排行"`
const endLine = (id = 'seam-a', owner = 'plug') => `// [dsh-tavern-seam:END] format=1 owner=${owner} id=${id}`
const blockText = (name = 'p') => [beginLine(), OB, '// const o = 1', OE, AB, `const ${name} = 1`, AE, endLine(), ''].join('\n')
const inner = (source, region) => source.slice(region.beginEnd, region.endStart)
const reject = (source, pattern) => assert.throws(() => parseSeamSource(source, {rel: 'user.js'}), pattern, 'rej: ' + String(source).slice(0, 160))

test('真实注释才认：string/template/regex 伪 marker 忽略，replace 与 insert 正确解出 regions', () => {
  const source = [
    'const s = "[dsh-tavern-seam:BEGIN] format=1 revision=1 owner=fake id=x mode=replace purpose=\\"y\\""',
    'const t = `[dsh-tavern-seam:ACTIVE_BEGIN]`',
    'const r = /\\[dsh-tavern-seam:END\\]/',
    'const head = 1',
    beginLine(),
    OB,
    '// const original = 1',
    OE,
    AB,
    'const patched = 2',
    AE,
    endLine(),
    ''
  ].join('\n')
  const {ast, blocks} = parseSeamSource(source, {rel: 'user.js'})
  assert.equal(ast.type, 'Program')                                             // 真语法树：伪 marker 没把语法弄坏
  assert.equal(blocks.length, 1)                                                // 只有真 comment 里的那一对
  const [block] = blocks
  assert.deepEqual(block.metadata, {format: 1, revision: 1, owner: 'plug', id: 'seam-a', mode: 'replace', purpose: '接管排行'})
  assert.equal(source.slice(block.start, block.start + 2), '//')                // 块从 BEGIN 标记行行首起
  assert.equal(block.text, source.slice(block.start, block.end))
  assert.equal(block.text.startsWith(beginLine()), true)
  assert.equal(block.text.endsWith(endLine() + '\n'), true)                     // 块到 END 标记行行尾（含 EOL）
  assert.equal(inner(source, block.regions.original), '// const original = 1\n')
  assert.equal(inner(source, block.regions.active), 'const patched = 2\n')

  const insert = [beginLine('insert'), AB, 'const patched = 3', AE, endLine(), ''].join('\n')
  const parsed = parseSeamSource(insert)
  assert.equal(parsed.blocks.length, 1)
  assert.equal(parsed.blocks[0].metadata.mode, 'insert')
  assert.equal(parsed.blocks[0].regions.original, null)                         // insert 不带 ORIGINAL
  assert.equal(inner(insert, parsed.blocks[0].regions.active), 'const patched = 3\n')
})

test('损坏 marker 拒：字段/format/revision/END 配对/非独占行/块注释/前缀不匹配', () => {
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=replace purpose="x" extra=1', /未声明字段/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a owner=plug mode=replace purpose="x"', /字段重复/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=replace purpose=x', /purpose 必须是 JSON 双引号字符串/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=replace', /缺少字段：purpose/)
  reject('// [dsh-tavern-seam:BEGIN] format=2 revision=1 owner=plug id=seam-a mode=replace purpose="x"', /format 只支持 1/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=0 owner=plug id=seam-a mode=replace purpose="x"', /revision 必须是正整数/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=9007199254740993 owner=plug id=seam-a mode=replace purpose="x"', /revision 必须是正整数/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=patch purpose="x"', /mode 只能是 insert\/replace/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=replace purpose="x"', /未闭合（缺 END）/)
  reject([beginLine(), OB, '// const o = 1', OE, AB, 'x', AE, endLine('other')].join('\n'), /END 字段与 BEGIN 不一致：id/)
  reject([beginLine(), OB, '// const o = 1', OE, AB, 'x', AE, endLine('seam-a', 'other')].join('\n'), /END 字段与 BEGIN 不一致：owner/)
  reject('const a = 1 // [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=replace purpose="x"', /非独占行的 Line 注释/)
  reject('/* [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=replace purpose="x" */', /块注释里出现接缝协议前缀/)
  reject('// [dsh-tavern-seam:BEGINS] format=1', /不匹配标记格式/)
  reject('// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=plug id=seam-a mode=replace  purpose="x"', /未闭合（缺 END）/) // 双空格仍可扫描，失败只缺 END
})

test('结构拒：同 owner+id 重复/嵌套/缺 END/子区域不对称或错序或重复', () => {
  reject(blockText('p1') + blockText('p2'), /owner\+id 重复/)                    // 同 owner+id 保守拒（body 取名不同，避免先撞语法重声明）
  reject([beginLine(), beginLine(), AB, 'x', AE, endLine(), ''].join('\n'), /外层接缝块嵌套/)
  reject([beginLine(), OB, '// const o = 1', OE, AB, 'const p = 1', AE, ''].join('\n'), /未闭合（缺 END）/)
  reject([beginLine(), OE, AB, 'x', AE, endLine(), ''].join('\n'), /子区域不对称/)
  reject([OB, OE, endLine(), ''].join('\n'), /出现在接缝块之外/)
  reject([beginLine(), AE, 'x', AE, endLine(), ''].join('\n'), /子区域不对称/)
  reject([beginLine(), AB, 'x', AE, OB, '// const o = 1', OE, endLine(), ''].join('\n'), /ORIGINAL 必须排在 ACTIVE 之前/)
  reject([beginLine(), OB, AB, 'x', AE, OE, endLine(), ''].join('\n'), /子区域嵌套/)
  reject([beginLine(), OB, '// const o = 1', OE, OB, '// const o = 2', OE, AB, 'x', AE, endLine(), ''].join('\n'), /子区域重复/)
  reject([beginLine(), AB, 'x', AE, endLine(), ''].join('\n'), /replace 块缺少 ORIGINAL/)
  reject([beginLine(), OB, '// const o = 1', OE, endLine(), ''].join('\n'), /缺少 ACTIVE 子区域/)
  reject([beginLine('insert'), OB, '// const o = 1', OE, AB, 'x', AE, endLine(), ''].join('\n'), /insert 块不允许 ORIGINAL/)
})

test('入参拒：syntax 不合法、source 非 string；无 marker 的干净源码返回空 blocks', () => {
  reject('const = 1', /语法无法解析/)
  reject('function (){', /语法无法解析/)
  for (const bad of [null, undefined, 42, ['a'], Buffer.from('x')]) reject(bad, /source 必须是字符串/)
  const clean = parseSeamSource('const a = 1\n', {rel: 'user.js'})
  assert.equal(clean.blocks.length, 0)
  assert.equal(clean.ast.type, 'Program')
})
