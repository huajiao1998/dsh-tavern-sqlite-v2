// 替换作者rollbackChat全体为包拥有的唯一编排，升级旧v1后不保留失败软清/undo/script删除副作用。
import { applyRegenerationRollbackTransform } from './regeneration-rollback-transform.mjs'
const MARKER='// [dsh-tavern-clean-rollback:v1]'
const START='  async function rollbackChat(chat, requestedTurn, restoredAgent) {'
const END='  async function undoRollback(sessionId, chatId) {'
const BODY=`${START}
    ${MARKER}
    const mode = chat.mode || 'story'
    if (mode !== 'story' && mode !== 'script') throw new Error('仅游玩模式支持回退本轮')
    void restoredAgent
    // 客户端握手只影响显示同步，不阻止后端物理回退。
    const cleanRollback = storageRollback.cleanRollback
    if (typeof cleanRollback !== 'function') throw new Error('缺少统一物理回退消费者')
    return await cleanRollback({ chat, requestedTurn,
      readChat, updateChat, chats, sessions, view, readCard: readChatCard, repairNative: typeof repairNative === 'function' ? repairNative : undefined, quiesce: quiesceRollback, sideCleanup: cleanupRollbackSides,
      persistence: typeof persistenceProvider === 'function' ? persistenceProvider() : persistenceProvider,
      services: {
        projections: typeof projectionsProvider === 'function' ? projectionsProvider() : projectionsProvider,
        projectionCache: typeof projectionCacheProvider === 'function' ? projectionCacheProvider() : projectionCacheProvider,
        tokenMeterProvider: () => typeof tokenMeterProvider === 'function' ? tokenMeterProvider() : tokenMeterProvider,
        webServerProvider: () => typeof webServerProvider === 'function' ? webServerProvider() : webServerProvider,
      },
    })
  }

`
const IDLE_PROVIDER = '        preserveRetainedBodyEdits: true,\n'
const UPGRADED_BODY = body => body.replace('      services: {\n','      services: {\n' + IDLE_PROVIDER)
const IDLE_SIGNATURE = 'rollbackSyncProvider, variableStore, quiesceRollback, cleanupRollbackSides })'
const SYNC_BODY=BODY.replace('webServerProvider: () => typeof webServerProvider === \'function\' ? webServerProvider() : webServerProvider,', 'rollbackSyncProvider: () => typeof rollbackSyncProvider === \'function\' ? rollbackSyncProvider() : rollbackSyncProvider,')
// 新作者布局直接接最终消费者；不先修补随即会删除的软回退/历史窗口路径。
export function applyLatestCleanRollbackTransform(source) {
 const regenStart='  async function regenRecent(chatId, guidance, sessionId) {'
 const replayStart='  // ---------- 重放失败回合（移除被中断的回复，原样重发本轮输入） ----------'
 const regenCall='    try { return await regenRecent(chat.id, guidance, sessionId) ?? await regenBody(chat.id, guidance, sessionId) }'
 for(const anchor of [START,END,regenStart,replayStart,regenCall,
   '  async function rollbackRecent(reference, requestedTurn, restoredAgent) {',
   '    const bounded = await rollbackRecent(chat, requestedTurn, restoredAgent)',
   '  async function finishRollback(']) {
   if(source.split(anchor).length!==2)throw new Error('新作者唯一回退布局缺失或重复：'+anchor)
 }
 const from=source.indexOf(regenStart),to=source.indexOf(replayStart)
 if(to<=from)throw new Error('新作者重生成函数边界无效')
 let next=source.slice(0,from)+source.slice(to)
 next=next.replace(regenCall,'    // SQLite只有当前态：重生成沿行级checkpoint，不探测不存在的历史正文。\n    try { return await regenBody(chat.id, guidance, sessionId) }')
 return applyCleanRollbackTransform(next)
}
function applyCleanRollbackTransformCore(source) {
 if (source.includes(MARKER) && (source.split(MARKER).length!==2 || source.split(START).length!==2 || source.split(END).length!==2)) throw new Error('统一物理回退消费者重复/边界不唯一')
 if(source.includes(MARKER) && source.includes('rollbackSyncProvider')) {
   const start=source.indexOf(START),end=source.indexOf(END,start)
   if(end<=start)throw Error('旧consumer函数边界不完整')
   const old=source.slice(start,end)
   for(const token of ['storageRollback.cleanRollback','readChat, updateChat','sideCleanup: cleanupRollbackSides'])if(!old.includes(token))throw Error('旧consumer接线不完整：'+token)
   source=source.slice(0,start)+UPGRADED_BODY(SYNC_BODY)+source.slice(end)
   source=source.replace('cleanupRollbackSides, isFailureCleanupIdle })','cleanupRollbackSides })')
  }
  if (source.includes('rollbackSyncProvider')) {
  const signature='rollbackSyncProvider, variableStore, quiesceRollback, cleanupRollbackSides })'
   if(source.includes('        isFailureCleanupIdle,\n') && !source.includes('preserveRetainedBodyEdits: true'))source=source.replace('        isFailureCleanupIdle,\n',IDLE_PROVIDER)
  if(source.includes(UPGRADED_BODY(SYNC_BODY)) && source.split(IDLE_SIGNATURE).length===2)return applyRegenerationRollbackTransform(source)
  if(!source.includes(SYNC_BODY) || source.split(signature).length!==2)throw new Error('同连接统一回退消费者不完整')
  return applyRegenerationRollbackTransform(source.replace(SYNC_BODY,()=>UPGRADED_BODY(SYNC_BODY)).replace(signature,IDLE_SIGNATURE))
 }
 const legacy=applyLegacyCleanRollbackTransform(source)
 if(legacy.split(BODY).length!==2 || legacy.split('webServerProvider, variableStore, quiesceRollback, cleanupRollbackSides })').length!==2)throw new Error('同连接统一回退升级锚点不唯一')
 return applyRegenerationRollbackTransform(legacy.replace(BODY,()=>UPGRADED_BODY(SYNC_BODY)).replace('webServerProvider, variableStore, quiesceRollback, cleanupRollbackSides })',IDLE_SIGNATURE))
}
function applyLegacyCleanRollbackTransform(source) {
 // 外层不能先resume：统一编排已负责活/冷Session，resume的end-seed会被持久屏障拒绝。
 const resume=`      if (!sessions.get(chat.sessionId)?.session && !sessions.getSession?.(chat.sessionId) && typeof sessions.resume === 'function') {
        restoredHandle = await sessions.resume(chat.sessionId)
      }`
 const cold='      // [dsh-tavern-rollback-cold:v1] 由统一编排只读装载冷Session，不先resume Agent。'
 if(!source.includes(cold)) {
  if(source.split(resume).length!==2)throw new Error('回退外层冷恢复锚点缺失或不唯一')
  source=source.replace(resume,cold)
 }
 if (source.includes(MARKER)) {
  source=source.replace('sidePreflight: preflightRollbackSides, sideReserve: reserveRollbackSides, sideRelease: releaseRollbackSides, sideCleanup: cleanupRollbackSides,','sideCleanup: cleanupRollbackSides,').replace('sidePreflight: preflightRollbackSides, sideCleanup: cleanupRollbackSides,','sideCleanup: cleanupRollbackSides,').replace('variableStore, quiesceRollback, preflightRollbackSides, reserveRollbackSides, releaseRollbackSides, cleanupRollbackSides })','variableStore, quiesceRollback, cleanupRollbackSides })').replace('variableStore, quiesceRollback, preflightRollbackSides, cleanupRollbackSides })','variableStore, quiesceRollback, cleanupRollbackSides })')
  if (!source.includes(BODY) || !source.includes('variableStore, quiesceRollback, cleanupRollbackSides })')) throw new Error('统一物理回退标记不完整')
  return source
 }
 if (source.split(START).length!==2 || source.split(END).length!==2 || !source.includes('// [dsh-tavern-core-rollback:v1]')) throw new Error('统一物理回退需要完整旧标准v1，拒绝未知布局')
 const start=source.indexOf(START),end=source.indexOf(END,start)
 if(end<start)throw new Error('回退函数边界无效')
 let next=source.slice(0,start)+BODY+source.slice(end)
 const signature='webServerProvider, variableStore })'
 if(next.split(signature).length!==2)throw new Error('统一物理回退参数锚点不唯一')
 next=next.replace(signature,'webServerProvider, variableStore, quiesceRollback, cleanupRollbackSides })')
 const softStart=next.indexOf('      const cleared = clearFailedTurnSurface({ session, turn: target.turn })')
 const softEnd=next.indexOf('      // The replay input is a first-class turn input',softStart)
 if(softStart<0||softEnd<softStart)throw new Error('失败重放统一清理锚点缺失')
 next=next.slice(0,softStart)+`      await rollbackChat(chat, target.turn)
      const cleared = 1 // 已经物理删除整轮；继续发送相同输入复用原turn。
`+next.slice(softEnd)
 const undoStart=next.indexOf(END),undoEnd=next.indexOf('  return Object.freeze({ regenerate',undoStart)
 if(undoEnd<undoStart)throw new Error('旧undo退役锚点缺失')
 next=next.slice(0,undoStart)+`${END}
    void sessionId; void chatId
    throw new Error('物理删除不可撤销；旧回退恢复入口已退役')
  }

`+next.slice(undoEnd)
 return next
}

