// comment-seam-blocks —— 接缝注释块的词法/解析半段（纯字符串：无 fs、无写计划/记录逻辑）
// 协议（都是"独占整行的 Line 注释"，`//` 前只允许行内空白）：
//   BEGIN:  // [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=x id=y mode=replace purpose="标签"
//   子标记: // [dsh-tavern-seam:ORIGINAL_BEGIN] / :ORIGINAL_END / :ACTIVE_BEGIN / :ACTIVE_END（无字段；
//           replace 必带 ORIGINAL、两种 mode 都必带 ACTIVE，且 ORIGINAL 必须排在 ACTIVE 之前）
//   END:    // [dsh-tavern-seam:END] format=1 owner=x id=y（三字段必须与 BEGIN 全等）
// 铁律：① 只用真实 Acorn 词法 —— 字符串/模板/正则里的伪前缀不是注释，天然不管；块注释、非独占行 Line 注释里
//   出现真实前缀 `[dsh-tavern-seam` 即拒（不能把损坏 marker 当首次安装）；② 独占行 Line 注释里出现前缀但不匹配
//   上述任一格式即拒，唯一例外是 ORIGINAL 区内的 `// `+原文行；③ 只返回原文区间，块外字节永不触碰，不做 AST 生成。
// regions[name]={beginStart,beginEnd,endStart,endEnd} = *_BEGIN / *_END 标记行的行首与行尾（含 EOL）；
//   子区域内容 = text.slice(regions[name].beginEnd, regions[name].endStart)。
import { parse } from '../lib/vendor/acorn/acorn.mjs'

const PREFIX = '[dsh-tavern-seam'
const BEGIN_RE = /^[ \t]*\[dsh-tavern-seam:BEGIN\](?=[ \t]|$)/
const END_RE = /^[ \t]*\[dsh-tavern-seam:END\](?=[ \t]|$)/
const SUB_RE = /^[ \t]*\[dsh-tavern-seam:(ORIGINAL_BEGIN|ORIGINAL_END|ACTIVE_BEGIN|ACTIVE_END)\][ \t]*$/
const SAFE_TOKEN = /^[A-Za-z0-9_.:@/-]+$/
const BEGIN_KEYS = ['format', 'revision', 'owner', 'id', 'mode', 'purpose'], END_KEYS = ['format', 'owner', 'id'], MODES = ['insert', 'replace']
const fail = (rel, message) => { throw new Error(rel + '：' + message) }
const lineStart = (text, index) => text.lastIndexOf('\n', index - 1) + 1
const lineBodyEnd = (text, index) => { const at = text.indexOf('\n', index); return at < 0 ? text.length : at }
const lineFullEnd = (text, index) => { const at = text.indexOf('\n', index); return at < 0 ? text.length : at + 1 }
const ownLine = (text, comment) => /^[ \t]*$/.test(text.slice(lineStart(text, comment.start), comment.start)) && /^[ \t\r]*$/.test(text.slice(comment.end, lineBodyEnd(text, comment.end)))

// 标记尾部 key=value 逐字段 decode（不对整行做 JSON 键 regex，避免把 purpose 的值误当键）：
// 值只能是 JSON 双引号字符串（purpose）或 safe token；字段名非法/重复/未声明/引号未闭合/引号后缺空白一律拒。
function scanFields(rel, tail, keys, where, optional = []) {
  const fields = new Map(), isSpace = ch => ch === ' ' || ch === '\t'
  for (let index = 0; index < tail.length;) {
    while (isSpace(tail[index])) index++
    if (index >= tail.length) break
    const eq = tail.indexOf('=', index)
    if (eq < 0) fail(rel, where + ' 字段缺少 =：' + JSON.stringify(tail.slice(index)))
    const key = tail.slice(index, eq)
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) fail(rel, where + ' 字段名非法：' + JSON.stringify(key))
    if (fields.has(key)) fail(rel, where + ' 字段重复：' + key)
    if (!keys.includes(key)) fail(rel, where + ' 出现未声明字段：' + key)
    if (tail[eq + 1] === '"') {
      let stop = eq + 2
      while (stop < tail.length && tail[stop] !== '"') stop += tail[stop] === '\\' ? 2 : 1
      if (stop >= tail.length) fail(rel, where + ' 字段引号未闭合：' + key)
      let value
      try { value = JSON.parse(tail.slice(eq + 1, stop + 1)) } catch (error) { fail(rel, where + ' 字段不是合法 JSON 字符串：' + key) }
      if (typeof value !== 'string') fail(rel, where + ' 字段值必须是字符串：' + key)
      fields.set(key, { value, quoted: true }); index = stop + 1
      if (index < tail.length && !isSpace(tail[index])) fail(rel, where + ' 引号字段后必须是空白：' + key)
    } else {
      let stop = eq + 1
      while (stop < tail.length && !isSpace(tail[stop])) stop++
      const token = tail.slice(eq + 1, stop)
      if (!SAFE_TOKEN.test(token)) fail(rel, where + ' 字段值不符合安全 token：' + key + '=' + JSON.stringify(token))
      fields.set(key, { value: token, quoted: false }); index = stop
    }
  }
  for (const key of keys) if (!optional.includes(key) && !fields.has(key)) fail(rel, where + ' 缺少字段：' + key)
  return fields
}

