// 阶段③ 集成 fixture：从**真实作者 source 树**复制受管接缝目标 + 作者包身份到独立 mkdtemp。
// 纪律：只复制源码文本（受管目标 + tavern-plugin/package.json），不复制任何真实数据/用户档/vendor/旧作者资产；
// 缺失的可选目标跳过（owned-new 与可选作者文件本就不在裸树里）；cleanup 只删自己 mkdtemp 出来的目录。
// 注意：本 fixture 背后的本地源是**全量作者源码树**（937 文件）。有测试会直接 import 作者的依赖模块
// （如 copy-json-tree.js），把本地源裁成"仅受管目标"会让那些测试 loader 失败（2026-10-16 实测），
// 因此维护本地源时必须保持全量，不能只同步受管文件。
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maintenanceTargets } from '../../deploy/standard-seams.mjs'
import { parseSeamSource } from '../../deploy/comment-seam-blocks.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 已核验的真实作者 source fixture：dsh-tavern-plugin 2.7.0（仓库 flizzywine/dsh-tavern，commit a390af17，
// 含上游 #203/#204/#205；lib/index.js 无任何插件接缝标记，2026-10-16 实读）。
// 2026-10-16 从 d189da12 换源：上游 #204 改了 request.js 的 pre-step 守卫（原生分叉也带 parentSession，
// 作者改为只跳过"有亲本且查不到本局 chat"的会话），fixture 停在旧版等于 fork-request 接缝的新守卫路径无回归覆盖。
// 该 fixture 是**全量作者源码树**（937 个文件）：不少测试直接 import 作者的依赖模块
// （如 copy-json-tree.js），只挑受管目标会让它们 loader 失败，故不做"仅 maintenanceTargets"裁剪。
const LOCAL_FIXTURE = path.resolve(HERE, '../../../../tmp/upstream-a390af17-adapt-20261016/author-fixture/src/dsh-tavern-a390af170cfe5ed3e9213a2801cbcce321e2008b')
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
