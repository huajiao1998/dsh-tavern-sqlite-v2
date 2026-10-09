// 有限源码维护（注释块记录版）：只认显式 target 清单 + 本次块记录；不扫备份目录、不读旧 manifest/旧原像资产、不凭 marker 猜恢复。
// 归属/半装判定一律走**真 lexer**（acorn + parseSeamSource），不用 includes/正则近似：字符串里的伪 marker 不算块，用户注释提及插件名不算接管。
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parse } from '../../lib/vendor/acorn/acorn.mjs'
import { parseSeamSource } from '../comment-seam-blocks.mjs'
import { planSeamUninstall } from '../comment-seam-plan.mjs'
import { readSeamRecord } from '../comment-seam-files.mjs'

export const STANDARD_RECORD = '.tavern-comment-seams.json'
export const SEAM_OWNER = 'dsh-tavern-sqlite-v2'
/** 旧机制记录：新机制只做存在性探测并据此拒绝（要求先用旧版 CLI 卸载），绝不读内容、绝不删除。 */
export const OLD_RECORDS = Object.freeze(['.tavern-standard-seams.json', '.tavern-seams.json', '.tavern-legacy-view-seams.json', '.tavern-save-ui-seam.json'])
export const AUTHOR_PACKAGE_REL = 'tavern-plugin/package.json'
export const ENTRY_REL = 'tavern-plugin/lib/index.js'
const RECORD_KEYS = ['format', 'owner', 'files', 'owned']
const OWNED_MODE = 'owned-new'
// 旧机制真实行注释里出现的前缀（只认"真注释"，不认字符串/模板/正则里的同名文本）。
const OLD_COMMENT_PREFIXES = ['[dsh-tavern-core-host:', '[dsh-tavern-standard-owned:', '[dsh-tavern-v1-storage-host:', '[dsh-tavern-legacy-view-seams:', '[dsh-tavern-save-ui-seam:', '[dsh-tavern-sqlite-v2', '[dsh-tavern-storage-sqlite']
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }) // 严格解码、保 BOM：不用 Buffer.toString 的容错替换
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
function lstatOrNull(target) { try { return lstatSync(target) } catch (error) { if (error && error.code === 'ENOENT') return null; throw error } }
function assertRel(rel, what) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\') || rel.includes(':')) throw new Error(what + '必须是相对 posix 路径：' + rel)
  if (rel.split('/').some(part => !part || part === '.' || part === '..') || path.posix.normalize(rel) !== rel) throw new Error(what + '含空段/./.. 或非规范形式：' + rel)
}
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    const value = node[key]
    if (Array.isArray(value)) for (const item of value) walk(item, visit)
    else if (value && typeof value === 'object') walk(value, visit)
  }
}
export const sameImage = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/**
 * 有限源码访问器：写集＝显式 targets ＋ 块记录 ＋ 作者包身份文件。
 * 所有函数都是**本次现场**语义（捕获/回滚/比对都基于本次 capture），不使用任何历史 before/after。
 */