// 回退优先于重放/重生成：入口不再要求在途业务先完成，改由 cleanRollback 统一取消并收口半态。
function relaxRollbackEntryGates(source){
  const gate=`    if (pendingReplays.has(chat.id)) throw new Error('正在重放失败回合，请等待完成')
    if (pendingRegenerations.has(chat.id) || chat.regenInProgress) throw new Error('正文正在重新生成，请先完成恢复或生成')
    if (pendingRollbacks.has(chat.id)) throw new Error('正在回退本轮，请等待完成')
    pendingRollbacks.add(chat.id)`
  const relaxed=`    // 回退优先：重放/重生成在途先取消，regenInProgress/regenRecovery 半态由 rollback.prepare 一并清除。
    // 只保留同一会话并发回退的串行保护（后台由 schedulingBarrier 兜底）。
    if (pendingReplays.has(chat.id)) pendingReplays.delete(chat.id)
    if (pendingRegenerations.has(chat.id)) pendingRegenerations.delete(chat.id)
    if (pendingRollbacks.has(chat.id)) throw new Error('正在回退本轮，请等待完成')
    pendingRollbacks.add(chat.id)`
  if(!source.includes(relaxed) && !source.includes('// [dsh-tavern-rollback-entry-cancel:v2]')) {
    if(source.split(gate).length!==2)throw new Error('回退入口门锚点缺失或不唯一')
    source=source.replace(gate,relaxed)
  }
  source=source.replace('    if (pendingReplays.has(chat.id)) pendingReplays.delete(chat.id)\n','').replace('    if (pendingRegenerations.has(chat.id)) pendingRegenerations.delete(chat.id)\n','')
  source=source.replace('    // 回退优先：重放/重生成在途先取消，regenInProgress/regenRecovery 半态由 rollback.prepare 一并清除。','    // [dsh-tavern-rollback-entry-cancel:v2] 真实任务取消与等待由统一消费者执行。')
  // rollbackTurn 外层同样不再做客户端握手前置：握手只影响显示同步，不阻止后端物理回退。
  const handshake=`    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    // Identity and task flags only; rollbackChat reads the story it changes.`
  const noHandshake=`    // 客户端握手只影响显示同步，不阻止后端物理回退（与 rollbackChat 同一口径）。
    // Identity and task flags only; rollbackChat reads the story it changes.`
  if(!source.includes(noHandshake)){
    source=source.replace(handshake,noHandshake)
  }
  return source
}
export function applyCleanRollbackTransform(source){
 if(source.includes('// [dsh-tavern-rollback-operation-cancel:'))return source
 return relaxRollbackEntryGates(applyCleanRollbackTransformCore(source))
}
