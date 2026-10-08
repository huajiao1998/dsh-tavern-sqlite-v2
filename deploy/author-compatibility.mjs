// 作者兼容判定（共享、纯函数为主；**不 import source/standard-host/standard-seams/residual-uninstall**，避免 cycle 与 TDZ）。
//
// 用户三情况：①版本号变化但接口/数据契约不变（含全新版本首装）；②仅文案/提示词变化；③作者原样重装覆盖接缝。
//
// 安全口径（成对比较、无 AST/includes 推断）：
//   · **唯一可信来源＝既有官方有限 tree**（author-clean-images，摘要门禁）；必须**单一共同 tree** 覆盖全部作者目标；
//   · presentation 只放行“基线已批准的**字面量本体**”：先在基线上定位批准 span（字面量 ∈ 批准清单、所在调用结构完整），
//     再在候选里按**相同结构锚点**（调用前缀 + 字面量闭合后的**逐字节相同**后缀，含 `+ expr` 拼接与 `)`）定位对应 span；
//     两侧除这些 span 外必须逐字节相同 ⇒ **拼接结构、插值 `${}`、键名、SQL、错误名、锚点等变化一律暴露为差异**；
//   · 结构锚点必须唯一命中；找不到/数量不为 1 ⇒ 拒；
//   · `lib/index.js` 先做既有 startup guard 归一（属“守卫归一”，**不计入 presentation**）；
//   · 目标路径必须落在 appDir 内；只读；不联网、不读存档、不写盘。
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import path from 'node:path'
import { protectAuthorStartup } from './maintenance/author-safety.mjs'

export const AUTHOR_IMAGES_SHA256 = '72a7b3d92c17594579bc0efbdb1ba6ca3b1bdd2053939825a4b982f353b3854b'
export const DEFAULT_IMAGES_URL = new URL('./maintenance/author-clean-images.json.gz', import.meta.url)
export const AUTHOR_PACKAGE_NAME = 'dsh-tavern-plugin'
export const AUTHOR_PACKAGE_REL = 'tavern-plugin/package.json'

/** 批准的 presentation 上下文（2 个代表）：只允许基线批准字面量的**本体**在同一结构槽位改文案。 */
export const PRESENTATION_CONTEXTS = Object.freeze({
  'tavern-plugin/lib/background-agent-task.js': Object.freeze({
    kind: 'call-arg',
    call: 'sections.push(',
    literals: Object.freeze(['【本轮权威状态】\\n', '【最近剧情与本次任务】\\n任务类型：', '【任务要求】\\n', '【人物卡历史后指令】\\n', '联系人', '你', '正文', '用户', '世界书筛选', '场景生图']),
  }),
  'tavern-plugin/lib/client.js': Object.freeze({
    kind: 'unique-label',
    literals: Object.freeze(['导入聊天记录', '导入 SillyTavern 聊天记录']),
  }),
})

const QUOTES = new Set(["'", '"', '`'])
const ANCHOR = 48

/** 目标路径必须落在 appDir 内（与 standard-seams inside() 同口径）。 */
export function insideApp(appDir, rel) {
  const base = path.resolve(appDir), target = path.resolve(base, rel)
  if (!target.startsWith(base + path.sep)) throw new Error('兼容判定路径越界：' + rel)
  return target
}

export function normalizeAuthorFile(text, rel) {
  if (rel !== 'tavern-plugin/lib/index.js') return text
  // 只读归一：已缝合/受保护异常时**原样返回**（污染拒绝属卸载写前判定，不在此处猜恢复）。
  try { return protectAuthorStartup(text) } catch { return text }
}

/** 从 opening quote 起定位字面量本体；插值/未闭合/真换行 ⇒ null。 */
function literalSpanAt(text, quoteIndex) {
  const quote = text[quoteIndex]
  if (!QUOTES.has(quote || '')) return null
  let i = quoteIndex + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === quote) break
    if (ch === '\n') return null
    i++
  }
  if (i >= text.length) return null
  const body = text.slice(quoteIndex + 1, i)
  if (body.includes('${')) return null
  return { start: quoteIndex + 1, end: i, quote }
}

/** 从调用起始处找到与首层配对的 `)`（跳过字符串与嵌套括号），返回其下标。 */
function callCloseIndex(text, callStart) {
  let depth = 0, i = callStart
  while (i < text.length) {
    const ch = text[i]
    if (QUOTES.has(ch)) {
      const span = literalSpanAt(text, i)
      if (!span) return -1
      i = span.end + 1
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) return i }
    i++
  }
  return -1
}

