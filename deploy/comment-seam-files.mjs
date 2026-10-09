// 注释接缝块与owned-new·有限写集实施（同步）：停态断言 → 读 snapshot → 纯 core 计划 → checkReady 一次 → 写前全部计划零写比对 →
// 逐文件比对后立即写 → 记录后写 → 全 plan 回读 → 写后再断言；失败只回滚“本次写过且现场仍等于本次 after”的目标并回读确认，
// 第三方/部分写保留现场并附 recovery 依据。不做原子承诺；不新增锁/staging/扫描器/logger/hook，不改共享模块；fs 以对象形态调用（测试可用 mock.method 注入写失败，产品侧无开关）。
import fs from 'node:fs'
import path from 'node:path'
import { planSeamInstall, planSeamUninstall } from './comment-seam-plan.mjs'
import { parseSeamSource } from './comment-seam-blocks.mjs'

export const COMMENT_SEAMS_RECORD = '.tavern-comment-seams.json'
// 记录仅是可选归属摘要；源码装卸始终以现场区块为准，不读取历史片段。
export function readSeamRecord(bytes, owner) {
  if (bytes === null) return null
  let record
  try { record = JSON.parse(decoder.decode(bytes)) } catch { return null }
  if (!plain(record) || record.format !== 1 || record.owner !== owner || !plain(record.files) || !plain(record.owned)) return null
  return record
}
export function ownedFileBlock(source, { rel, owner }) {
  if (source === null) return null
  return parseSeamSource(source, { rel }).blocks.find(b => b.metadata.owner === owner && b.metadata.id === 'owned-file' && b.metadata.mode === 'insert') ?? null
}
export function wrapOwnedFile(body, { rel, owner }) {
  if (typeof body !== 'string' || !body.trim()) throw Error('注释接缝：新建桥文件缺插件实现：' + rel)
  parseSeamSource(body, { rel })
  if (body.includes('[dsh-tavern-seam:')) throw Error('注释接缝：新建桥文件实现不能嵌套区块：' + rel)
  return '// [dsh-tavern-seam:BEGIN] format=1 revision=1 owner=' + owner + ' id=owned-file mode=insert purpose="插件桥接文件"\n'
    + '// [dsh-tavern-seam:ACTIVE_BEGIN]\n' + body + (body.endsWith('\n') ? '' : '\n')
    + '// [dsh-tavern-seam:ACTIVE_END]\n// [dsh-tavern-seam:END] format=1 owner=' + owner + ' id=owned-file\n'
}
// UTF-8 严格解码：非法字节直接拒；ignoreBOM 保留 BOM（不 strip），EOL 一律不归一。
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function utf8(bytes, rel, what = '文件') {
  try { return decoder.decode(bytes) } catch { throw Error('注释接缝：' + what + '不是合法 UTF-8：' + rel) }
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const sameBytes = (left, right) => (left === null || right === null ? left === right : left.equals(right))
// lstat + 仅 ENOENT 算缺失：悬空链接必须被识别为链接，不能用 existsSync 当“不存在”。
function lstatOrNull(target) {
  try { return fs.lstatSync(target) } catch (error) { if (error && error.code === 'ENOENT') return null; throw error }
}
function resolvePath(root, rel, what) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\')) throw Error('注释接缝：' + what + '必须是相对 posix 路径：' + rel)
  if (rel.includes(':')) throw Error('注释接缝：' + what + '不得含盘符/ADS 冒号：' + rel)
  if (rel.split('/').some(part => !part || part === '.' || part === '..') || path.posix.normalize(rel) !== rel) throw Error('注释接缝：' + what + '含空段/./.. 或非规范形式：' + rel)
  const file = path.resolve(root, rel)
  if (!file.startsWith(root + path.sep)) throw Error('注释接缝：' + what + '越出 root：' + rel)
  // 逐级到文件系统根（含 root 的 parent）：任何一级是链接即拒。
  for (let p = file; ; p = path.dirname(p)) {
    const stat = lstatOrNull(p)
    if (stat) {
      if (stat.isSymbolicLink()) throw Error('注释接缝：' + what + '路径含符号链接：' + rel)
      if (p === file) { if (!stat.isFile()) throw Error('注释接缝：' + what + '不是普通文件：' + rel) }
      else if (!stat.isDirectory()) throw Error('注释接缝：' + what + '祖先不是普通目录：' + rel)
    }
    if (p === path.dirname(p)) break
  }
  return file
}
function readAt(file) { return lstatOrNull(file) === null ? null : fs.readFileSync(file) }
function readText(file, rel) { const bytes = readAt(file); return bytes === null ? null : utf8(bytes, rel) }

