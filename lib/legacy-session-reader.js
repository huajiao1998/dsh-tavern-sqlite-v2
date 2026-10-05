// 唯一 JSONL 路径：显式原档只读观察。新档/分叉仍只由 SQLite 持久化。
import { statSync } from 'node:fs'
import { decodeJsonlSession, findJsonlArtifact, readJsonlSessionHeader } from '../migrate.js'
import { legacyBindingForSession } from './legacy-bindings.js'

export function legacyArtifactFor(root, id) {
  const binding = legacyBindingForSession(id)
  if (binding) {
    // 不把旧的 header-only id 当成真实来源别名；真实绑定具有真实 header/lineage。
    if (binding.sessionId !== id) return undefined
    return { path: binding.artifactPath, version: 3, compressed: binding.artifactPath.endsWith('.zstd') }
  }
  return findJsonlArtifact(root, id)
}

/** 原档观测身份：revision 与 sizeBytes 只由路径 + 文件身份（size/mtimeNs）决定，与该次是否读正文无关。 */
function legacyIdentity(path) {
  const identity = statSync(path, { bigint: true })
  return { revision: `legacy:${path}:${identity.size}:${identity.mtimeNs}`, sizeBytes: Number(identity.size) }
}

export function readLegacySession(root, id, generationFormat) {
  const artifact = legacyArtifactFor(root, id)
  if (!artifact) return undefined
  const decoded = decodeJsonlSession(artifact.path, artifact.compressed, id, generationFormat)
  return {
    status: 'current', meta: decoded.header, events: decoded.events,
    inheritedEventCount: decoded.inheritedEventCount, eventState: 'detached',
    tornTruncateTo: undefined, recoveredTail: undefined,
    ...legacyIdentity(artifact.path),
  }
}

/**
 * header-only 观测（对齐官方 stat：只读代次 header，不读事件日志）。
 * 只取首行 / 首个 zstd 帧，只构造官方 restore 并取其构造期 header，**不调用 decodeRow/finish**，
 * 因此坏正文帧、torn tail、正文关系问题都不再阻断 stat/list；open/read 仍走 readLegacySession 的
 * 原有官方完整恢复路径（实际 recovery/validation 由运行时 generationFormat 决定，不由本层声明）。
 * 返回不含 eventCount —— 旧代次升级是 one-to-many（迁移会插入/重映射事件），行数 ≠ 事件数，
 * 不假造；revision/sizeBytes 与 readLegacySession 逐字一致（同一 legacyIdentity 来源），
 * 观测→冷读交接的 revision 守卫据此对得上。
 */
export function statLegacySession(root, id, generationFormat) {
  const artifact = legacyArtifactFor(root, id)
  if (!artifact) return undefined
  const { header } = readJsonlSessionHeader(artifact.path, artifact.compressed, id, generationFormat)
  return { status: 'current', meta: header, ...legacyIdentity(artifact.path) }
}

export function createLegacyReadHandle(stored, signal) {
  let closed = false
  signal?.throwIfAborted()
  const refuse = () => { const error = new Error('原生原档句柄只读，必须显式分叉迁移'); error.code = 'DSH_TAVERN_LEGACY_READ_ONLY'; throw error }
  return {
    id: stored.meta.id, header: stored.meta, access: 'read', inheritedEventCount: stored.inheritedEventCount,
    async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options) {
      if (closed) throw new Error('原档只读句柄已关闭')
      options?.signal?.throwIfAborted()
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new TypeError('原档读取范围必须为非负安全整数')
      return { eventState: 'detached', events: stored.events.slice(offset, offset + length) }
    },
    append: refuse, flush: refuse,
    async close() { closed = true },
    async [Symbol.asyncDispose]() { closed = true },
  }
}