/** 基线上的批准 span：call-arg（字面量 ∈ 批准清单；后缀＝闭合引号到配对 `)` 的逐字节内容，含 `+ expr`）；unique-label（全文件唯一）。 */
export function approvedSpans(baselineText, spec) {
  const spans = []
  if (spec.kind === 'call-arg') {
    let from = 0
    while (true) {
      const at = baselineText.indexOf(spec.call, from)
      if (at === -1) break
      const quoteIndex = at + spec.call.length
      const span = literalSpanAt(baselineText, quoteIndex)
      if (!span) { from = quoteIndex + 1; continue }
      const body = baselineText.slice(span.start, span.end)
      const close = callCloseIndex(baselineText, at)
      if (close > span.end && spec.literals.includes(body)) {
        spans.push({ start: span.start, end: span.end, left: spec.call, right: baselineText.slice(span.end + 1, close + 1) })
      }
      from = span.end + 1
    }
    return spans
  }
  if (spec.kind === 'unique-label') {
    for (const literal of spec.literals) {
      const positions = []
      let at = baselineText.indexOf(literal)
      while (at !== -1) { positions.push(at); at = baselineText.indexOf(literal, at + 1) }
      if (positions.length !== 1) continue
      const quoteIndex = positions[0] - 1
      const span = literalSpanAt(baselineText, quoteIndex)
      if (!span) continue
      spans.push({ start: span.start, end: span.end, left: baselineText.slice(Math.max(0, quoteIndex - ANCHOR), quoteIndex), right: baselineText.slice(span.end + 1, span.end + 1 + ANCHOR) })
    }
    return spans
  }
  return spans
}

/** 候选里按相同结构锚点定位对应 span（必须唯一命中，且后缀逐字节相同）。 */
function counterpartSpans(candidateText, spans) {
  const found = []
  for (const span of spans) {
    const hits = []
    let from = 0
    while (true) {
      const at = candidateText.indexOf(span.left, from)
      if (at === -1) break
      const quoteIndex = at + span.left.length
      const body = literalSpanAt(candidateText, quoteIndex)
      if (body) {
        const tail = candidateText.slice(body.end + 1, body.end + 1 + span.right.length)
        if (tail === span.right) hits.push(body)
      }
      from = at + 1
    }
    if (hits.length !== 1) return null
    found.push(hits[0])
  }
  return found
}

const maskAll = (text, spans) => {
  let out = text
  for (const span of [...spans].sort((a, b) => b.start - a.start)) out = out.slice(0, span.start) + '\u0000' + out.slice(span.end)
  return out
}

/** 成对契约比较：`{ same, presentation }`（守卫归一差异不算 presentation）。 */
export function compareAuthorContract(currentText, baselineText, rel) {
  const cur = normalizeAuthorFile(currentText, rel)
  const base = normalizeAuthorFile(baselineText, rel)
  if (cur === base) return { same: true, presentation: false }
  const spec = PRESENTATION_CONTEXTS[rel]
  if (!spec) return { same: false, presentation: false }
  const spans = approvedSpans(base, spec)
  if (spans.length === 0) return { same: false, presentation: false }
  const counterparts = counterpartSpans(cur, spans)
  if (!counterparts) return { same: false, presentation: false }
  const valueChanged = spans.some((span, index) => base.slice(span.start, span.end) !== cur.slice(counterparts[index].start, counterparts[index].end))
  if (maskAll(base, spans) !== maskAll(cur, counterparts)) return { same: false, presentation: false }
  return { same: true, presentation: valueChanged }
}

/** package.json：只允许 version 变（其余键深比相等）。 */
export function versionOnlyManifest(currentJson, baselineJson) {
  if (!currentJson || !baselineJson || typeof currentJson !== 'object' || typeof baselineJson !== 'object') return false
  const strip = value => {
    const copy = { ...value }
    delete copy.version
    return JSON.stringify(Object.keys(copy).sort().map(key => [key, copy[key]]))
  }
  return strip(currentJson) === strip(baselineJson)
}

export function loadAuthorImages({ file = DEFAULT_IMAGES_URL, sha256 = AUTHOR_IMAGES_SHA256 } = {}) {
  const bytes = readFileSync(file)
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('有限官方恢复资产摘要不符，拒绝用作兼容基线')
  const catalog = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'))
  if (catalog.version !== 1 || catalog.package !== 'dsh-tavern-sqlite-v2' || !Array.isArray(catalog.trees) || !catalog.trees.length) {
    throw new Error('有限官方恢复资产身份不符')
  }
  return catalog
}

export function authorImages(catalog) {
  return catalog.trees.map(tree => ({
    commit: tree.commit,
    authorVersion: tree.authorVersion,
    files: Object.fromEntries(Object.entries(tree.files).map(([rel, entry]) => [rel, entry && entry.body ? Buffer.from(entry.body, 'base64') : null])),
  }))
}

const asText = buffer => (buffer === null || buffer === undefined ? null : buffer.toString('utf8'))

