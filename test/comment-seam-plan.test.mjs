import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSeamSource } from '../deploy/comment-seam-blocks.mjs'
import { planSeamInstall as install, planSeamUninstall as uninstall } from '../deploy/comment-seam-plan.mjs'
const owner = 'test-plugin', rel = 'author.js'
const anchor = { type: 'VariableDeclaration', name: 'result', init: { callee: 'db.prepare', arguments: [{ type: 'Literal', value: /^SELECT/ }] } }
const descriptor = changes => ({ owner, id: 'db-route', format: 1, revision: 1, mode: 'replace', purpose: '数据库接管', anchor, body: 'const result = plugin.prepare();\n', ...changes })
const apply = (source, d = descriptor(), record = null) => install(source, { rel, owner, descriptors: [d], record })
const undo = (source, record) => uninstall(source, { rel, owner, record })

test('结构定位：缩进空行引号及多行调用变化仍精确匹配并原字节卸载', () => {
  for (const source of [
    'const result = db.prepare(\'SELECT 1\');\n',
    '  const result = db.prepare( "SELECT 1" );\r\n',
    'const result =\n  db.prepare(\n    "SELECT 1"\n  );\n',
    'const result = db.prepare("SELECT 1");',
    '\uFEFFconst result = db.prepare("SELECT 1");\r\n'
  ]) {
    const result = apply(source)
    assert.equal(result.changed, true)
    // 记录只留 metadata（无 before/anchor 历史）：允许可选 tail（无尾 LF 场景），但不得出现历史键
    const meta = result.record.blocks[0]
    const allowed = ['format', 'id', 'mode', 'owner', 'purpose', 'revision', 'tail']
    assert.deepEqual(Object.keys(meta).filter(key => !allowed.includes(key)), [], '不得出现未声明键：' + Object.keys(meta).join(','))
    for (const key of ['beforeFragment', 'afterFragment', 'anchor', 'body']) assert.equal(Object.hasOwn(meta, key), false, '不得留历史键：' + key)
    assert.match(result.source, /ORIGINAL_BEGIN/)
    assert.match(result.source, /\/\/ .*db.prepare/)
    assert.equal(parseSeamSource(result.source).blocks.length, 1)
    assert.equal(undo(result.source, JSON.parse(JSON.stringify(result.record))).source, source)
  }
})

test('局部回退：块外用户变量编辑和foreign块保留且重复装卸幂等', () => {
  const foreign = install('const foreignResult = other.prepare();\n', { rel, owner: 'other-plugin', descriptors: [descriptor({ owner: 'other-plugin', id: 'foreign', anchor: { type: 'VariableDeclaration', name: 'foreignResult', init: { callee: 'other.prepare' } }, body: 'const foreignResult = otherPlugin.prepare();\n' })] })
  const source = 'const setting = 1;\r\n' + foreign.source + 'const result = db.prepare("SELECT 1");\n'
  const result = apply(source)
  const edited = result.source.replace('const setting = 1;', 'const setting = 42;')
  assert.equal(apply(edited, descriptor(), result.record).changed, false)
  const restored = undo(edited, result.record)
  assert.equal(restored.source, source.replace('const setting = 1;', 'const setting = 42;'))
  assert.equal(parseSeamSource(restored.source).blocks[0].metadata.owner, 'other-plugin')
  assert.equal(undo(restored.source, null).changed, false)
})

test('新增块：导入结构锚点前后插入与多个独立接缝可逆', () => {
  const source = 'import { value } from "author-route";\r\nconst result = db.prepare("SELECT 1");\n'
  for (const position of ['before', 'after']) {
    const d = descriptor({ id: 'new-route', mode: 'insert', anchor: { type: 'ImportDeclaration', source: 'author-route', position }, body: 'const pluginRoute = "plugin-route";\n' })
    const result = apply(source, d)
    assert.ok(Object.hasOwn(result.record.blocks[0], 'id'))
    assert.equal(Object.hasOwn(result.record.blocks[0], 'beforeFragment'), false, 'record 不留 before 历史')
    assert.equal(parseSeamSource(result.source).blocks[0].regions.original, null)
    assert.equal(undo(result.source, result.record).source, source)
  }
  const result = install(source, { rel, owner, descriptors: [descriptor(), descriptor({ id: 'import-route', anchor: { type: 'ImportDeclaration', source: 'author-route' }, body: 'import { value } from "plugin-route";\n' })] })
  assert.equal(result.record.blocks.length, 2)
  assert.equal(undo(result.source, result.record).source, source)
})

