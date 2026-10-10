// 仅恢复已核实的本档剧情运行根；未知字段/资源引用/用户配置保持当前值。
// 实际写口：story-timeline、turn-orchestration、MVU effect、script adapter、history-recall。
const STORY_FIELDS = new Set([
 'variables','tavernPluginMetadata','tavernHelperScriptVariables','tavernScriptPrompts','mvu',
 'presentation','presentationWarnings','posture','ledger','scriptState',
 'candidates','candidateAgent','settleStatus','settleError','lastSettle','foregroundError',
 'preparedWorldBookContext','preparedWorldBook','lastWorldBookRecall','worldBookReads','worldBookRandomState','worldBookError',
 'openingWorldbookSnapshot','promptTemplateInput','promptTemplateInitialVariables',
 'runtimeInputs','foregroundFrames','nativeCommits','pendingCardChanges','compatibilityTraces',
 'contextCompaction','historyRecallCooldowns','taskMailbox','rollbackSessionCuts',
 'ledgerInjection',
 'regenInProgress','hiddenDshErrorTurns','suppressedDshTurns','regeneratedDshTurns'
])
// 宏局部/全局是本档运行快照；userName由setPlayerName手工控制，不能随宏状态回退。
const MACRO_FIELDS = ['local','global']
// 已发布row-v1的snapshot精确覆盖面；其余根不能当作当时不存在而删除。
const ROW_FIELDS = ['presentation','presentationWarnings','variables','tavernPluginMetadata','tavernHelperScriptVariables','tavernScriptPrompts','runtimeInputs','posture','ledger','scriptState','candidates','settleStatus','settleError','lastSettle','preparedWorldBookContext','preparedWorldBook','worldBookReads']
export function resolveRollbackBusinessState(chat,turn,failed=false) {
 const operations=chat.timeline?.operations || {},body=Object.values(operations).find(op=>op.kind==='body' && Number(op.turn)===turn)
 const checkpoint=chat.timeline?.checkpoints?.findLast(cp=>Number(cp.turn)===turn)
 const complete=failed?body?.businessBefore:checkpoint?.businessBefore
 if(complete!==undefined)return complete // 未知新格式不能静默降级。
 const row=failed?body?.rowBefore:checkpoint?.rowBefore,participants=failed?body?.beforeParticipants:checkpoint?.participants
 if(!row || !participants || ['presentation','presentationWarnings','macroState','tavernScriptPrompts','runtimeInputs','posture','ledger','scriptState','candidates','settleStatus','settleError','lastSettle','preparedWorldBookContext','preparedWorldBook','worldBookReads'].some(key=>!Object.hasOwn(row,key)))throw new Error('本轮缺少可识别的业务回退基准（businessBefore或旧rowBefore）；未删数据库，不以当前值猜历史')
 const messages=chat.messages || []
 let messageCount=messages.findIndex(message=>Number(message.turn)>=turn)
 if(!failed){
  const index=messages.findLastIndex(message=>message.role==='assistant' && Number(message.turn)===turn)
  if(index<1 || messages[index-1]?.role!=='user')throw new Error('旧rowBefore缺少确切用户/正文行前缀，未删数据库')
  messageCount=index-1
 }
 if(messageCount<0)throw new Error('旧失败轮缺少带轮号的正文前缀，未删数据库')
 if(messages.slice(messageCount).some(message=>Number.isSafeInteger(message.turn) && message.turn<turn))throw new Error('旧快照行前缀不是纯尾，未删数据库')
 const kept=Object.fromEntries(Object.entries(operations).filter(([,op])=>Number(op.turn)<turn))
 const operationIds=Object.keys(kept),fields=Object.fromEntries(ROW_FIELDS.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))
 fields.macroState=Object.fromEntries(MACRO_FIELDS.filter(key=>Object.hasOwn(row.macroState || {},key)).map(key=>[key,row.macroState[key]]))
 return structuredClone({version:1,legacyFormat:'row-v1',turn,fields,messageCount,participants,operationIds,operationStates:{}})
}
export function captureRollbackBusinessState(chat, copy = structuredClone, worldbookRef) {
 const fields = {}
 for (const key of STORY_FIELDS) if (Object.hasOwn(chat,key)) fields[key] = chat[key]
 if(chat.macroState && typeof chat.macroState==='object')fields.macroState=Object.fromEntries(MACRO_FIELDS.filter(key=>Object.hasOwn(chat.macroState,key)).map(key=>[key,chat.macroState[key]]))
 const operationStates = {}
 for (const [id,operation] of Object.entries(chat.timeline?.operations || {})) {
  const {businessBefore,rowBefore,beforeParticipants,...state} = operation
  operationStates[id] = state
 }
 if (worldbookRef !== undefined) {
  if (!Object.hasOwn(fields, 'openingWorldbookSnapshot')) throw new Error('世界书引用不能代替本来缺失的字段')
  delete fields.openingWorldbookSnapshot
 }
 return copy({version:1,fields,...(worldbookRef === undefined ? {} : {worldbookRef}),messageCount:Array.isArray(chat.messages)?chat.messages.length:0,participants:chat.timeline?.participants || {},operationIds:Object.keys(operationStates),operationStates})
}
export function restoreRollbackBusinessState(chat, baseline, copy = structuredClone, readWorldbook) {
 if (baseline?.version !== 1 || !baseline.fields || !baseline.participants || !Array.isArray(baseline.operationIds)) throw new Error('缺少完整上轮业务基准，拒绝用当前状态或空值冒充历史')
 const hasBookRef = Object.hasOwn(baseline, 'worldbookRef')
 let historicalBook
 // 先解析并验证，失败不得留下半恢复状态，不从当前书猜历史。
 if (hasBookRef) {
  if (Object.hasOwn(baseline.fields, 'openingWorldbookSnapshot')) throw new Error('世界书基准同时有全文与引用，拒绝不明确恢复')
  if (typeof readWorldbook !== 'function') throw new Error('世界书历史引用缺少数据库解析接线')
  historicalBook = readWorldbook(chat, baseline.worldbookRef)
  if (historicalBook === undefined || historicalBook?.then) throw new Error('世界书历史引用未返回完整同步状态')
 }
 for (const key of baseline.legacyFormat==='row-v1'?ROW_FIELDS:STORY_FIELDS) {
  if (key === 'openingWorldbookSnapshot' && hasBookRef) chat[key] = copy(historicalBook)
  else if(Object.hasOwn(baseline.fields,key))chat[key]=copy(baseline.fields[key]);else delete chat[key]
 }
 const currentMacro=chat.macroState && typeof chat.macroState==='object'?{...chat.macroState}:{}
 for(const key of MACRO_FIELDS){if(Object.hasOwn(baseline.fields.macroState || {},key))currentMacro[key]=copy(baseline.fields.macroState[key]);else delete currentMacro[key]}
 if(Object.keys(currentMacro).length)chat.macroState=currentMacro;else delete chat.macroState
 if (chat.timeline) {
  const kept = new Set(baseline.operationIds)
  for (const key of Object.keys(chat.timeline.operations || {})) if (!kept.has(key)) delete chat.timeline.operations[key]
  for (const [id,state] of Object.entries(baseline.operationStates || {})) {
   const current = chat.timeline.operations[id]
   if (!current) throw new Error('上轮账本条目已缺失，拒绝不完整恢复：'+id)
   const {businessBefore,rowBefore,beforeParticipants} = current
   chat.timeline.operations[id] = {...copy(state),...(businessBefore === undefined ? {} : {businessBefore}),...(rowBefore === undefined ? {} : {rowBefore}),...(beforeParticipants === undefined ? {} : {beforeParticipants})}
  }
 }
 if(baseline.legacyFormat==='row-v1'){
  // 旧快照未记录的独立初始化/控制根不复写；有确切轮归属的运行缓存只删目标尾。
  const turn=baseline.turn
  for(const key of ['foregroundFrames','nativeCommits','rollbackSessionCuts','regeneratedDshTurns','historyRecallCooldowns']){
   const value=chat[key]
   if(Array.isArray(value))chat[key]=value.filter(item=>Number(item?.turn)<turn)
   else if(value && typeof value==='object')for(const [id,item] of Object.entries(value))if(Number(item?.turn ?? id)>=turn)delete value[id]
  }
  for(const key of ['lastWorldBookRecall','worldBookRandomState'])if(Number(chat[key]?.turn)>=turn)delete chat[key]
  // 压缩调度缓存随新分支重建，不用旧分支收据/警告充当上轮状态；策略配置在外层保留。
  delete chat.contextCompaction;delete chat.foregroundError;delete chat.regenInProgress
 }
 delete chat.rollbackUndo
 return chat
}
