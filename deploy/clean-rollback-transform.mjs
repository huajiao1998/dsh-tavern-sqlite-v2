// 替换作者rollbackChat全体为包拥有的唯一编排，升级旧v1后不保留失败软清/undo/script删除副作用。
const MARKER='// [dsh-tavern-clean-rollback:v1]'
const START='  async function rollbackChat(chat, requestedTurn, restoredAgent) {'
const END='  async function undoRollback(sessionId, chatId) {'
const BODY=`${START}
    ${MARKER}
    void restoredAgent
    if (sessionPatch && !sessionPatch.replacementAllowed()) throw new Error(sessionPatch.blockReason())
    const cleanRollback = storageRollback.cleanRollback
    if (typeof cleanRollback !== 'function') throw new Error('缺少统一物理回退消费者')
    return await cleanRollback({ chat, requestedTurn, availability: rollbackAvailability,
      readChat, updateChat, chats, sessions, view, readCard: readChatCard, quiesce: quiesceRollback, sideCleanup: cleanupRollbackSides,
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
export function applyCleanRollbackTransform(source) {
 if (source.includes(MARKER) && (source.split(MARKER).length!==2 || source.split(START).length!==2 || source.split(END).length!==2)) throw new Error('统一物理回退消费者重复/边界不唯一')
 if (source.includes('rollbackSyncProvider')) {
  if(!source.includes(SYNC_BODY) || source.split('rollbackSyncProvider, variableStore, quiesceRollback, cleanupRollbackSides })').length!==2) throw new Error('同连接统一回退消费者不完整')
  return source
 }
 const legacy=applyLegacyCleanRollbackTransform(source)
 if(legacy.split(BODY).length!==2 || legacy.split('webServerProvider, variableStore, quiesceRollback, cleanupRollbackSides })').length!==2)throw new Error('同连接统一回退升级锚点不唯一')
 return legacy.replace(BODY,SYNC_BODY).replace('webServerProvider, variableStore, quiesceRollback, cleanupRollbackSides })','rollbackSyncProvider, variableStore, quiesceRollback, cleanupRollbackSides })')
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