export function sourceAccess(appDir, targets) {
  if (typeof appDir !== 'string' || !path.isAbsolute(appDir)) throw new Error('源码根必须显式绝对路径（不按 cwd 静默解析）')
  const root = path.resolve(appDir), rootStat = lstatOrNull(root)
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('源码根必须是已存在的真实目录（不接受符号链接）')
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('有限目标清单不能为空')
  for (const rel of targets) { assertRel(rel, '有限目标'); if (!rel.startsWith('tavern-plugin/')) throw new Error('有限目标必须是作者源码路径：' + rel) }
  const fixed = new Set([...targets, STANDARD_RECORD, AUTHOR_PACKAGE_REL])
  const legacy = new Set(OLD_RECORDS)
  function file(rel) {
    assertRel(rel, '源码目标')
    if (!fixed.has(rel) && !legacy.has(rel)) throw new Error('不属于有限源码维护范围：' + rel)
    const resolved = path.resolve(root, rel)
    if (!resolved.startsWith(root + path.sep)) throw new Error('源码路径越界：' + rel)
    // 逐级核到文件系统根：root 自身的 parent 链接同样拒（防 root 被外部链接顶替）。
    for (let p = resolved; ; p = path.dirname(p)) {
      const item = lstatOrNull(p)
      if (item) {
        if (item.isSymbolicLink()) throw new Error('源码目标不接受符号链接：' + p)
        if (p === resolved) { if (!item.isFile()) throw new Error('源码目标不是普通文件：' + rel) }
        else if (!item.isDirectory()) throw new Error('源码祖先不是普通目录：' + rel)
      }
      if (p === path.dirname(p)) break
    }
    return resolved
  }
  const read = rel => { const target = file(rel); return lstatOrNull(target) === null ? null : readFileSync(target) }
  const text = rel => {
    const bytes = read(rel)
    if (bytes === null) return null
    try { return utf8.decode(bytes) } catch { throw new Error('源码不是合法 UTF-8：' + rel) }
  }
  /** 本次写集前像（base64/null）：不枚举目录、不扫备份、不含旧机制记录。 */
  function capture() {
    return Object.fromEntries([...fixed].sort().map(rel => { const bytes = read(rel); return [rel, bytes === null ? null : bytes.toString('base64')] }))
  }
  /**
   * 只回滚本次前像：现场==前像 ⇒ 不动；现场==本次 expected ⇒ 回写；其他（第三方改/部分写）⇒ 记冲突、保留不覆盖。
   * expected 必传才能防"把第三方新内容盖掉"；缺省用于纯本地预演副本。
   */
  function restore(image, { expected = null } = {}) {
    const conflicts = []
    for (const rel of Object.keys(image)) {
      const target = file(rel), bytes = lstatOrNull(target) === null ? null : readFileSync(target)
      const current = bytes === null ? null : bytes.toString('base64')
      if (current === image[rel]) continue
      // 只允许"仍等于本次前像"或"等于本次写入结果"两种现场：任何第三方改动（含被删掉的记录）一律冲突保留，
      // 不在这里猜 runtime disposer——停服撤缝由 runner 的 stopped 投影明证后再以停后现场为基准。
      if (expected && current !== expected[rel]) { conflicts.push(rel); continue }
      if (image[rel] === null) { if (existsSync(target)) unlinkSync(target) }
      else { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, Buffer.from(image[rel], 'base64')) }
      const back = lstatOrNull(target) === null ? null : readFileSync(target).toString('base64') // 回读确认，不凭 write rc0 宣称恢复
      if (back !== image[rel]) conflicts.push(rel)
    }
    if (conflicts.length) throw new Error('恢复遇第三方修改/部分写或回读不符，保留现场不回盖：' + conflicts.join('、'))
  }
  function assertImage(image, { installation = false } = {}) {
    for (const [rel, body] of Object.entries(image)) {
      const target = file(rel)
      // 记录与其他文件一律逐字节比对（installation 只额外要求记录必须在场）：稳定输出下 after 记录应逐字节等于预演 JSON。
      if (body === null) { if (existsSync(target)) throw new Error('源码应不存在：' + rel) }
      else if (!existsSync(target) || !readFileSync(target).equals(Buffer.from(body, 'base64'))) throw new Error((installation && rel === STANDARD_RECORD ? '安装后块记录与本次预期不符：' : '源码与本次前像不符：') + rel)
    }
  }
  /** 块记录：形状/归属判定交给 comment-seam-files.readSeamRecord（不 deep 校验历史 before/after、不存 owned body）；
   *  记录**不扩充**有限 targets；坏/缺记录返回 null 或诊断，不拦"结构可证"的完整块/整文件 owned 块撤缝。 */
  function readRecord() {
    const target = file(STANDARD_RECORD)
    if (lstatOrNull(target) === null) return null
    return readSeamRecord(read(STANDARD_RECORD), SEAM_OWNER)
  }
  const jsonRels = new Set([STANDARD_RECORD, AUTHOR_PACKAGE_REL])
  /**
   * 真 lexer 判定（不用字符串近似）：本插件块 + 旧机制真实行注释 + 指向本包的 import/export 说明符。
   * malformed 标记由 parser 直接抛（不猜、不当首装）；字符串/模板/正则里的伪 marker 与用户注释里的插件名都不算。
   */
  function inspect(rel, given = null) {
    const body = given === null ? text(rel) : given
    if (body === null || !body.includes('dsh-tavern')) return null // 纯加速预筛：无该子串不可能含标记或本包说明符
    const comments = []
    const ast = parse(body, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, onComment: comments })
    const blocks = parseSeamSource(body, { rel }).blocks.filter(block => block.metadata?.owner === SEAM_OWNER)
    // acorn 的 onComment 传数组时推入 {type:'Line'|'Block', value, start, end}：旧真实 marker 只认 type==='Line'。
    const lineComments = comments.filter(comment => comment.type === 'Line' && typeof comment.value === 'string').map(comment => comment.value)
    const legacyComments = lineComments.filter(value => OLD_COMMENT_PREFIXES.some(prefix => value.includes(prefix)))
    const pluginImports = []
    walk(ast, node => {
      if (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportAllDeclaration') return
      const spec = node.source?.value
      if (typeof spec === 'string' && (spec === SEAM_OWNER || spec.startsWith(SEAM_OWNER + '/'))) pluginImports.push(spec)
    })
    return { blocks, legacyComments, lineComments, pluginImports }
  }
  const sourceFiles = () => [...fixed].filter(rel => !jsonRels.has(rel) && rel.endsWith('.js'))
  /** 现场出现**本 owner** 块的文件（真 lexer 判定；他方块不算）。 */
  function blockPresence() { return sourceFiles().filter(rel => (inspect(rel)?.blocks.length ?? 0) > 0) }
  /** 现场出现旧机制真注释前缀或指向本包的 import/export（无记录时的半装/接管探测）。 */
  function takeoverPresence() {
    // 有本 owner 块的文件按**撤缝投影**判旧接管：整文件 owned 块/块内 marker 不算旧（无记录也能证明并撤）。
    return sourceFiles().filter(rel => {
      const found = inspect(rel)
      if (!found) return false
      if (found.blocks.length) {
        const projection = planSeamUninstall(text(rel), { rel, owner: SEAM_OWNER, record: null }).source
        const lexed = inspect(rel, projection) // 只用真 lexer（Line 注释 + AST plugin import）：字符串/模板里的伪 marker 不误拒
        return !!lexed && (lexed.legacyComments.length > 0 || lexed.pluginImports.length > 0)
      }
      return found.legacyComments.length > 0 || found.pluginImports.length > 0
    })
  }
  const oldRecordNames = () => OLD_RECORDS.filter(rel => lstatOrNull(file(rel)) !== null)
  function assertNoOldRecords() {
    const present = oldRecordNames()
    if (present.length) throw new Error('检测到旧机制记录：请先用旧版 CLI 完整卸载后再装块机制版本（' + present.join('、') + '）')
  }
  /** 无新记录、无本 owner 块、无旧标记 ⇒ 干净（可仅装配恢复）。 */
  function cleanState() { return lstatOrNull(file(STANDARD_RECORD)) === null && oldRecordNames().length === 0 && blockPresence().length === 0 && takeoverPresence().length === 0 }
  function assertUninstalled() {
    if (lstatOrNull(file(STANDARD_RECORD)) !== null) throw new Error('卸载后块记录仍在：' + STANDARD_RECORD)
    const blocks = blockPresence()
    if (blocks.length) throw new Error('卸载后仍有本插件块：' + blocks.join('、'))
    const takeover = takeoverPresence()
    if (takeover.length) throw new Error('活动源码仍接管：' + takeover.join('、'))
    return true
  }
  /**
   * 原件保护业务已由主侧纳入 standard transform 的归属区块（禁 startup 初始化/历史），本模块**不再**隐式改写块外源码：
   * 故原 `protect()/protectIfBare()` 已删除（不再导出、不再引用 author-safety）。
   */
  function syntax() {
    const result = spawnSync(process.execPath, ['--check', file(ENTRY_REL)], { stdio: 'inherit', timeout: 8000, windowsHide: true })
    if (result.error || result.status !== 0) throw new Error('作者主入口语法检查拒绝')
  }
  return { root, targets: Object.freeze([...targets]), recordRel: STANDARD_RECORD, file, read, text, capture, restore, assertImage, readRecord, inspect, blockPresence, takeoverPresence, oldRecordNames, assertNoOldRecords, cleanState, assertUninstalled, syntax }
}

