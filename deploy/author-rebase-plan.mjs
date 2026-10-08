// 只读裸作者投影 planner（A 独立文件；不改 B 现源码/测试）：有限 targets + 标准记录 + 官方 images ⇒ 重施缝"投影计划"。
// 只 import 叶子 author-compatibility.mjs 与 node crypto/fs/path；不 import standard-seams/source/residual（无 cycle）。
// 不写 live、不造第二份安装、不跑 transforms、不碰 SDK/存档；只返回 raw projection dictionary + strict ownership 知识，无 AST/无 lexical 模型。
// 关键判据（2026-10-08 主两轮纠正后）：
//  ① 元数据只认**3 个点号开头的接缝记录 JSON**（`.tavern-*.json`）；作者 manifest `tavern-plugin/package.json` **必须**进完整候选比对（versionOnlyManifest 只放宽 version，exports/deps 等其余键照比）。
//  ② 每个候选官方树都要求：**该树有正文的每个声明作者目标**在投影里 non-null，且**所有 non-null 投影作者正文**都与该树 same（exact 或同契约）⇒ 删掉基线作者文件（投影 null）不可能蒙过；owned 路径官方树全为 null 才允许投影 null。
//  ③ after 命中且该路径在**所有**官方树都无正文（owned/artifact）⇒ 投影 null + 进 ownedCleanup（fresh regeneration；覆盖"新建备份缺 before 键"与"旧备份 before 为非 null 字符串"两情形）。
//     after 命中的**作者**文件仍必须严格解出 before（规范 base64）并过完整共同基线证真；缺 before 键＝dangling 拒，不模拟已知迁移、不扩大。
//  ④ 备份命名白名单＝`<name>.pre-seams-<x>.bak` / `<name>.legacy-view-seams.backup` / `<name>.save-ui*.backup`，限已声明 targets 同目录；文件集合＝targets ∪ after 键 ∪ before 键（回滚输入同受管），不 walk 目录。
//  ⑤ 读取对**祖先与目标**均 lstat nofollow（symlink/junction/非常规即拒）；before 值须规范 base64（回等比），hasKey 显式，null/undefined ⇒ null。
//  ⑥ winner 只提供判定、**不作 copy authority**：投影保当前 raw bytes（裸新作者与 current==before 不回退成 image 旧 bytes）；多棵近树（正文同、仅元数据/版本差异）可同时通过，不要求唯一 commit。
//  ⑦ 语义：compatible＝判定成功；ready＝compatible 且 record.after 全匹配当前；needsReapply＝compatible && !ready；`before` 只要 compatible 就给出（不以 ready 为条件）。
//     authorVersion 取**当前作者 manifest.version**（非 image 版本），供 caller 写记录。
// ══════════════════════════════════════════════════════════════════════════════════
// 接入锚点-only（2026-10-09 用户授权）：**归约只用标准记录真实 before/after，完全不读 catalog/发布清单**。
//   · after 命中且 before 为字节 ⇒ 还原作者前像；before 含我方接缝标记（污染前像）⇒ **拒**；
//   · before 为 null/缺键时**只有明确 owned/artifact 路径**（OWNED_BRIDGE_PATHS + `.tavern-*.json` + 备份命名）
//     才判为插件新建并归零——不得因为"catalog 无此路径"就把作者文件（如 coordinator）当 owned；
//   · owned/artifact 的 after 不匹配当前（局部漂移）⇒ **拒**（不静默保留、不当裸新作者）；
//   · 未命中 after 的作者文件（裸作者更新/未知修改）：保当前字节（不回退旧 before、不覆盖漂移）；
//     uninstall 的漂移保护由调用方按 after 不匹配拒绝（afterMismatch 即其输入）。
// ══════════════════════════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AUTHOR_PACKAGE_NAME, AUTHOR_PACKAGE_REL, insideApp } from './author-compatibility.mjs'

