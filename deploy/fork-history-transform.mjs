// 分叉首次publish之前核继承前缀；不改源Chat、不改官方fork或事件日志。
const marker = '// [dsh-tavern-fork-history-markers:v1]'
// 新版上游（42852b0/2.5.0）：fork 调用多一个 lastNativeTurn 成员（index.js:2299，值由 :2298 的 sessionEvents 求末轮得出）。
const original = "    const fork = forkConversationChat(state, { chatId: uid('chat'), sessionId: targetId, id: uid, now: Date.now, lastNativeTurn })"
const legacy = "    const fork = forkConversationChat(state, { chatId: uid('chat'), sessionId: targetId, id: uid, now: Date.now })"
const next = "    " + marker + "\n    const fork = normalizeForkHistoryMarkers(forkConversationChat(state, { chatId: uid('chat'), sessionId: targetId, id: uid, now: Date.now, lastNativeTurn }), sessionEvents(target), atSeq)"
// 旧形态（无 lastNativeTurn）的注入结果：提到 module 级，marker 幂等检查才能同时认两种已应用形态。
const nextLegacy = "    " + marker + "\n    const fork = normalizeForkHistoryMarkers(forkConversationChat(state, { chatId: uid('chat'), sessionId: targetId, id: uid, now: Date.now }), sessionEvents(target), atSeq)"
const imported = "import { normalizeForkHistoryMarkers } from './domain/storage-fork-history.js'\n"
export function applyForkHistoryTransform(source) {
  if (source.includes(marker)) {
    // 幂等分支：已应用形态必须是「新版 XOR 旧版」之一，且 import 精确在位；两者皆无/皆有都判漂移。
    const appliedNew = source.includes(next)
    const appliedLegacy = source.includes(nextLegacy)
    if (appliedNew === appliedLegacy || !source.includes(imported)) throw new Error('分叉历史接缝发生漂移')
    return coldTarget(source)
  }
  if (source.includes('normalizeForkHistoryMarkers')) throw new Error('分叉历史接缝锚点缺失或重复')
  // 双形态严格判定：新版（带 lastNativeTurn）与旧版（不带该成员）各只允许出现一次，命中即用同构替换；两者都不命中/同时命中一律 fail-closed。
  const hasNew = source.split(original).length === 2
  const hasLegacy = source.split(legacy).length === 2
  if (hasNew === hasLegacy) throw new Error('分叉历史接缝锚点缺失或重复')
  if (hasNew) return coldTarget(imported + source.replace(original, next))
  return coldTarget(imported + source.replace(legacy, nextLegacy))
}
function coldTarget(source) {
  const old = '    const target = sessionStore.get(targetId) || agentRegistry.get(targetId)?.session'
  const replacement = `    // [dsh-tavern-fork-cold-target:v1] 仅恢复已冻结目标的只读Session，不resume或创建第二个分叉。
    const target = sessionStore.get(targetId) || agentRegistry.get(targetId)?.session || await ctx.get('sessionPersistence').loadRollbackSession(targetId)`
  if (source.includes('[dsh-tavern-fork-cold-target:v1]')) {
    if (!source.includes(replacement)) throw new Error('分叉冷目标接缝漂移')
    return coldRename(source)
  }
  if (source.split(old).length !== 2) throw new Error('分叉冷目标锚点不唯一')
  return coldRename(source.replace(old, replacement))
}
function coldRename(source) {
  const old = `      const target = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      if (!target || isReadOnlySession(sessionId)) throw new Error('数据库分叉目标会话不可写，未重命名')
      const titleService = ctx.get('sessionTitle')
      if (!titleService || typeof titleService.rename !== 'function') throw new Error('缺少原生会话标题服务')
      const accepted = titleService.rename(target, title)
      await sessionStore.flush(target)
      if (typeof accepted?.title !== 'string' || !accepted.title) throw new Error('宿主未返回接受的标题')
      return accepted.title`
  const replacement = `      // [dsh-tavern-fork-cold-title:v1] 仅临时载入已确认的新目标，命名持久后释放；不生成模型轮。
      if (isReadOnlySession(sessionId)) throw new Error('数据库分叉目标只读，未重命名')
      let target = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      let handle
      if (!target) { handle = await agentRegistry.resume({ resumeSessionId: sessionId }); target = handle.agent.session }
      try {
        if (target.id !== sessionId) throw new Error('分叉命名目标身份变化')
        const titleService = ctx.get('sessionTitle')
        if (!titleService || typeof titleService.rename !== 'function') throw new Error('缺少原生会话标题服务')
        const accepted = titleService.rename(target, title)
        await sessionStore.flush(target)
        if (typeof accepted?.title !== 'string' || !accepted.title) throw new Error('宿主未返回接受的标题')
        return accepted.title
      } finally { if (handle) await handle.dispose() }`
  if (source.includes('[dsh-tavern-fork-cold-title:v1]')) {
    if (!source.includes(replacement)) throw new Error('分叉冷命名接缝漂移')
    return source
  }
  if (source.split(old).length !== 2) throw new Error('分叉冷命名锚点不唯一')
  return source.replace(old, replacement)
}