/** BEGIN：定键 + 可选 `tail=none`（结构尾换行标识，不是 before 内容）；purpose 必须 JSON 引号字符串，其余 safe token。 */
function readBegin(rel, tail) {
  const fields = scanFields(rel, tail, [...BEGIN_KEYS, 'tail'], 'BEGIN', ['tail'])
  const token = key => { const field = fields.get(key); if (field.quoted) fail(rel, 'BEGIN 字段 ' + key + ' 不能是引号字符串'); return field.value }
  const purpose = fields.get('purpose'), format = token('format'), revision = token('revision'), mode = token('mode'), tailField = fields.get('tail')
  if (tailField && (tailField.quoted || tailField.value !== 'none')) fail(rel, 'BEGIN 字段 tail 只支持 none：' + JSON.stringify(tailField.value))
  if (tailField && mode !== 'replace') fail(rel, 'BEGIN 字段 tail 只允许 replace 块：' + mode)
  if (!purpose.quoted) fail(rel, 'BEGIN 字段 purpose 必须是 JSON 双引号字符串')
  if (purpose.value.trim() === '') fail(rel, 'BEGIN 字段 purpose 不能为空')
  if (format !== '1') fail(rel, '接缝块 format 只支持 1：' + JSON.stringify(format))
  if (!/^[1-9][0-9]*$/.test(revision) || !Number.isSafeInteger(Number(revision))) fail(rel, '接缝块 revision 必须是正整数（安全整数）：' + JSON.stringify(revision))
  if (!MODES.includes(mode)) fail(rel, '接缝块 mode 只能是 insert/replace：' + JSON.stringify(mode))
  return { format: 1, revision: Number(revision), owner: token('owner'), id: token('id'), mode, purpose: purpose.value, ...(tailField ? { tail: 'none' } : {}) }
}

/**
 * 解析源码：返回 Acorn AST 与文件内全部接缝块（按出现顺序）。
 * block.start = BEGIN 标记行行首；block.end = END 标记行行尾（含 EOL）⇒ 整块按整行增删、不残留空行。
 * @returns {{ast: object, blocks: Array<{metadata: object, start: number, end: number, text: string, regions: object}>}}
 */