// 显式有限 targets（[{rel, descriptors}]）装卸：全部计划先算完，checkReady({files, record}) 必须严格返回 true 才写；
// uninstall 按现场区块幂等，记录缺失/损坏不阻完整区块撤除；新文件也以 insert 区块自描述。
export function applyCommentSeams({ appDir, owner, targets, operation = 'install', recordRel = COMMENT_SEAMS_RECORD, assertStopped, checkReady } = {}) {
  if (typeof appDir !== 'string' || !appDir || !path.isAbsolute(appDir)) throw Error('注释接缝：appDir 必须是绝对路径（不按 cwd 静默解析）')
  const root = path.resolve(appDir), rootStat = lstatOrNull(root)
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('注释接缝：appDir 必须是已存在的真实目录（不接受符号链接）')
  if (typeof owner !== 'string' || !owner.trim()) throw Error('注释接缝：owner 必须是非空字符串')
  if (operation !== 'install' && operation !== 'uninstall') throw Error('注释接缝：operation 仅支持 install/uninstall')
  if (typeof assertStopped !== 'function') throw Error('注释接缝：assertStopped 必须是函数（不做默认放行）')
  if (typeof checkReady !== 'function') throw Error('注释接缝：checkReady 必须是函数（不允许无验证写入）')
  if (!Array.isArray(targets) || targets.length === 0) throw Error('注释接缝：targets 必须是非空显式清单')
  const stop = when => { if (assertStopped() !== true) throw Error('注释接缝：assertStopped(' + when + ') 未严格返回 true，拒绝写入') }
  stop('操作开始') // 读现场之前：undefined/false 一律不放行
  const plan = targets.map(target => {
    if (!target || typeof target !== 'object' || target.descriptors == null) throw Error('注释接缝：target 必须是 {rel, descriptors}')
    return { rel: target.rel, descriptors: target.descriptors, ownedBody: target.ownedBody, file: resolvePath(root, target.rel, 'target'), before: null, after: null, changed: false, record: null, ownedRecord: null }
  })
  if (new Set(plan.map(item => item.rel)).size !== plan.length) throw Error('注释接缝：targets 内 rel 重复')

  const recordFile = resolvePath(root, recordRel, 'recordRel')
  if (plan.some(item => item.file === recordFile)) throw Error('注释接缝：记录路径不能同时是 target')
  const recordBytes = readAt(recordFile)
  // 旧摘要里的文件集合/片段不控制施工范围，targets 显式声明范围，现场区块证明归属。

  for (const item of plan) {
    item.before = readText(item.file, item.rel)
    const bridge = ownedFileBlock(item.before, { rel: item.rel, owner })
    if (bridge || item.ownedBody !== undefined) {
      if (operation === 'install' && item.ownedBody !== undefined) {
        const body = wrapOwnedFile(item.ownedBody, { rel: item.rel, owner })
        if (item.before !== null && !bridge) throw Error('注释接缝：作者同名文件存在，不能冒认新建桥：' + item.rel)
        item.after = bridge ? item.before.slice(0, bridge.start) + body + item.before.slice(bridge.end) : body
        parseSeamSource(item.after, { rel: item.rel })
        item.ownedRecord = { format: 1, owner, rel: item.rel, mode: 'owned-new' }
      } else {
        const result = item.before === null ? null : planSeamUninstall(item.before, { rel: item.rel, owner })
        item.after = result?.source || null // 空桥删文件；块外用户追加仍保留。
      }
      item.changed = item.after !== item.before
      continue
    }
    if (item.before === null) {
      if (operation === 'install' && item.descriptors.length) throw Error('注释接缝：必需接缝文件不存在：' + item.rel)
      continue
    }
    const result = operation === 'install' && item.descriptors.length
      ? planSeamInstall(item.before, { rel: item.rel, owner, descriptors: item.descriptors })
      : planSeamUninstall(item.before, { rel: item.rel, owner })
    if (!result || typeof result.source !== 'string') throw Error('注释接缝：core 计划未返回 source：' + item.rel)
    if (result.record != null && (!plain(result.record) || result.record.format !== 1 || result.record.rel !== item.rel || result.record.owner !== owner)) throw Error('注释接缝：core 计划记录身份不符：' + item.rel)
    item.after = result.source
    item.record = result.record ?? null
    item.changed = result.changed === true || item.after !== item.before
  }

  const files = Object.create(null) // 无原型：__proto__ 之类的 rel 只能成为 own key，不污染原型
  for (const item of plan) {
    const next = item.record
    if (next && (!Array.isArray(next.blocks) || next.blocks.length > 0)) files[item.rel] = next
  }
  const nextOwned = Object.create(null)
  for (const item of plan) if (item.ownedRecord) nextOwned[item.rel]=item.ownedRecord
  const nextRecord = Object.keys(files).length+Object.keys(nextOwned).length ? { format: 1, owner, files, owned:nextOwned } : null
  const nextRecordText = nextRecord ? JSON.stringify(nextRecord, null, 2) + '\n' : null
  const writes = plan.filter(item => item.changed)
  if (writes.length === 0 && sameBytes(recordBytes, nextRecordText === null ? null : Buffer.from(nextRecordText, 'utf8'))) return { changed: false, operation, owner, recordRel, written: [], recordRemoved: false, record: nextRecord }
  // checkReady 只调一次，且覆盖全部已存在 target 的计划后像（不只本次要写的那些）。
  if (checkReady({ files: new Map(plan.filter(item => item.after !== null).map(item => [item.rel, item.after])), record: nextRecord }) !== true) throw Error('注释接缝：checkReady 未严格返回 true，零写入')
  stop('写前')
  // 写前一轮零写复核：全部 plan（含 unchanged）与记录一起比对，任何漂移即拒、零写入。
  for (const item of plan) { item.file = resolvePath(root, item.rel, 'target'); if (readText(item.file, item.rel) !== item.before) throw Error('注释接缝：写前现场被外部修改，拒绝覆盖：' + item.rel) }
  if (!sameBytes(readAt(recordFile), recordBytes)) throw Error('注释接缝：写前记录被外部修改，拒绝覆盖')

  const written = []
  let recordWritten = false
  try {
    for (const item of writes) {
      const file = resolvePath(root, item.rel, 'target') // ready 回调可能换过目录/链接：每次写前重闸
      item.file = file
      if (readText(file, item.rel) !== item.before) throw Error('注释接缝：写前现场被外部修改，拒绝覆盖：' + item.rel)
      written.push(item) // 先登记后写：部分写后抛也能识别
      if (item.after===null) fs.unlinkSync(file)
      else { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file, item.after, 'utf8') }
    }
    const target = resolvePath(root, recordRel, 'recordRel')
    if (!sameBytes(readAt(target), recordBytes)) throw Error('注释接缝：写前记录被外部修改，拒绝覆盖')
    recordWritten = true // 同上：先标记后写
    if (nextRecordText === null) { if (lstatOrNull(target)) fs.unlinkSync(target) } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, nextRecordText, 'utf8') }
    // 写后复核全部 plan（含未写的幂等文件与被跳过的缺失目标），防第三方漂移漏检。
    for (const item of plan) { item.file = resolvePath(root, item.rel, 'target'); const current = readText(item.file, item.rel); if (item.after === null ? current !== null : current !== item.after) throw Error('注释接缝：回读与本插件 after 不一致：' + item.rel) }
    if (!sameBytes(readAt(target), nextRecordText === null ? null : Buffer.from(nextRecordText, 'utf8'))) throw Error('注释接缝：记录回读不一致：' + recordRel)
    stop('写后')
  } catch (error) {
    const conflicts = []
    for (const item of [...written].reverse()) { // 倒序 + 重闸：绝不顺着第三方链接恢复
      try {
        const file = resolvePath(root, item.rel, 'target')
        const current = readText(file, item.rel)
        if (current === item.before) continue // 已是写前字节：无需恢复
        if (current !== item.after) { conflicts.push(item.rel); continue } // 部分写/第三方：保留，不声称全回滚
        if (item.before === null) fs.unlinkSync(file)
        else fs.writeFileSync(file, item.before, 'utf8')
        if (readText(file, item.rel) !== item.before) conflicts.push(item.rel) // 回读确认：不凭 write rc0 宣称回滚
      } catch { conflicts.push(item.rel) }
    }
    if (recordWritten) {
      try {
        const file = resolvePath(root, recordRel, 'recordRel')
        const current = readAt(file)
        if (!sameBytes(current, recordBytes)) {
          const ours = nextRecordText === null ? current === null : (current !== null && current.toString('utf8') === nextRecordText)
          if (!ours) conflicts.push(recordRel)
          else if (recordBytes === null) { fs.unlinkSync(file); if (lstatOrNull(file)) conflicts.push(recordRel) }
          else { fs.writeFileSync(file, recordBytes); if (!sameBytes(readAt(file), recordBytes)) conflicts.push(recordRel) }
        }
      } catch { conflicts.push(recordRel) }
    }
    const named = [...new Set(conflicts)]
    const failure = new Error('注释接缝：本次写入失败，' + (named.length ? '回滚遇并发修改/部分写，保留现场不覆盖：' + named.join('、') : '已按本次有限写集回滚并回读确认') + '；初因：' + (error && error.message ? error.message : error), { cause: error })
    failure.recovery = { files: written.map(item => ({ rel: item.rel, before: item.before, after: item.after })), recordBefore: recordBytes ? recordBytes.toString('base64') : null, recordAfter: nextRecordText }
    throw failure
  }
  return { changed: true, operation, owner, recordRel, written: written.map(item => item.rel), recordRemoved: nextRecordText === null, record: nextRecord }
}
