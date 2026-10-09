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
// 已核验的真实作者 source fixture：dsh-tavern-plugin 2.5.0，lib/index.js 无任何插件接缝标记（2026-10-09 实读）。
const LOCAL_FIXTURE = path.resolve(HERE, '../../../../tmp/release-034-20261008/author-fixture/src/dsh-tavern-68215e47516637e00c75d2b4bba3192679559425')
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