export function parseSeamSource(source, { rel = 'source.js' } = {}) {
  if (typeof source !== 'string') fail(rel, 'source 必须是字符串（不做 String() 隐式转换）')
  const text = source, comments = [], blocks = [], ids = new Set()
  let ast, open = null
  try {
    ast = parse(text, {
      ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true,
      // Acorn 回调形态是 (block:boolean, value, start, end, …)：block=false 才是 Line 注释。
      onComment: (block, value, start, end) => comments.push({ block, value, start, end })
    })
  } catch (error) { fail(rel, '语法无法解析，拒绝在未知语法上定位接缝：' + (error && error.message)) }
  for (const comment of comments) {
    const body = comment.value
    if (comment.block) {
      if (text.slice(comment.start, comment.end).includes(PREFIX)) fail(rel, '块注释里出现接缝协议前缀，拒绝当作标记')
      continue
    }
    if (!ownLine(text, comment)) {
      if (body.includes(PREFIX)) fail(rel, '非独占行的 Line 注释里出现接缝协议前缀，拒绝当作标记')
      continue
    }
    const begin = BEGIN_RE.exec(body)
    if (begin) {
      if (open) fail(rel, '外层接缝块嵌套：上一个块（' + open.meta.id + '）未 END')
      const meta = readBegin(rel, body.slice(begin[0].length)), key = meta.owner + '\u0000' + meta.id
      if (ids.has(key)) fail(rel, '同文件内 owner+id 重复：' + meta.owner + '/' + meta.id)
      ids.add(key)
      open = { meta, start: lineStart(text, comment.start), regions: { original: null, active: null }, sub: null }
      continue
    }
    const end = END_RE.exec(body)
    if (end) {
      if (!open) fail(rel, 'END 没有对应 BEGIN')
      if (open.sub) fail(rel, open.sub.name + ' 子区域未闭合：' + open.meta.id)
      if (open.meta.mode === 'replace' && !open.regions.original) fail(rel, 'replace 块缺少 ORIGINAL 子区域：' + open.meta.id)
      if (open.meta.mode === 'insert' && open.regions.original) fail(rel, 'insert 块不允许 ORIGINAL 子区域：' + open.meta.id)
      if (!open.regions.active) fail(rel, '接缝块缺少 ACTIVE 子区域：' + open.meta.id)
      if (open.regions.original && open.regions.original.beginStart > open.regions.active.beginStart) fail(rel, 'ORIGINAL 必须排在 ACTIVE 之前：' + open.meta.id)
      const fields = scanFields(rel, body.slice(end[0].length), END_KEYS, 'END') // END 三字段必须与 BEGIN 全等
      for (const key of END_KEYS) {
        const field = fields.get(key), want = key === 'format' ? '1' : open.meta[key]
        if (field.quoted || field.value !== want) fail(rel, 'END 字段与 BEGIN 不一致：' + key + '=' + JSON.stringify(field.value))
      }
      const stop = lineFullEnd(text, comment.end)
      blocks.push({ metadata: open.meta, start: open.start, end: stop, text: text.slice(open.start, stop), regions: open.regions })
      open = null
      continue
    }
    const sub = SUB_RE.exec(body)
    if (sub) {
      if (!open) fail(rel, sub[1] + ' 出现在接缝块之外')
      const name = sub[1].replace(/_(BEGIN|END)$/, ''), region = name.toLowerCase()
      if (sub[1].endsWith('_BEGIN')) {
        if (open.sub) fail(rel, '子区域嵌套：' + sub[1] + '（' + open.meta.id + '）')
        if (open.regions[region]) fail(rel, '子区域重复：' + sub[1] + '（' + open.meta.id + '）')
        open.sub = { name, beginStart: lineStart(text, comment.start), beginEnd: lineFullEnd(text, comment.end) }
        continue
      }
      if (!open.sub || open.sub.name !== name) fail(rel, '子区域不对称：' + sub[1] + '（' + open.meta.id + '）')
      open.regions[region] = { beginStart: open.sub.beginStart, beginEnd: open.sub.beginEnd, endStart: lineStart(text, comment.start), endEnd: lineFullEnd(text, comment.end) }
      open.sub = null
      continue
    }
    if (body.includes(PREFIX)) {
      if (open && open.sub && open.sub.name === 'ORIGINAL') continue // ORIGINAL 区 '// '+原文 的例外
      fail(rel, '接缝协议前缀出现但不匹配标记格式，拒绝当作首次安装')
    }
  }
  if (open) fail(rel, '接缝块未闭合（缺 END）：' + open.meta.id)
  return { ast, blocks }
}

/**
 * 现场块 → 作者原文（不依赖任何记录）：replace 取现场 ORIGINAL 区，逐行只去掉本机制加的**一层** `// `。
 * 规则：① insert 块无 ORIGINAL ⇒ 返回 ''；② ORIGINAL 里非空行必须带 `// ` 前缀，缺前缀即拒（半截/被改坏）；
 * ③ 行内原有注释、变量、EOL 原样保留（只剥前缀，不做任何解码/格式化）；
 * ④ BEGIN 带 `tail=none`（结构尾换行标识）时，去掉渲染时人工补的那 1 个 padding LF，其余不动。
 */
export function seamBlockOriginal(source, block) {
  if (typeof source !== 'string' || !block || typeof block !== 'object') throw new Error('seamBlockOriginal：需要 source 与 block')
  const rel = block.metadata?.id ? 'block:' + block.metadata.id : 'block'
  if (block.metadata?.mode === 'insert') return ''
  const region = block.regions?.original
  if (!region) throw new Error(rel + '：replace 块缺少 ORIGINAL 区，拒绝猜原文')
  const text = source.slice(region.beginEnd, region.endStart)
  const lines = text.split('\n')
  const original = lines.map((line, index) => {
    const last = index === lines.length - 1
    if (last && line === '') return line                                  // 末尾空串来自结尾 '\n'，不是内容行
    if (line.startsWith('// ')) return line.slice(3)
    if (/^[ \t\r]*$/.test(line)) return line                              // 纯空白行原样保留
    throw new Error(rel + '：ORIGINAL 行缺少本机制加的 `// ` 前缀，拒绝还原：' + JSON.stringify(line.slice(0, 60)))
  }).join('\n')
  return block.metadata?.tail === 'none' ? original.replace(/\n$/, '') : original
}
