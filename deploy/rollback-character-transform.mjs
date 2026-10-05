// 人物变量读写改SQL权威；定义文件只保留非运行变量，不恢复整卡JSON。
const MARKER='// [dsh-tavern-rollback-character:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('人物变量回退锚点未命中/不唯一：'+old);return source.replace(old,next)}
export function applyRollbackCharacterAdapterTransform(source){
 if(source.includes(MARKER))return source
 return MARKER+'\n'+once(source,"{}, str(sessionId))","{}, str(sessionId), rollbackGlobalOwner(chat))")
}
export function applyRollbackCharacterHostTransform(source){
 const version=value=>{
  value=value.replace("const copy=structuredClone(workspace),raw=copy.raw || copy\n    const data=['chara_card_v2','chara_card_v3'].includes(raw.spec)&&raw.data&&typeof raw.data==='object'?raw.data:raw\n    data.extensions ||= {};data.extensions.tavern_helper ||= {}","const copy={...workspace},raw=workspace.raw?{...workspace.raw}:copy\n    if(workspace.raw)copy.raw=raw\n    const hasData=['chara_card_v2','chara_card_v3'].includes(raw.spec)&&raw.data&&typeof raw.data==='object'\n    const data=hasData?{...raw.data}:raw\n    if(hasData)raw.data=data\n    data.extensions={...data.extensions};data.extensions.tavern_helper={...data.extensions.tavern_helper}")
  return value.includes('// [dsh-tavern-character-sql-version:v1]')||value.includes('// [dsh-tavern-card-worldbook-version:v1]')?value:once(value,'    return Math.max(0, Number(state && state.cards && state.cards[str(cardPath)]) || 0)',`    // [dsh-tavern-character-sql-version:v1] SQL写/恢复提交都改变技术版本，旧人物变量缓存不得命中。
    return Math.max(0, Number(state && state.cards && state.cards[str(cardPath)]) || 0)+Number((await characterVariableStore.version()).split(':').at(-1))`)
 }
 if(source.includes(MARKER)){if(!source.includes('const characterVariableStore=createRollbackCharacterVariables({dataRoot})'))throw Error('人物变量回退标记不完整');return version(source)}
 let next="import { createRollbackCharacterVariables } from './domain/storage-rollback-business.js'\n"+MARKER+'\n'+source
 next=once(next,'  const fileResources = createFileResourceStore({ dataRoot })',`  const characterVariableStore=createRollbackCharacterVariables({dataRoot})
  ctx.effect(()=>()=>characterVariableStore.dispose(),'dsh-tavern: 人物变量SQL释放')
  async function projectCharacterVariables(cardPath,workspace) {
    if(workspace===undefined)return undefined
    const copy={...workspace},raw=workspace.raw?{...workspace.raw}:copy
    if(workspace.raw)copy.raw=raw
    const hasData=['chara_card_v2','chara_card_v3'].includes(raw.spec)&&raw.data&&typeof raw.data==='object'
    const data=hasData?{...raw.data}:raw
    if(hasData)raw.data=data
    data.extensions={...data.extensions};data.extensions.tavern_helper={...data.extensions.tavern_helper}
    data.extensions.tavern_helper.variables=await characterVariableStore.read(normalizeResourcePath(cardPath,'card'),data.extensions.tavern_helper.variables || {})
    return copy
  }
  const fileResources = createFileResourceStore({ dataRoot })`)
 next=once(next,'    if (cardPreparation.isWorkspace(existing)) return existing','    if (cardPreparation.isWorkspace(existing)) return projectCharacterVariables(normalized,existing)')
 next=once(next,'    return await fileResources.ensureCardWorkspace(normalized, function (working, payload) {\n      return cardPreparation.migrate({ working, payload })\n    })',`    return projectCharacterVariables(normalized,await fileResources.ensureCardWorkspace(normalized, function (working, payload) {
      return cardPreparation.migrate({ working, payload })
    }))`)
 next=once(next,'const extensions = cardPreparation.present({ card: workspace, as: \'card-extensions\' })',"const extensions = cardPreparation.present({ card: await projectCharacterVariables(cardPath,workspace), as: 'card-extensions' })")
 const start=next.indexOf('  async function replaceCardVariables('),end=next.indexOf('  async function syncCardName(',start)
 if(start<0||end<start)throw Error('人物变量替换函数边界未知')
 next=next.slice(0,start)+`  async function replaceCardVariables(cardPath, variables, owner) {
    const workspace=await readCardWorkspace(cardPath)
    if(workspace===undefined)throw new Error('人物卡不存在: '+cardPath)
    const saved=await characterVariableStore.save(normalizeResourcePath(cardPath,'card'),variables,owner)
    await bumpCardProjectionRevision(cardPath)
    return saved
  }
`+next.slice(end)
 next=once(next,'save: async function (cardPath, variables, sessionId) {','save: async function (cardPath, variables, sessionId, owner) {')
 next=once(next,'const saved = await replaceCardVariables(cardPath, variables)','const saved = await replaceCardVariables(cardPath, variables, owner)')
 next=once(next,"    await fileResources.writeWorking(normalizeResourcePath(cardPath, 'card'), JSON.stringify(savedWorkspace, null, 2))",`    // 定义编辑显式变量改动也进SQL；运行值不能随无关卡编辑重新落文件。
    const previousVariables=cardPreparation.present({card:workspace,as:'card-extensions'}).variables || {}
    const nextVariables=cardPreparation.present({card:savedWorkspace,as:'card-extensions'}).variables || {}
    await characterVariableStore.save(normalizeResourcePath(cardPath,'card'),nextVariables,undefined,previousVariables)
    const definition=structuredClone(savedWorkspace),definitionRaw=definition.raw || definition
    const definitionData=['chara_card_v2','chara_card_v3'].includes(definitionRaw.spec)&&definitionRaw.data?definitionRaw.data:definitionRaw
    if(definitionData.extensions?.tavern_helper)delete definitionData.extensions.tavern_helper.variables
    await fileResources.writeWorking(normalizeResourcePath(cardPath, 'card'), JSON.stringify(definition, null, 2))`)
 return version(next)
}
