// 发轮只提交一次实际差异；中间提交不触发显示同步或候选预热。
import { VIEW_OPERATION_FIELDS } from '../lib/chat-query-service.js'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
// 不改模板执行次序、prepareContext或逐条flush；只省无变化设置的DOM重载。
const MARK='// [dsh-tavern-prepare-performance:v1]'
function once(source,before,after){if(source.split(before).length!==2)throw Error('发送准备接线锚点缺失：'+before.slice(0,90));return source.replace(before,after)}
export function applyPreparePersistenceTransform(source){
 if(source.includes(MARK))return source
 source=once(source,"import { diffJson } from './json-mutation.js'","import { diffJson, applyJsonChangesShared } from './json-mutation.js'")
 return MARK+'\n'+once(source,'    const desired = captureChatHeader(input)\n    for (let attempt=0;attempt<5;attempt++) {',`    // 同版本直接提交变化路径；并发变更仍走下方原三方合并/历史刷新。
    if (records.patchHeader) {
      const {messages: _messages, ...head} = input
      const changes = diffJson(baseline, head).filter(change => ![STORAGE_REVISION,'updatedAt'].includes(change.path[0]))
      const proposed = applyJsonChangesShared(baseline, changes)
      const saved = await records.patchHeader(input.id, baseline, changes, metadata, proposed)
      if (saved) {
        refreshDraft(input, proposed, saved)
        input[STORAGE_REVISION] = saved[STORAGE_REVISION]
        input.updatedAt = saved.updatedAt
        return saved
      }
    }
    const desired = captureChatHeader(input)
    for (let attempt=0;attempt<5;attempt++) {`)
}
export function applyPrepareTurnTransform(source){
 if(source.includes(MARK))return source
 let next=source.replace("        await savePreparation({source:'foreground.branch-before-template'})\n",'')
 next=once(next,'      if (store.writeChatHeader) preparationBase = await store.writeChatHeader(chat,preparationBase,metadata)',"      metadata = { ...metadata, prepareIntermediate: metadata.source !== 'foreground.prepare' }\n      if (store.writeChatHeader) preparationBase = await store.writeChatHeader(chat,preparationBase,metadata)")
 // 世界书前仍按作者原路落库一次：模板读取依赖真实版本/窗口/历史坐标，不能只换内存对象。
 return MARK+'\n'+next
}
export function applyPrepareHostTransform(source){
 if(source.includes(MARK))return source
 source=once(source,'      const runtime = await promptTemplateRuntime(chat.sessionId)\n      worldBook = await prepareTemplateWorldbook(worldBook, runtime, chat, await readPromptTemplateGlobalVariables())','      const runtime = await promptTemplateRuntime(chat.sessionId)\n      const globals = await readPromptTemplateGlobalVariables()\n      worldBook = await prepareTemplateWorldbook(worldBook, runtime, chat, globals)')
 source=once(source,'        globalVariables: await readPromptTemplateGlobalVariables(),','        globalVariables: globals,')
 return MARK+'\n'+once(source,`    candidateWorldbookPreparation?.changed(saved,metadata)
    await syncChatSummary(chat)
    void coordinationEvents?.publish(saved.sessionId)
    scheduleTemplateSync(saved, metadata)
    queueAutoCompaction(saved.sessionId)
    return saved`, `    if (!metadata?.prepareIntermediate) {
      candidateWorldbookPreparation?.changed(saved,metadata)
      await syncChatSummary(chat)
      void coordinationEvents?.publish(saved.sessionId)
      scheduleTemplateSync(saved, metadata)
      queueAutoCompaction(saved.sessionId)
    }
    return saved`)
}

export function applyTemplateRefreshPerformanceTransform(source){
 if(source.includes(MARK))return source
 source=once(source,'    const plugin = {','    let loadedSettings\n    const plugin = {')
 return MARK+'\n'+once(source,"      refresh: async snapshot => { host.refreshTemplateSnapshot(snapshot); await host.eventSource.emit('SETTINGS_LOADED') },",`      refresh: async snapshot => {
        host.refreshTemplateSnapshot(snapshot)
        const settings = JSON.stringify(snapshot.extension_settings.EjsTemplate)
        if (loadedSettings !== settings) {
          loadedSettings = settings
          await host.eventSource.emit('SETTINGS_LOADED')
        }
      },`)
}

