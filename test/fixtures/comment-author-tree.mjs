// 阶段③ 集成 fixture：从**真实作者 source 树**有限复制 maintenanceTargets + 作者包身份到独立 mkdtemp。
// 纪律：只复制源码文本（受管目标 + tavern-plugin/package.json），不复制任何真实数据/用户档/vendor/旧作者资产；
// 缺失的可选目标跳过（owned-new 与可选作者文件本就不在裸树里）；cleanup 只删自己 mkdtemp 出来的目录。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maintenanceTargets } from '../../deploy/standard-seams.mjs'
import { parseSeamSource } from '../../deploy/comment-seam-blocks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 已核验的真实作者 source fixture：dsh-tavern-plugin 2.7.0（仓库 flizzywine/dsh-tavern，commit d189da12，
// 即 188 现场实际运行的同一发布提交），lib/index.js 无任何插件接缝标记（2026-10-15 实读）。
// 2026-10-15 从 2.5.0（68215e47）换源：旧 fixture 缺上游计算接入锚点（pageInFront 段），
// 导致「上游计算接入锚点缺失/重复」误报——该锚点是 upstream-compute-transform 的生产接缝点，
// fixture 停在旧版本等于这道闸失效。新 fixture 只复制 maintenanceTargets 覆盖的 53 个文件
// （16 个 storage-*/owned-new 目标作者树本就没有，按既有纪律跳过），SHA256 已对
// dsh-tavern-runtime.json 抽查比对。
const LOCAL_FIXTURE = path.resolve(HERE, '../../../../tmp/release-050-20261015/author-fixture/src/dsh-tavern-d189da122a8651c53ffc55ff465913f2e7f49d75')
const AUTHOR_PACKAGE = 'tavern-plugin/package.json'

/** 显式来源：env DSH_TAVERN_TEST_APP（绝对 app 树）优先，其次本地 author-fixture；都不可用返回 null（让调用方 skip，不假 pass）。 */
export function commentAuthorTreeSource() {
  const raw = typeof process.env.DSH_TAVERN_TEST_APP === 'string' ? process.env.DSH_TAVERN_TEST_APP.trim() : ''
  for (const root of [raw ? path.resolve(raw) : null, LOCAL_FIXTURE]) {
    if (root && existsSync(path.join(root, AUTHOR_PACKAGE))) return root
  }
  return null
}

/** 有限复制真实源码 → 独立 appDir；返回 {appDir, original, cleanup}，original 是复制时的 相对路径 → 源码文本。 */
export function prepareCommentAuthorTree() {
  const from = commentAuthorTreeSource()
  if (!from) return null
  const appDir = mkdtempSync(path.join(os.tmpdir(), 'comment-author-tree-'))
  const original = new Map()
  const copy = rel => {
    const source = path.join(from, rel)
    if (!existsSync(source) || !statSync(source).isFile()) return
    const target = path.join(appDir, rel)
    mkdirSync(path.dirname(target), { recursive: true })
    copyFileSync(source, target)
    original.set(rel, readFileSync(target, 'utf8'))
  }
  copy(AUTHOR_PACKAGE)
  for (const rel of maintenanceTargets) copy(rel)
  return { appDir, original, cleanup: () => rmSync(appDir, { recursive: true, force: true }) }
}

/**
 * 切缝副本 → 只保留**业务实现**：每个接缝块整块换成它的 ACTIVE region，其余字节原样。
 * 用途：把装配后的源码交给 `new Function`/作者模块消费时，ORIGINAL 区是注释掉的作者原文，
 * 整段切片会撞锚点或造成重复声明；这里按 parseSeamSource 的 region 区间拼接（不用 regex、不猜行号）。
 */
export function activeSource(text, rel = 'source.js') {
  const { blocks } = parseSeamSource(text, { rel })
  let out = text, shift = 0
  for (const block of blocks) {
    const active = block.regions.active
    const next = active ? text.slice(active.beginEnd, active.endStart) : ''
    out = out.slice(0, block.start + shift) + next + out.slice(block.end + shift)
    shift += next.length - (block.end - block.start)
  }
  return out
}