/**
 * **唯一** optional 受管目标：0.3.4 新增的 `domain/game-footprint.js`。旧官方 tree 没有该文件，
 * 因此允许“当前缺 + 正在比对的这棵 image 也缺（null/undefined）”在 perImage 跳过；其余组合照旧失败，
 * 绝不跨 image 拼字节，也不放宽任何其它文件。
 */
export const OPTIONAL_IMAGE_TARGETS = Object.freeze(['tavern-plugin/lib/domain/game-footprint.js'])

/**
 * 主判定：**唯一可信来源＝既有官方 tree**；要求单一共同 tree 覆盖全部作者目标。
 * @returns {{ ok: boolean, mode: 'identical'|'presentation'|null, matchedCommit: string|null, skippedOwned: string[], failures: string[] }}
 */
export function classifyAuthorCompatibility({ appDir, targets, images } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('兼容判定缺少声明受管目标清单')
  if (!Array.isArray(images) || images.length === 0) throw new Error('兼容判定缺少可信官方基线（仅接受既有 tree）')

  // 作者 manifest **一律并入**（standard TARGETS 不含 package.json；调用方无需记得拼，避免漏判导致新版恒拒）。
  const declared = [...new Set([...targets, AUTHOR_PACKAGE_REL])]
  // 唯一 optional 作者路径**永不当 owned**：即使传入的 images 全缺该键（受限投影/mock），它仍必须留在 authorTargets，
  // 由 perImage「current 缺 ∧ 该 image 也缺」才跳过；current 有而 base 缺一律 refuse。
  const isOwned = rel => !OPTIONAL_IMAGE_TARGETS.includes(rel) && images.every(image => !image.files[rel])
  const authorTargets = declared.filter(rel => !isOwned(rel))
  const skippedOwned = declared.filter(isOwned)
  if (authorTargets.length === 0) throw new Error('兼容判定没有作者目标（全部为 owned/artifact）')

  const current = {}, failures = []
  for (const rel of authorTargets) {
    const file = insideApp(appDir, rel)
    if (!existsSync(file)) {
      // optional 目标当前缺失：记 null（不在收集期直接全局失败），由 perImage 判“双缺才跳过”。
      if (OPTIONAL_IMAGE_TARGETS.includes(rel)) { current[rel] = null; continue }
      failures.push(rel + '（当前树缺该受管文件）'); continue
    }
    current[rel] = readFileSync(file)
  }

  const perImage = []
  for (const image of images) {
    const missing = [], mismatched = []
    let presentation = false
    for (const rel of authorTargets) {
      const now = current[rel]
      const base = image.files[rel]
      // 唯一 optional：current 与**正在比对的这棵 image** 同时缺该项才跳过；其余组合照旧失败。
      if (OPTIONAL_IMAGE_TARGETS.includes(rel) && (now === undefined || now === null) && (base === null || base === undefined)) continue
      if (now === undefined || now === null) { missing.push(rel + '（当前树缺该受管文件）'); continue }
      if (!base) { missing.push(rel + '(该 tree 无此项)'); continue }
      if (base.equals(now)) continue
      if (rel === AUTHOR_PACKAGE_REL) continue
      const verdict = compareAuthorContract(asText(now), asText(base), rel)
      if (verdict.same) { if (verdict.presentation) presentation = true; continue }
      mismatched.push(rel)
    }
    const manifest = current[AUTHOR_PACKAGE_REL]
    let manifestOk = false
    if (manifest) {
      const base = image.files[AUTHOR_PACKAGE_REL]
      if (base) {
        if (base.equals(manifest)) manifestOk = true
        else {
          try {
            const nowJson = JSON.parse(manifest.toString('utf8'))
            manifestOk = nowJson.name === AUTHOR_PACKAGE_NAME && versionOnlyManifest(nowJson, JSON.parse(base.toString('utf8')))
          } catch { manifestOk = false }
        }
      }
    }
    perImage.push({ image, missing, mismatched, presentation, manifestOk })
  }

  const winner = perImage.find(entry => entry.manifestOk && entry.missing.length === 0 && entry.mismatched.length === 0)
  if (winner) return { ok: true, mode: winner.presentation ? 'presentation' : 'identical', matchedCommit: winner.image.commit, skippedOwned, failures: [] }

  const best = perImage.slice().sort((a, b) => (a.missing.length + a.mismatched.length) - (b.missing.length + b.mismatched.length))[0]
  const detail = []
  if (best) {
    if (!best.manifestOk) detail.push(AUTHOR_PACKAGE_REL + '（除 version 外还有其它变化，或与同一 tree 不匹配）')
    detail.push(...best.missing, ...best.mismatched.map(rel => rel + '（与同一 tree 既非逐字节相同、也非批准槽位文案差异）'))
  }
  return { ok: false, mode: null, matchedCommit: null, skippedOwned, failures: [...new Set([...failures, ...detail])] }
}
