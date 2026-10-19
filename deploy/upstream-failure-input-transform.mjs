// 发送准备期必须先收口上轮错误/未确认完成的发送；清理走统一 latest-send 目标，不按终态或输出形态分类。
// 真实前像、身份/CAS、纯尾和引用护栏仍由 latest-send/cleanRollback 执行端负责；本接缝不软清、不软墓碑、不自动删除用户输入。
const MARKER='// [dsh-tavern-failure-input-guard:v2]'
const INPUT_IMPORT="import { assertSendAfterCleanup } from './domain/storage-failure-state.js'\n"
const LEGACY_INPUT_IMPORT="import { ledgerFailureState as inputFailureState } from './domain/storage-failure-state.js'\n"
const ORIGINAL=`    clearFailedTurns: async function (sessionId) {
      const mode = await turnOrchestrator.modeFor(sessionId)
      if (mode !== 'story' && mode !== 'script') return 0
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      const chat = session && await chatForSession(sessionId)
      if (!chat) return 0
      const availability = rollbackAvailability(chat, { events: sessionEvents(session), nodes: session.surface?.nodes || [] })
      let cleared = 0
      for (const turn of availability.unclearedTurns || []) cleared += clearFailedTurnSurface({ session, turn })
      if (cleared) await sessionStore.flush(session)
      else if (!availability.canRollback && availability.reason && /失败回合/.test(availability.reason)) console.warn('dsh-tavern: 上一次失败回合的残留无法清理，本轮请求可能带上它:', availability.reason)
      return cleared
    },`
const LEGACY_V2_REPLACEMENT=`    clearFailedTurns: async function (sessionId) {
      ${MARKER}
      const mode = await turnOrchestrator.modeFor(sessionId)
      if (mode !== 'story' && mode !== 'script') return 0
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      const chat = session && await chatForSession(sessionId)
      if (!chat) return 0
      const ledger = inputFailureState(chat)
       const activeBody = Object.values(chat.timeline?.operations || {}).some(op => op?.kind === 'body' && op.status === 'running')
       if (ledger?.pendingCleanupTurns?.length || activeBody) throw new Error('上轮错误发送尚未清理：请先执行统一回退或清理，再继续发送')
       if (chat.rollbackPending) throw new Error('物理回退未完成：请先完成或取消本次回退，再继续发送')
       const tail = sessionEvents(session).findLast(event => event?.type === 'turn/end')
       if (tail && tail.data?.reason?.kind && tail.data.reason.kind !== 'completed') throw new Error('上轮错误发送尚未清理：请先执行统一回退或清理，再继续发送')
      return 0
    },`
const REPLACEMENT=`    clearFailedTurns: async function (sessionId) {
      ${MARKER}
      const mode = await turnOrchestrator.modeFor(sessionId)
      if (mode !== 'story' && mode !== 'script') return 0
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      const chat = session && await chatForSession(sessionId)
      if (!chat) return 0
      assertSendAfterCleanup(chat, { events: sessionEvents(session) })
      return 0
    },`
// 旧代（v1）就地升级：统一到同一条先清理守卫；不恢复终态或输出白名单。
const V1_MARKER='// [dsh-tavern-failure-input-guard:v1]'
const V1_REPLACEMENT=`    clearFailedTurns: async function (sessionId) {
      ${V1_MARKER}
      const mode = await turnOrchestrator.modeFor(sessionId)
      if (mode !== 'story' && mode !== 'script') return 0
      const session = sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
      const chat = session && await chatForSession(sessionId)
      if (!chat) return 0
      const ledger = inputFailureState(chat)
      if (chat.rollbackPending || ledger.pendingCleanupTurns.length) throw new Error('上轮失败输入尚未统一物理清理：请先清理或完成回退，再继续发送')
      const events = sessionEvents(session)
      const availability = rollbackAvailability(chat, { events, nodes: session.surface?.nodes || [] })
      if (availability.unclearedTurns?.length) throw new Error('失败输入尚未物理清理：请先统一清理，再继续发送')
      const tail = events.findLast(event => event.type === 'turn/end')
      const body = (chat.messages || []).findLast(message => message.role === 'assistant' && !message.greeting)
      if (['error', 'aborted'].includes(tail?.data?.reason?.kind) && Number(tail.data.turn) > Number(body?.turn || 0)) throw new Error('原生失败尾尚未物理清理：请先统一清理，再继续发送')
      return 0
    },`
