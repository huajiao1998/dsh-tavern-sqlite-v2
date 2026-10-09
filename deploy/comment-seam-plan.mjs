// 结构锚点只用于定位；修改用原文区间拼接，保留块外字节，不生成整份作者代码。
import { parseSeamSource, seamBlockOriginal } from './comment-seam-blocks.mjs'
const PREFIX = '[dsh-tavern-seam:'
const token = /^[A-Za-z0-9_.:@/-]+$/
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const fail = message => { throw Error('注释接缝：' + message) }
const keys = (value, allowed, what) => { if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) fail(what + '字段未知或不是对象') }
const identity = (rel, owner) => { if (typeof rel !== 'string' || !rel || typeof owner !== 'string' || !token.test(owner)) fail('rel/owner 身份不合法') }

// 正则条件以 JSON 可保存的 {pattern,flags} 表示，不把 RegExp 对象写成空对象。
function condition(value) {
  if (value instanceof RegExp) value = { pattern: value.source, flags: value.flags }
  if (object(value)) {
    keys(value, ['pattern', 'flags'], '结构锚点值')
    if (typeof value.pattern !== 'string' || typeof (value.flags ?? '') !== 'string') fail('结构锚点正则不合法')
    const rx = new RegExp(value.pattern, value.flags ?? '')
    if (rx.global || rx.sticky) fail('结构锚点禁止有状态正则')
    return { pattern: rx.source, flags: rx.flags }
  }
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) fail('结构锚点 Literal 值不合法')
  if (typeof value === 'number' && !Number.isFinite(value)) fail('结构锚点数值不合法')
  return value
}
function normalizeAnchor(anchor) {
  keys(anchor, ['type', 'name', 'init', 'source', 'position', 'path', 'first', 'count'], '结构锚点')
  const result = { type: anchor.type }
  if (anchor.type === 'StatementRange') {
    if (!Array.isArray(anchor.path) || !anchor.path.length || !Number.isSafeInteger(anchor.first) || anchor.first < 0 || !Number.isSafeInteger(anchor.count) || anchor.count < 0) fail('结构语句区间不合法')
    if (anchor.path.some(k => !(Number.isSafeInteger(k) && k >= 0) && !(typeof k === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(k) && !['constructor','prototype','__proto__'].includes(k)))) fail('结构语句路径不合法')
    result.path = [...anchor.path]; result.first = anchor.first; result.count = anchor.count
  } else if (anchor.type === 'VariableDeclaration') {
    if (typeof anchor.name !== 'string' || !anchor.name) fail('结构锚点缺变量名')
    result.name = anchor.name
    keys(anchor.init, ['callee', 'arguments'], '结构锚点 init')
    if (typeof anchor.init.callee !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(anchor.init.callee)) fail('结构锚点 callee 不合法')
    result.init = { callee: anchor.init.callee }
    if (anchor.init.arguments !== undefined) {
      if (!Array.isArray(anchor.init.arguments)) fail('结构锚点 arguments 必须是数组')
      result.init.arguments = anchor.init.arguments.map(arg => {
        keys(arg, ['type', 'value'], '结构锚点 argument')
        if (arg.type !== 'Literal' || !Object.hasOwn(arg, 'value')) fail('目前结构参数只支持 Literal.value')
        return { type: 'Literal', value: condition(arg.value) }
      })
    }
  } else if (anchor.type === 'ImportDeclaration') {
    if (typeof anchor.source !== 'string' || !anchor.source) fail('结构导入锚点缺 source')
    result.source = anchor.source
  } else fail('目前结构锚点只支持 VariableDeclaration / ImportDeclaration')
  if (anchor.position !== undefined && !['before', 'after'].includes(anchor.position)) fail('结构锚点 position 不合法')
  result.position = anchor.position ?? 'before'
  return result
}
function descriptor(d, owner) {
  keys(d, ['format', 'revision', 'owner', 'id', 'mode', 'purpose', 'anchor', 'body'], 'descriptor')
  if (d.format !== 1 || !Number.isSafeInteger(d.revision) || d.revision < 1 || d.owner !== owner || typeof d.id !== 'string' || !token.test(d.id)) fail('descriptor 身份/协议不合法')
  if (!['insert', 'replace'].includes(d.mode) || typeof d.purpose !== 'string' || !d.purpose.trim() || /[\r\n\u2028\u2029]/.test(d.purpose)) fail('descriptor mode/purpose 不合法')
  // body 是**我们写入 ACTIVE 的插件实现**：CRLF 现场统一归一为 LF（ORIGINAL 侧仍原样保留 CRLF）；裸 CR/LS/PS 仍拒。
  const body = typeof d.body === 'string' ? d.body.replace(/\r\n/g, '\n') : d.body
  if (typeof body !== 'string' || (!body.trim() && !(d.mode === 'replace' && body === '')) || /[\r\u2028\u2029]/.test(body) || body.includes(PREFIX)) fail('descriptor body 须为非空 LF 源码，不能含保留标记或其他行终止符')
  return { format: 1, revision: d.revision, owner, id: d.id, mode: d.mode, purpose: d.purpose, anchor: normalizeAnchor(d.anchor), body }
}
function calleeName(node) {
  if (node?.type === 'Identifier') return node.name
  if (node?.type === 'MemberExpression' && !node.computed && !node.optional && node.property.type === 'Identifier') {
    const base = calleeName(node.object); return base ? base + '.' + node.property.name : null
  }
  return null
}
function matches(node, a) {
  if (node.type !== a.type) return false
  if (a.type === 'ImportDeclaration') return node.source.value === a.source
  // 多变量声明不能只改其中一半；保留整个声明的语义边界。
  if (node.declarations.length !== 1) return false
  const declaration = node.declarations[0], init = declaration.init
  if (declaration.id.type !== 'Identifier' || declaration.id.name !== a.name || init?.type !== 'CallExpression' || init.optional || calleeName(init.callee) !== a.init.callee) return false
  if (!a.init.arguments) return true
  return init.arguments.length === a.init.arguments.length && init.arguments.every((arg, i) => {
    const expected = a.init.arguments[i].value
    if (arg.type !== 'Literal' || arg.regex) return false
    return object(expected) ? typeof arg.value === 'string' && new RegExp(expected.pattern, expected.flags).test(arg.value) : arg.value === expected
  })
}
function findAnchor(source, parsed, a) {
  if (a.type === 'StatementRange') {
    let list = parsed.ast
    for (const key of a.path) { if (!list || !Object.hasOwn(list, key)) fail('结构语句路径缺失'); list = list[key] }
    if (!Array.isArray(list) || a.first > list.length || a.first + a.count > list.length || !['body','consequent','cases'].includes(a.path.at(-1))) fail('结构语句区间越界')
    if (a.first === 0 && list.length === 0) return { start: source.length, end: source.length }   // 空语句列表（如整文件 insert）落 EOF
    const node = list[a.first] ?? list.at(-1)
    if (!node || typeof node.type !== 'string') fail('结构语句插入点缺失')
    const atEnd = a.first === list.length
    const start = atEnd ? (source.indexOf('\n',node.end)<0?source.length:source.indexOf('\n',node.end)+1) : source.lastIndexOf('\n',node.start-1)+1
    const last = a.count ? list[a.first+a.count-1] : null
    const end = last ? (source.indexOf('\n',last.end)<0?source.length:source.indexOf('\n',last.end)+1) : start
    if (!atEnd && !/^[ \t\uFEFF]*$/.test(source.slice(start,node.start)) || last && !/^[ \t\r\n]*$/.test(source.slice(last.end,end))) fail('结构语句不是独立整行：'+JSON.stringify({anchor:a,nodeStart:node.start,lastEnd:last?.end,start,end,before:source.slice(start,node.start),after:last?source.slice(last.end,end):''}))
    if (parsed.blocks.some(b => start < b.end && end > b.start)) fail('结构语句与既有块重叠')
    return {start,end}
  }
  const found = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (node.type && matches(node, a)) found.push(node)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc') continue
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === 'object') visit(value)
    }
  }
  visit(parsed.ast)
  if (found.length !== 1) fail('结构锚点须唯一，命中 ' + found.length + ' 处')
  const node = found[0]
  const start = source.lastIndexOf('\n', node.start - 1) + 1
  let end = source.indexOf('\n', node.end)
  end = end < 0 ? source.length : end + 1
  // 必须是独立完整语句行；export 前缀、同一行其他语句等需独立 descriptor，不能猜。
  if (!/^[ \t\uFEFF]*$/.test(source.slice(start, node.start)) || !/^[ \t\r\n]*$/.test(source.slice(node.end, end))) fail('结构锚点不是独立完整语句区间')
  if (source.slice(start, end).includes(PREFIX)) fail('结构锚点原片段含保留标记')
  if (parsed.blocks.some(b => start < b.end && end > b.start)) fail('结构锚点与既有块重叠')
  return { start, end }
}
const mark = (name, fields = '') => '// [dsh-tavern-seam:' + name + ']' + (fields ? ' ' + fields : '') + '\n'
function render(d, original) {
  // ECMAScript 的裸 CR/LS/PS 会结束 //，仅逐 LF 注释不能安全承载它们；CRLF 仍完整保留。
  if (/\r(?!\n)|[\u2028\u2029]/.test(original)) fail('原片段含不支持的行终止符，拒绝可能逃逸的 ORIGINAL 注释')
  let out = mark('BEGIN', `format=1 revision=${d.revision} owner=${d.owner} id=${d.id} mode=${d.mode} purpose=${JSON.stringify(d.purpose)}`)
  if (d.mode === 'replace') {
    // 逐行注释支持原文已有 /* */；ORIGINAL 解码只用于核对真实记录，不作为无记录兜底。
    const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? []
    out += mark('ORIGINAL_BEGIN') + lines.map(line => '// ' + line).join('')
    if (!out.endsWith('\n')) out += '\n'
    out += mark('ORIGINAL_END')
  }
  out += mark('ACTIVE_BEGIN') + d.body + (d.body === '' || d.body.endsWith('\n') ? '' : '\n') + mark('ACTIVE_END')
  return out + mark('END', `format=1 owner=${d.owner} id=${d.id}`)
}
// 现场记录（可选归属摘要）：只留块 metadata，不留 before/after/anchor 历史，不参与原文还原。
const ownBlocksOf = (text, rel, owner) => parseSeamSource(text, { rel }).blocks.filter(b => b.metadata.owner === owner)
const recordOf = (text, rel, owner) => ({ format: 1, rel, owner, blocks: ownBlocksOf(text, rel, owner).map(b => b.metadata) })
// replace 块仅在原片段**非空且原本不以 LF 结尾**时补 tail=none（标识渲染期补的那 1 个结构 padding LF，不是 before 内容）；
// 其余情况不写 tail 字段 ⇒ 原有 LF/CRLF 原样还原。ORIGINAL 是**现场**字节，不是记录核验对象。
const renderSeam = (d, original) => {
  const out = render(d, original)
  return d.mode === 'replace' && original !== '' && !original.endsWith('\n') ? out.replace(' mode=replace ', ' mode=replace tail=none ') : out
}
function splice(source, edits) {
  const ordered = [...edits].sort((a, b) => a.start - b.start)
  for (let i = 1; i < ordered.length; i++) if (ordered[i].start < ordered[i - 1].end || ordered[i].start === ordered[i - 1].start) fail('多个接缝修改区间冲突')
  let out = source
  for (const edit of ordered.reverse()) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}
