// 给实际共享变量写口传chat/turn归属，不用环境隐式归属。
const MARKER='// [dsh-tavern-rollback-globals:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('共享变量回退锚点未命中/不唯一：'+old);return source.replace(old,next)}
export function applyRollbackGlobalAdapterTransform(source){
 // 旧代设置撤销接缝就地退役；保permission、CAS与任务join，去掉最近body归属。
 if(source.includes('// [dsh-tavern-rollback-extension:v1]')){
  source=source.replace('// [dsh-tavern-rollback-extension:v1]\n','')
   .replace('return saveGlobalPromptTemplateSettings(settings, expectedSettings, rollbackGlobalOwner(settingsChat))','return saveGlobalPromptTemplateSettings(settings, expectedSettings)')
   .replace('async function saveGlobalPromptTemplateSettings(settings, expectedSettings, owner)','async function saveGlobalPromptTemplateSettings(settings, expectedSettings)')
   .replace('options.fullExtensionSettings.save({ ...current, EjsTemplate: settings }, base, owner)','options.fullExtensionSettings.save({ ...current, EjsTemplate: settings }, base)')
   .replace('options.extensionSettings.save(settings, expectedSettings, rollbackGlobalOwner(extensionChat))','options.extensionSettings.save(settings, expectedSettings)')
 }
 function addJoin(value){
  let next=value.includes('whenIdle: sessionId => serverExecution.whenIdle(sessionId)')||value.includes('// [dsh-tavern-adapter-runs:v1]')?value:once(value,'    dispatchEvent,\n    settleMvuUpdate,','    dispatchEvent,\n    whenIdle: sessionId => serverExecution.whenIdle(sessionId),\n    settleMvuUpdate,')
  if(next.includes('// [dsh-tavern-adapter-runs:v1]'))return addClear(next)
  next="import { rollbackBarrier, rollbackSchedulingBarrier } from './storage-rollback-business.js'\n"+next
  next=once(next,'export function createTavernScriptHostAdapter(options = {}) {',`export function createTavernScriptHostAdapter(options = {}) {
  // [dsh-tavern-adapter-runs:v1]
  const rollbackAdapterRuns=new Map()
  function trackRollbackAdapterRun(work) {
    return (...args)=>{
      const id=String(typeof args[0]==='object'?args[0]?.sessionId || '':args[0] || '')
      if(rollbackBarrier.has(id)||rollbackSchedulingBarrier.has(id))return Promise.reject(new Error('物理回退期间禁止新手动写任务'))
      const task=Promise.resolve().then(()=>work(...args))
      if(!rollbackAdapterRuns.has(id))rollbackAdapterRuns.set(id,new Set())
      rollbackAdapterRuns.get(id).add(task)
      task.finally(()=>{const set=rollbackAdapterRuns.get(id);set?.delete(task);if(!set?.size)rollbackAdapterRuns.delete(id)}).catch(()=>{})
      return task
    }
  }
  async function whenRollbackAdapterIdle(id) {
    await serverExecution.whenIdle(id)
    while(rollbackAdapterRuns.get(id)?.size)await Promise.allSettled([...rollbackAdapterRuns.get(id)])
    await serverExecution.whenIdle(id)
  }`)
  next=once(next,'    whenIdle: sessionId => serverExecution.whenIdle(sessionId),','    whenIdle: whenRollbackAdapterIdle,')
  for(const name of ['dispatchEvent','settleMvuUpdate','updatePrompts','updateVariables','updateMessages','createMessages','replaceWorldbook','saveFullPromptTemplateState','saveFullPromptTemplateSettings','saveFullPromptTemplateGlobals','saveExtensionSettings','saveChatData','saveWorldInfo'])next=once(next,'    '+name+',','    '+name+': trackRollbackAdapterRun('+name+'),')
  return addClear(next)
 }
 function addClear(value){
  if(value.includes('// [dsh-tavern-adapter-clear:v1]'))return value.includes('settlementReaders=new WeakMap();settlementSizes=new WeakMap()')?once(value,'      settlementReaders=new WeakMap();settlementSizes=new WeakMap()','      // WeakMap不保留key；保留其他chat正在使用的row reader，不全局抹除。'):value
  let next=value
  for(const name of ['syncTemplateState','templateCharacters'])next=once(next,'  const '+name+' =','  let '+name+' =')
  next=once(next,'    whenIdle: whenRollbackAdapterIdle,',`    whenIdle: whenRollbackAdapterIdle,
    // [dsh-tavern-adapter-clear:v1] 仅静止后解除旧正文/模板环境的强引用。
    clearRollbackState: async sessionId => {
      await whenRollbackAdapterIdle(sessionId)
      if(settlementBase?.sessionId===sessionId)settlementBase=null
      // WeakMap不保留key；保留其他chat正在使用的row reader，不全局抹除。
      syncTemplateState=createFullPromptTemplateSync()
      templateCharacters=createJsonValueProjectionCache({ capacity: 8, maxBytes: 64 * 1024 * 1024 })
    },`)
  return next
 }
 if(source.includes(MARKER)){if(!source.includes('rollbackGlobalOwner(chat)')||!source.includes('rollbackGlobalOwner(globalChat)'))throw Error('共享变量写归属标记不完整');return addJoin(source)}
 let next="import { rollbackGlobalOwner } from './storage-rollback-business.js'\n"+MARKER+'\n'+source
 next=once(next,'const saved = await options.globalVariables.save(variables && typeof variables === \'object\' && !Array.isArray(variables) ? variables : {})',"const saved = await options.globalVariables.save(variables && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}, undefined, rollbackGlobalOwner(chat))")
 next=once(next,'    assertTemplateChat(await resourcePermissionChat(sessionId))\n    if (!expectedVariables', '    const globalChat = await resourcePermissionChat(sessionId)\n    assertTemplateChat(globalChat)\n    if (!expectedVariables')
 next=once(next,'    const saved = await options.globalVariables.save(variables, expectedVariables)', '    const saved = await options.globalVariables.save(variables, expectedVariables, rollbackGlobalOwner(globalChat))')
 next=addJoin(next)
 return next
}
export function applyRollbackGlobalHostTransform(source){
 // 旧标准树就地去除五共享库撤销；保留召回删轮和本档模板缓存清理。
 source=source.replace('// [dsh-tavern-rollback-extension:v1]\n','')
 for(const store of ['promptTemplateGlobalVariables','tavernExtensionSettings','characterVariableStore','rollbackWorldbookResources','rollbackWorldbookBindings'])for(const method of ['reserveRollback','releaseRollback','preflightRollback','pruneRollback'])source=source.replace(new RegExp('^      await '+store+'\\.'+method+'\\(chat, turn(?:, archive)?\\)\\r?\\n','gm'),'')
 source=source.replace(/    (?:reserveRollbackSides|releaseRollbackSides|preflightRollbackSides): async \([^\n]*\) => \{\n    \},\n/g,'')
 const addClear=value=>value.includes('await tavernScriptHostAdapter.clearRollbackState(chat.sessionId)')?value:once(value,'      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)','      await tavernScriptHostAdapter.clearRollbackState(chat.sessionId)\n      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)')
 const marker='// [dsh-tavern-rollback-global-host:v1]'
 if(source.includes(marker)){if(!source.includes('createRollbackGlobalVariables({ profileData, dataRoot })')||!source.includes('createRollbackExtensionSettings({ profileData, dataRoot })'))throw Error('共享变量Host回退标记不完整');return addClear(source)}
 let next="import { createRollbackGlobalVariables, createRollbackExtensionSettings } from './domain/storage-rollback-business.js'\n"+marker+'\n'+source
 // 设置只保留SQL权威和技术版本；不改adapter写口，不给手工配置附正文撤销归属。
 next=once(next,'  const tavernExtensionSettings = createTavernExtensionSettings(profileData)',"  const tavernExtensionSettings = createRollbackExtensionSettings({ profileData, dataRoot })\n  ctx.effect(() => () => tavernExtensionSettings.dispose(), 'dsh-tavern: 设置SQL释放')")
 next=once(next,'    fullExtensionSettings: createTavernExtensionSettings(profileData),','    fullExtensionSettings: tavernExtensionSettings,')
 next=next.replaceAll("profileData.version('tavern-extension-settings.json')",'tavernExtensionSettings.version()')
 next=once(next,'  const promptTemplateGlobalVariables = createPromptTemplateGlobalVariables(profileData)',"  const promptTemplateGlobalVariables = createRollbackGlobalVariables({ profileData, dataRoot })\n  ctx.effect(() => () => promptTemplateGlobalVariables.dispose(), 'dsh-tavern: 全局变量SQL释放')")
 next=once(next,'    cleanupRollbackSides: (chat, turn) => worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId),',`    cleanupRollbackSides: async (chat, turn) => {
      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)
    },`)
 next=once(next,'    projectUserTemplate: async ({chat,text}) => {','    projectUserTemplate: async ({chat,text,turn}) => {')
 // body.begin此时尚未写回archive，不能通过adapter重读旧头猜归属为52。
 next=once(next,'      await tavernScriptHostAdapter.saveFullPromptTemplateGlobals(chat.sessionId, result.scopes.global, global)','      await promptTemplateGlobalVariables.save(result.scopes.global, global, { chatId: chat.id, turn })')
 next=next.replaceAll("profileData.version('prompt-template-variables.json')",'promptTemplateGlobalVariables.version()')
 next=once(next,'          await writePromptTemplateGlobalVariables(compiled.promptTemplateState.scopes.global)',"          await promptTemplateGlobalVariables.save(compiled.promptTemplateState.scopes.global, undefined, { chatId: input.chat.id, turn: Number(input.turn) })")
 return addClear(next)
}