const SEAM_MARKERS = ['[dsh-tavern-standard-owned:v1]', '[dsh-tavern-db-save:v1]', '[dsh-tavern-core-host:v1]']
const BACKUP_RES = [
  /^[\w.-]+\.pre-seams-[\w-]+\.bak$/,
  /^[\w.-]+\.legacy-view-seams\.backup$/,
  /^[\w.-]+\.save-ui[^/]*\.backup$/,
]
const SEAM_RECORD_RE = /(^|\/)\.tavern-[^/]*\.json$/     // 仅接缝记录 JSON 属元数据；作者 manifest 不在此列
const isMetadata = rel => SEAM_RECORD_RE.test(rel)
// 明确 owned/artifact 路径（**不依赖 catalog**）：本包自有垫片 + 接缝记录 + 备份命名。
// 与 residual-uninstall 的 OWNED_BRIDGE_TARGETS 同口径；此处本地声明以免 cycle（residual → 本文件）。
const OWNED_BRIDGE_PATHS = Object.freeze([
  'tavern-plugin/lib/domain/storage-native-data.js',
  'tavern-plugin/lib/domain/chat-sqlite-store.js',
  'tavern-plugin/lib/domain/legacy-view-seams.js',
  'tavern-plugin/lib/domain/storage-opening-runtime.js',
  'tavern-plugin/lib/domain/storage-fork-history.js',
  'tavern-plugin/lib/domain/storage-server-execution.js',
  'tavern-plugin/lib/domain/storage-rollback.js',
  'tavern-plugin/lib/domain/storage-rollback-business.js',
  'tavern-plugin/lib/domain/storage-budgets.js',
  'tavern-plugin/lib/domain/storage-package.js',
  'tavern-plugin/lib/domain/storage-db-save.js',
  'tavern-plugin/lib/domain/storage-current-variables.js',
  'tavern-plugin/lib/domain/storage-compaction-warning.js',
])
const isOwnedOrArtifact = rel => OWNED_BRIDGE_PATHS.includes(rel) || isMetadata(rel)
  || BACKUP_RES.some(re => re.test(path.posix.basename(rel)))

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

function allowedRels(targets) {
  const declared = [...new Set([...targets.map(String), AUTHOR_PACKAGE_REL])]
  const dirs = new Set(declared.map(rel => path.posix.dirname(rel)))
  const isAllowed = rel => {
    const value = String(rel ?? '')
    if (value === '' || value.includes('..') || value.includes('\\') || path.isAbsolute(value)) return false
    if (value.split('/').some(part => part === '' || part === '.')) return false
    if (declared.includes(value)) return true
    const dir = path.posix.dirname(value), base = path.posix.basename(value)
    return dirs.has(dir) && BACKUP_RES.some(re => re.test(base))
  }
  return { declared, isAllowed }
}

function decodeCanonical(value, rel) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value === '') throw new Error(rel + '：记录 before 值非规范 base64（空/非字符串）')
  const buffer = Buffer.from(value, 'base64')
  if (buffer.toString('base64') !== value) throw new Error(rel + '：记录 before base64 非规范，拒绝宽松解码')
  return buffer
}

function assertRecord(record) {
  if (!isObject(record) || record.version !== 1) throw new Error('标准记录 schema 非 1，拒绝作为归约依据')
  if (typeof record.authorVersion !== 'string' || record.authorVersion.trim() === '') throw new Error('标准记录 authorVersion 非法')
  for (const [key, map] of [['after', record.after], ['before', record.before]]) {
    if (!isObject(map) || Object.keys(map).length === 0) throw new Error('标准记录 ' + key + ' 非对象或为空，拒绝')
  }
}

/** 有限读取：祖先必须是普通目录（symlink/junction/非常规即拒），目标必须是普通文件；不存在记 null。 */
function readFinite(appDir, rels, failures) {
  const current = new Map()
  for (const rel of rels) {
    const file = insideApp(appDir, rel)
    const parts = rel.split('/')
    let blocked = null, walk = appDir
    for (let index = 0; index < parts.length - 1; index++) {
      walk = path.join(walk, parts[index])
      let stat = null
      try { stat = lstatSync(walk) } catch { stat = null }
      if (!stat) break
      if (stat.isSymbolicLink() || !stat.isDirectory()) { blocked = '祖先不是普通目录（symlink/junction/非常规）'; break }
    }
    if (blocked) { failures.push(rel + '（' + blocked + '，拒绝读取）'); continue }
    let stat = null
    try { stat = lstatSync(file) } catch { stat = null }
    if (!stat) { current.set(rel, null); continue }
    if (stat.isSymbolicLink() || !stat.isFile()) { failures.push(rel + '（受管目标不是普通文件）'); continue }
    current.set(rel, readFileSync(file))
  }
  return current
}