test('结构拒绝：零多命中同一行冲突多声明非法描述符和语法错误不产生计划', () => {
  const good = 'const result = db.prepare("SELECT 1");\n'
  for (const source of ['const other = db.prepare("SELECT 1");\n', 'function a(){\n'+good+'}\nfunction b(){\n'+good+'}\n', 'const result = db.prepare("SELECT 1"), extra = 2;\n', 'const before = 1; '+good, good.replace('SELECT', 'UPDATE')]) assert.throws(() => apply(source), /结构锚点/)
  assert.throws(() => apply(good, descriptor({ body: 'const result = ;\n' })), /语法/)
  assert.throws(() => apply(good, descriptor({ body: '// [dsh-tavern-seam:END]\n' })), /保留标记/)
  assert.throws(() => apply(good, descriptor({ anchor: { ...anchor, init: { callee: 'db.prepare', arguments: [{type:'Literal',value:/SELECT/g}] } } })), /有状态/)
  assert.throws(() => apply(good, descriptor({mode:'owned-new'})), /mode/)
  assert.throws(() => apply(good, descriptor({ anchor: {...anchor, unknown: true} })), /字段未知/)
  assert.throws(() => install(good, { rel, owner, descriptors: [descriptor(),descriptor({ id: 'collision' })] }), /冲突/)
})

test('记录护栏：坏记录不阻现场按块卸载、ACTIVE 改动可撤、换代可装', () => {
  const source = 'const result = db.prepare("SELECT 1");\n'
  const result = apply(source)
  // ① 坏 record（错 owner/rel/format/空 blocks/伪造块）一律不影响按现场块卸载
  for (const patch of [{owner:'wrong'}, {rel:'wrong.js'}, {format:2}, {blocks:[]}, 'not-a-record']) {
    assert.equal(uninstall(result.source, { rel, owner, record: patch }).source, source, '坏 record 不得阻卸载')
  }
  // ② 无 record 也必须能卸载（现场块自描述）
  assert.equal(uninstall(result.source, { rel, owner, record: null }).source, source)
  // ③ ACTIVE 区被改（插件实现变了）⇒ 仍可撤块还原 ORIGINAL
  const activeEdited = result.source.replace('plugin.prepare()', 'plugin.changed()')
  assert.notEqual(activeEdited, result.source)
  assert.equal(uninstall(activeEdited, { rel, owner }).source, source, 'ACTIVE 改动不阻撤块')
  // ④ revision 换代：新 descriptors 在旧现场上允许重装（不比较历史 body/实现代）
  const next = install(result.source, { rel, owner, descriptors: [descriptor({ revision: 2, body: 'const result = plugin.prepareV2();\n' })] })
  assert.equal(next.changed, true)
  assert.match(next.source, /plugin\.prepareV2/)
})

test('注释原文：原路径已有块注释和多行模板不会嵌套破坏并精确还原', () => {
  const source = 'const result = db.prepare(\n  /* 作者说明 */ `SELECT\n  中文`\n);\n'
  const d = descriptor({ anchor: { type: 'VariableDeclaration', name: 'result', init: { callee: 'db.prepare' } } })
  const result = apply(source, d)
  assert.match(result.source, /\/\/   \/\* 作者说明 \*\//)
  assert.equal(undo(result.source, result.record).source, source)
})

test('行注释边界：裸CR与Unicode行分隔拒绝且模板数据不能变活代码', () => {
  const d = descriptor({ anchor: { type: 'VariableDeclaration', name: 'result', init: { callee: 'db.prepare' } } })
  for (const separator of ['\r', '\u2028', '\u2029']) {
    const source = 'const result = db.prepare(`' + separator + 'globalThis.pwned=1//`);\n'
    assert.equal(parseSeamSource(source).ast.type, 'Program')                 // 原文件合法：分隔符只是模板串里的数据
    assert.throws(() => apply(source, d), /行终止符/)                          // 不得渲染成会提前结束 // 的 ORIGINAL 注释
  }
  for (const body of ['const result = x;\u2028globalThis.pwned = 1;\n', 'const result = x;\u2029globalThis.pwned = 1;\n']) {
    assert.throws(() => apply('const result = db.prepare("SELECT 1");\n', descriptor({ body })), /行终止符/)
  }
})