/**
 * 安装（不依赖历史）：① 先按现场自有块撤到作者投影 base（无记录也撤）；② 在 base 上按当前 descriptors 重新命中 anchor 并落块。
 * record 参数仅为兼容调用方保留，**不参与任何历史一致性校验**。
 */
export function planSeamInstall(source, { rel, owner, descriptors, record = null } = {}) {
  identity(rel, owner)
  if (!Array.isArray(descriptors) || !descriptors.length) fail('descriptors 必须是非空显式清单')
  const ds = descriptors.map(d => descriptor(d, owner))
  if (new Set(ds.map(d => d.id)).size !== ds.length) fail('descriptor id 重复')
  const base = planSeamUninstall(source, { rel, owner }).source   // 现场自有块 → 作者投影（无 history）
  const parsed = { ...parseSeamSource(base, { rel }), text: base }
  const edits = []
  for (const d of ds) {
    const range = findAnchor(base, parsed, d.anchor)
    let start = range.start, end = d.mode === 'replace' ? range.end : range.start
    if (d.mode === 'replace' && start === end) fail('替换区间为空')
    if (d.mode === 'insert' && d.anchor.position === 'after') start = end = range.end
    if (d.mode === 'insert' && start > 0 && base[start - 1] !== '\n') fail('after 插入点无行结束符，拒绝改变块外字节')
    edits.push({ start, end, text: renderSeam(d, d.mode === 'replace' ? base.slice(start, end) : '') })
  }
  const next = edits.length ? splice(base, edits) : base
  parseSeamSource(next, { rel })   // 注入语法与块完整性；出错即计划零写入
  return { source: next, record: recordOf(next, rel, owner), changed: next !== source }
}
/**
 * 卸载（不依赖记录、不核历史）：现场自有块 → `seamBlockOriginal` 逐行只剥本机制加的一层 `// `；insert 整块删。
 * 块完全消失 ⇒ changed:false 零写（绝不按旧 record 回写 before）；半截块/ORIGINAL 缺前缀由 seamBlockOriginal 抛错。
 */
export function planSeamUninstall(source, { rel, owner, record = null } = {}) {
  identity(rel, owner)
  const parsed = { ...parseSeamSource(source, { rel }), text: source }
  const own = parsed.blocks.filter(b => b.metadata.owner === owner)
  if (!own.length) return { source, record: null, changed: false }
  const next = splice(source, own.map(block => ({ start: block.start, end: block.end, text: seamBlockOriginal(source, block) })))
  const checked = parseSeamSource(next, { rel })
  const left = checked.blocks.filter(b => b.metadata.owner === owner)
  return { source: next, record: left.length ? recordOf(next, rel, owner) : null, changed: next !== source }
}