/**
 * @param {{ appDir:string, targets:string[], record?:object|null, images?:Array<object>|null }} input
 * @returns {{ planOk:boolean, compatible:boolean, ready:boolean, needsReapply:boolean, before:object|null,
 *             projection:object|null, currentImage:{targets:object,record:object|null}, ownedCleanup:string[],
 *             failures:string[], authorVersion:string|null, recordVersion:string|null, matchedCommit:string|null,
 *             matchedCommits:string[], afterMismatch:string[], candidates?:Array<{commit:string,authorVersion:string}> }}
 */
export function planAuthorRebase({ appDir, targets, record = null } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error('重施缝计划缺少声明受管目标清单')
  const failures = []
  const { declared, isAllowed } = allowedRels(targets)
  // 锚点-only：不再加载/扫描 catalog，也不读发布清单——归约只用记录真实 before/after 与明确 owned 清单。
  if (!isObject(record)) {
    return {
      planOk: false, compatible: false, ready: false, needsReapply: true, before: null, projection: null,
      currentImage: { targets: {}, record: null }, ownedCleanup: [],
      failures: failures.concat(['缺少标准记录：首装交隔离预演判定，不在本函数内归约']),
      authorVersion: null, recordVersion: null, matchedCommit: null, matchedCommits: [], afterMismatch: [],
      candidates: [],
    }
  }
  try { assertRecord(record) } catch (error) { failures.push(String(error?.message || error)) }

  const after = isObject(record.after) ? record.after : {}
  const beforeMap = isObject(record.before) ? record.before : {}
  // 文件集合＝targets ∪ after 键 ∪ before 键（before 键是回滚输入、同样可能逃逸受管范围）；不 walk 目录；未知键一律拒。
  const rels = [...new Set([...declared, ...Object.keys(after), ...Object.keys(beforeMap)])]
  for (const rel of rels) if (!isAllowed(rel)) failures.push(rel + '（不在有限 targets/允许备份命名内，拒绝）')
  const current = readFinite(appDir, rels.filter(isAllowed), failures)

  let pkgVersion = null
  const pkgBody = current.get(AUTHOR_PACKAGE_REL)
  if (!pkgBody) failures.push('当前作者 manifest 缺失：' + AUTHOR_PACKAGE_REL)
  else {
    try {
      const parsed = JSON.parse(pkgBody.toString('utf8'))
      if (parsed?.name === AUTHOR_PACKAGE_NAME && typeof parsed.version === 'string' && parsed.version !== '') pkgVersion = parsed.version
      else failures.push('当前作者 manifest 身份非法（name/version）')
    } catch { failures.push('当前作者 manifest 非 JSON') }
  }

  const projection = new Map(), ownedCleanup = [], afterMismatch = []
  for (const [rel, body] of current) {
    const metadata = isMetadata(rel)
    const hasBefore = Object.prototype.hasOwnProperty.call(beforeMap, rel)
    const expectedAfter = typeof after[rel] === 'string' ? after[rel] : null
    if (body === null) { projection.set(rel, null); continue }                       // 当前不存在（含未知 artifact）⇒ 归零
    const cur = sha256(body)
    const afterHit = expectedAfter !== null && cur === expectedAfter
    if (expectedAfter !== null && !afterHit) afterMismatch.push(rel)
    if (afterHit) {
      // ① **owned/artifact 优先归零**：备份（`*.pre-seams-*.bak` 等）／接缝记录／自有垫片即便记录 before 是字符串，
      //    也必须归零——否则重接会把旧的"污染备份"当作者前像保下来（原路径语义）。
      if (isOwnedOrArtifact(rel)) { projection.set(rel, null); ownedCleanup.push(rel); continue }
      // ② 作者文件：记录真实 before 为字节 ⇒ 还原（不再要求 catalog/manifest 证真）
      if (hasBefore && typeof beforeMap[rel] === 'string') {
        let base = null
        try { base = decodeCanonical(beforeMap[rel], rel) } catch (error) { failures.push(String(error?.message || error)); continue }
        // 污染 before：记录前像含我方接缝标记（standard-owned/core-host/db-save）⇒ 绝不回盖（residual 误恢复根因）
        if (SEAM_MARKERS.some(marker => base.toString('utf8').includes(marker))) {
          failures.push(rel + '（记录前像含我方接缝标记＝污染 before，拒绝归约回盖）')
          continue
        }
        projection.set(rel, base)
        continue
      }
      // ③ before 为 null／缺键且非 owned ⇒ 拒绝猜测，不新造豁免
      failures.push(rel + '（after 命中但记录 before ' + (hasBefore ? '为 null' : '缺键') + '，且非 owned/artifact，拒绝猜测归约）')
      continue
    }
    let base = null
    if (hasBefore) {
      try { base = decodeCanonical(beforeMap[rel], rel) } catch (error) { failures.push(String(error?.message || error)); continue }
      // 污染 before 同样拒（即使当前==before，也说明记录被污染，不得作为归约依据）
      if (base !== null && SEAM_MARKERS.some(marker => base.toString('utf8').includes(marker))) {
        failures.push(rel + '（记录前像含我方接缝标记＝污染 before，拒绝归约）')
        continue
      }
    }
    if (base !== null && sha256(base) === cur) { projection.set(rel, body); continue }  // 当前==before ⇒ 保 current bytes
    // owned/artifact 已漂移（after 在记录里但不匹配当前）⇒ 显式拒，不得当"裸新作者"静默保留
    if (expectedAfter !== null && isOwnedOrArtifact(rel)) {
      failures.push(rel + '（owned/artifact 已漂移：记录 after 不匹配当前，拒绝部分归约）')
      continue
    }
    if (!metadata && SEAM_MARKERS.some(marker => body.toString('utf8').includes(marker))) {
      failures.push(rel + '（含我方接缝标记但未命中 after：单文件半施缝/漂移，拒绝）'); continue
    }
    projection.set(rel, body)                                                        // 裸新作者更新/未知修改：保 current bytes，绝不回退成旧 before
  }

  // 锚点-only：不再算 winners/清单 witness（原先会扫描比对全部受管文件）。
  void declared

  const afterKeys = Object.keys(after)
  const allAfterMatch = afterKeys.length > 0 && afterKeys.every(rel => {
    const body = current.get(rel)
    return body !== null && body !== undefined && sha256(body) === after[rel]
  })
  const compatible = failures.length === 0
  const recordVersion = typeof record.authorVersion === 'string' ? record.authorVersion : null
  const beforeOut = {}
  for (const [rel, body] of projection) beforeOut[rel] = body === null ? null : body.toString('base64')

  return {
    planOk: compatible,
    compatible,
    ready: compatible && allAfterMatch,                     // record.after 全匹配当前（锚点-only：不再要求匹配 catalog/manifest）
    needsReapply: compatible && !allAfterMatch,
    before: compatible ? beforeOut : null,                 // raw projection dictionary（作者正文/owned null；不新增 schema；compatible 即给）
    projection: compatible ? beforeOut : null,
    currentImage: { targets: Object.fromEntries([...current].map(([rel, body]) => [rel, body === null ? null : body.toString('base64')])), record },
    ownedCleanup: [...new Set(ownedCleanup)],              // record.after 覆盖且属明确 owned/artifact ⇒ 投影 null
    failures,
    authorVersion: pkgVersion,                             // 当前作者 manifest.version（诊断；非准入条件）
    recordVersion,
    runtimeWitness: null,                                  // 锚点-only：不再读发布清单
    mode: 'record-reduction',                              // 归约来源＝标准记录真实 before/after
    matchedCommit: null,                                   // 不再比对 catalog
    matchedCommits: [],
    afterMismatch,
  }
}