// 被遗留的模板输入必须先撤销，再捕获下一轮物理回退基准；沿用作者restore不复制语义。
export function applyTemplateRollbackInputOrderTransform(source) {
 const marker='// [dsh-tavern-template-before-rollback-capture:v1]'
 if(!source.includes('function restoreTemplateInput(chat)'))return source
 if(source.includes(marker))return source
 const capture='    const rollbackBusinessBefore = timeline.captureBusiness ? timeline.captureBusiness(chat) : captureRollbackBusinessState(chat)'
 if(source.split(capture).length!==2)throw Error('模板撤销与业务基准接缝未命中/不唯一')
 return source.replace(capture,`    ${marker}\n    if (chat.promptTemplateInput && chat.promptTemplateInput.turn !== turn) restoreTemplateInput(chat)\n${capture}`)
}
// 供定向测试构造「旧代 v1 产物」与「原始作者源」（形态常量本身即接缝合同的一部分）。
export const FAILURE_INPUT_FORMS = Object.freeze({ MARKER, ORIGINAL, REPLACEMENT, V1_MARKER, V1_REPLACEMENT })
export function applyUpstreamFailureInputTransform(source) {
  // 作者负责失败状态与保留上下文自愈；本包物理删除只经显式统一回退，不自动软隐藏。
  if(source.includes('function repairNativeStory(')) {
    const marker='// [dsh-tavern-native-failure-physical-only:v1]'
    if(source.includes(marker))return source
    for(const name of ['clearFailedTurns','cleanupFailedTurn']) {
      const start=source.indexOf('    '+name+': async function (')
      const end=source.indexOf('\n    },',start)
      if(start<0 || end<start)throw Error('新版失败尾回调接缝未命中：'+name)
      source=source.slice(0,start)+'    '+name+': async function () {\n      '+marker+' '+name+'\n      return 0'+source.slice(end)
    }
    return source
  }
  if(source.includes(LEGACY_V2_REPLACEMENT))source=source.replace(LEGACY_V2_REPLACEMENT,REPLACEMENT)
  if(source.includes(LEGACY_INPUT_IMPORT))source=source.replace(LEGACY_INPUT_IMPORT,INPUT_IMPORT)
 if(source.includes(MARKER)){
  // 只核 clearFailedTurns **本体**：整个源文件里可能仍有其它消费者（导入、注释、别的接缝），不得因此整体拒绝。
  const start=source.indexOf('    clearFailedTurns: async function (sessionId) {')
  const end=start<0?-1:source.indexOf('\n    },',start)
  const region=start>=0&&end>start?source.slice(start,end):''
  if(!region.includes('assertSendAfterCleanup(chat, { events: sessionEvents(session) })') || region.includes('clearFailedTurnSurface') || region.includes('unclearedTurns'))throw Error('失败输入接缝消费者不完整（先清理守卫缺失）')
  return source.includes(INPUT_IMPORT) ? source : INPUT_IMPORT + source
 }
 if(source.includes(V1_MARKER)){
  if(source.split(V1_REPLACEMENT).length!==2)throw Error('失败输入接缝 v1 升级锚点未命中/不唯一')
  const next=source.replace(V1_REPLACEMENT,REPLACEMENT)
   return next.includes(INPUT_IMPORT.trim()) ? next : INPUT_IMPORT + next
 }
 if(!source.includes('    clearFailedTurns: async function (sessionId) {'))return source
 if(source.split(ORIGINAL).length!==2)throw Error('新增失败输入接缝未命中/不唯一')
 const next=source.replace(ORIGINAL,REPLACEMENT)
  return next.includes(INPUT_IMPORT.trim()) ? next : INPUT_IMPORT + next
}