/**
 * 记录/旧标记/块归属闸（**现场完整块**为准，不依赖记录里的历史 before/after 或 owned body）：
 * 逐**现场块** parse＋planSeamUninstall(record:null)（半截/破损块、缺端在此抛）；旧接管只看真 lexer（含块时看撤缝投影）；
 * install 侧只做只读 preflight inspect，不因 ready=false 拒（用户改了块外代码/上游覆盖 → needsReapply 仍可按现场重接）。
 */
export function assertPackageSource(access, adapter, { allowRebase = false, operation = 'uninstall' } = {}) {
  // 另一功能线标记只认真实行注释里的字面（inspect 走真 lexer）：字符串常量/普通正文里的同名字样不误拒。
  if (adapter.otherHostMarker) {
    const marker = String(adapter.otherHostMarker)
    const hit = access.targets.filter(rel => rel.endsWith('.js')).find(rel => (access.inspect(rel)?.lineComments ?? []).some(value => value.includes(marker)))
    if (hit) throw new Error('另一功能线接缝不能直接覆盖，请先标准卸载（真实行注释标记：' + hit + '）')
  }
  access.assertNoOldRecords() // 旧机制（≤0.3.7）记录/真 marker：既定例外，仍拒（须旧 CLI 先卸）
  const record = access.readRecord()
  // 可卸性只认**现场完整块**（planUninstall 语义）：有记录缺块、无记录有块都不再拒；半截/破损块由 parser/plan 抛（不猜）。
  const live = access.blockPresence()
  for (const rel of live) {
    const source = access.text(rel)
    if (source === null) continue
    parseSeamSource(source, { rel })
    planSeamUninstall(source, { rel, owner: SEAM_OWNER, record: null }) // record=null 照卸：不依历史 src before/after
  }
  // 现场旧接管判定：直接用真 lexer 的 takeoverPresence（含块时看撤缝投影），不再自算前缀；它同时覆盖"未安装但残留旧真 marker"。
  const stale = access.takeoverPresence()
  if (stale.length) throw new Error('现场/撤缝投影仍含旧接管标记，请先用旧版 CLI 卸载：' + stale.join('、'))
  // 记录里的 owned **不做任何 fs 迭代**：记录不是 owner proof，路径也不可信；owned 仅作 diagnostic 随返回值上报。
  // install 可做只读 preflight inspect，但不得因 ready=false 直接拒（升级致块缺失＝needsReapply）。
  if (operation === 'install' && typeof adapter.inspectStandardSeamsPlan === 'function') adapter.inspectStandardSeamsPlan({ appDir: access.root })
  void allowRebase
  return { record, blocks: live }
}

