// 官方分叉与子代理均有parentSession；只用精确游戏绑定放行前台，不改亲本身份或提交护栏。
export const MARKER = '// [dsh-tavern-fork-request-transform:v1]'
export const LEGACY_GUARD = '    if (backgroundAgentRunner.owns(sessionId) || payload.agent.session.header?.parentSession) return next()'
// 上游 #204（a390af17）起：原生分叉的游玩会话也带 parentSession，但有本局 chat，
// 作者改为只跳过"有亲本且查不到本局 chat"的会话。我方接缝仍以显式绑定放行，
// 判据比作者更严（还要求 chat.sessionId === sessionId），不是放宽准入。
export const FORK_AWARE_GUARD = '    if (backgroundAgentRunner.owns(sessionId) || (payload.agent.session.header?.parentSession && !await chatForSession(sessionId))) return next()'
export const PLAIN_GUARD = '    if (backgroundAgentRunner.owns(sessionId)) return next()'
export const CHAT_DECL = '    const chat = await chatForSession(sessionId)\n'
const DECISION = "    const decision = await next()\n    if (decision.kind === 'reject') return decision\n"
const ORIGINAL = LEGACY_GUARD + '\n' + DECISION + CHAT_DECL
const FORK_AWARE_ORIGINAL = FORK_AWARE_GUARD + '\n' + DECISION + CHAT_DECL
const BINDING = "    // 官方分叉的亲本不是子代理判据；仅当前会话的明确游戏绑定进入正文准备。\n" +
  '    const parent = payload.agent.session.header?.parentSession\n' +
  "    const bound = !!(chat && typeof chat.id === 'string' && chat.id !== '' && chat.sessionId === sessionId)\n" +
  '    if (parent && !bound) return decision\n'
const APPLIED = '    ' + MARKER + '\n' + PLAIN_GUARD + '\n' + DECISION + CHAT_DECL + BINDING
const count = (source, needle) => source.split(needle).length - 1
export function applyForkRequestTransform(source) {
  if (typeof source !== 'string' || !source) throw Error('分叉请求接缝缺少源码')
  const markers = count(source, MARKER), legacy = count(source, LEGACY_GUARD.trim()), forkAware = count(source, FORK_AWARE_GUARD.trim())
  if (markers) {
    if (markers !== 1 || legacy || forkAware || count(source, APPLIED) !== 1 || count(source, CHAT_DECL) !== 1 || count(source, PLAIN_GUARD) !== 1)
      throw Error('分叉请求接缝标记混合、重复或缺失，拒绝施缝')
    return source
  }
  if (!legacy && !forkAware) {
    if (count(source, PLAIN_GUARD) === 1 && count(source, CHAT_DECL) === 1 && !source.includes('header?.parentSession')) return source
    throw Error('分叉请求守卫锚点缺失或不合法，拒绝施缝')
  }
  if (legacy + forkAware !== 1) throw Error('分叉请求守卫锚点重复，拒绝施缝')
  const original = legacy ? ORIGINAL : FORK_AWARE_ORIGINAL
  if (count(source, original) !== 1 || count(source, CHAT_DECL) !== 1) throw Error('分叉请求锚点缺失/不唯一，拒绝施缝')
  return source.replace(original, () => APPLIED)
}