// 实际worker执行server-artifact而非host-build源码；两路均接，不另造模板引擎。
export function applyTemplateArtifactPerformanceTransform(source){
 if(source.includes(MARK))return source
 const ast=parse(source,{ecmaVersion:'latest'}),arrows=[]
 function walk(node){
  if(!node || typeof node!=='object')return
  if(node.type==='ArrowFunctionExpression' && node.async && node.params.length===1 && node.params[0].type==='Identifier') {
    const body=source.slice(node.start,node.end)
    if(/^[^{]+\{[\w$.]+\.refreshTemplateSnapshot\(\w+\),await [\w$.]+\.eventSource\.emit\("SETTINGS_LOADED"\)\}$/.test(body))arrows.push(node)
  }
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value && typeof value==='object')walk(value)
 }
 walk(ast)
 if(arrows.length!==1)throw Error('服务端模板设置刷新接线缺失')
 const node=arrows[0],body=source.slice(node.start,node.end),param=node.params[0].name
 const at=body.indexOf(',await '),prefix=body.slice(0,at),emit=body.slice(at+1,-1)
 const replacement=`(()=>{let loadedSettings;return ${prefix};const settings=JSON.stringify(${param}.extension_settings.EjsTemplate);if(loadedSettings!==settings){loadedSettings=settings;${emit}}}})()`
 return MARK+'\n'+source.slice(0,node.start)+replacement+source.slice(node.end)
}

export function applyTimelineInspectPerformanceTransform(source){
 if(source.includes(MARK))return source
 // inspect也供正文提交读取小型场景引用；大回退前像仍走captureRollbackBusinessState。
 const fields=JSON.stringify([...VIEW_OPERATION_FIELDS,'sceneWorldbook'])
 return MARK+'\n'+once(source,'      timeline: source?.timeline ? {...source.timeline,checkpoints:[]} : source?.timeline,',`      timeline: source?.timeline ? {...source.timeline,checkpoints:[],operations:Object.fromEntries(Object.entries(source.timeline.operations || {}).map(([id,operation]) => [id,Object.fromEntries(${fields}.filter(key => Object.hasOwn(operation,key)).map(key => [key,operation[key]]))]))} : source?.timeline,`)
}

export function applyForegroundProjectionPerformanceTransform(source){
 if(source.includes(MARK))return source
 // 其它代作者没有相同导入/调用锚点时保持原样：复用优化只是锦上添花，不能因优化让这类源码无法构建。
 if(!source.includes("import { fingerprint, isMvuUpdateEntry } from './worldbook-recall.js'"))return source
 source=once(source,'      let converged = false','      let converged = false, previousSelection, previousProjection')
 source=once(source,'        projected = await projectWorldBookTemplates({ worldBook, selectedEntries: recalled.entries || [], includeConstants: true,',`        // 无模板的纯文本条目在相同有序选择下不重投影；模板任意副作用不作结果缓存。
        const selection = (recalled.entries || []).map(entry => entry.ref).join('\\n')
        const plain = !(recalled.entries || []).some(isWorldBookTemplateEntry)
        projected = plain && selection === previousSelection ? previousProjection : await projectWorldBookTemplates({ worldBook, selectedEntries: recalled.entries || [], includeConstants: true,`)
 source=once(source,'        let costsChanged = false',`        previousSelection = plain ? selection : undefined
        previousProjection = projected
        let costsChanged = false`)
 source=once(source,"import { fingerprint, isMvuUpdateEntry } from './worldbook-recall.js'","import { fingerprint, isMvuUpdateEntry, isWorldBookTemplateEntry } from './worldbook-recall.js'")
 return MARK+'\n'+source
}