/**
 * 本次有限副本预演：只复制本次捕获的有限写集到 evidence/rehearsal，在副本上真跑 apply/uninstall + 语法/就绪判定；
 * 不使用任何旧原像资产，也不写真实目标。install 额外固化 `cleaned`＝"按块记录撤缝后"的投影，供停服期间 runtime disposer 撤缝后的现场比对。
 */
export function rehearseSource(action, access, adapter, evidenceDir, checkBudget = () => {}) {
  checkBudget()
  const before = access.capture()
  const copyOf = name => { const dir = path.join(evidenceDir, name); mkdirSync(dir, { recursive: true }); const copy = sourceAccess(dir, adapter.targets); copy.restore(before); return { dir, copy } }
  let result, cleaned = null
  if (action === 'install') {
    const { dir, copy } = copyOf('rehearsal')
    copy.syntax() // 不再在预演里隐式 protect（改块外源码属原件保护业务，将由主纳入有归属区块）
    // 隔离副本里没有目标进程：常量断言表达"副本无进程可停"，不是把异步函数假当真。
    result = adapter.applyStandardSeams({ appDir: dir, allowRebase: true, assertStopped: () => true })
    if (!adapter.checkStandardSeams({ appDir: dir }).ready) throw new Error('本次块预演未 ready（隔离副本）：现场未写入')
    const cleanedRun = copyOf('rehearsal-cleaned')
    adapter.uninstallStandardSeams({ appDir: cleanedRun.dir, assertStopped: () => true })
    cleaned = cleanedRun.copy.capture()
    return { before, expected: copy.capture(), cleaned, result, mode: action, app: dir }
  }
  const { dir, copy } = copyOf('rehearsal')
  result = adapter.uninstallStandardSeams({ appDir: dir, assertStopped: () => true })
  copy.assertUninstalled()
  return { before, expected: copy.capture(), cleaned: null, result, mode: action, app: dir }
}

export function assertSourceUninstalled(access) { return access.assertUninstalled() }
/** 撤缝保留态已取消：只有"当前无块、无新记录、无旧标记"才算干净；旧 marker 一律拒。 */
export function withdrawnCleanState(access) { try { return access.cleanState() } catch { return false } }
