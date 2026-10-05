// 世界书Library保持作者校验/投影契约，持久读写统一改逐行SQL。
const MARKER='// [dsh-tavern-rollback-worldbook:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('世界书SQL锚点未命中/不唯一：'+old);return source.replace(old,next)}
export function applyRollbackWorldbookLibraryTransform(source){
 function clearCache(value){
  if(value.includes('// [dsh-tavern-worldbook-cache-clear:v1]'))return value
  value=once(value,'  const templateRecords = createJsonProjectionCache(), templateSnapshots = new WeakMap()','  let templateRecords = createJsonProjectionCache(), templateSnapshots = new WeakMap()')
  return once(value,'  return Object.freeze({ catalog,',`  // [dsh-tavern-worldbook-cache-clear:v1] 不保留已删资源条目或模板快照的强缓存。
  function clearRollbackState(){templateRecords=createJsonProjectionCache();templateSnapshots=new WeakMap()}
  return Object.freeze({ clearRollbackState, catalog,`)
 }
 function sqlFirst(value){
  value=clearCache(value)
  value=value.replace('options.rollbackResources.read(source,embeddedDocument(card))','options.rollbackResources.read(source,card.character_book ?? null)')
  if(!value.includes('// [dsh-tavern-worldbook-catalog:v1]')){
   if(value.includes('  async function cardSummary(cardPath) {'))value=once(value,"    if (!card || !card.character_book || typeof card.character_book !== 'object') return { hasBook: false }\n    const view = inspectWorldBookDocument(card.character_book, { filename: card.name })",`    if (!card) return { hasBook: false }
    // [dsh-tavern-worldbook-catalog:v1] 摘要读取SQL当前态，null不回种子。
    const document=await options.rollbackResources.read({kind:'card',cardPath},card.character_book ?? null)
    if(document===null)return { hasBook: false }
    const view = inspectWorldBookDocument(document, { filename: card.name })`)
   else value=once(value,"        if (!card || !card.character_book || typeof card.character_book !== 'object') return {}\n        const view = inspectWorldBookDocument(card.character_book, { filename: card.name })",`        if (!card) return {}
        // [dsh-tavern-worldbook-catalog:v1] 目录读取SQL当前态。
        const document=await options.rollbackResources.read({kind:'card',cardPath},card.character_book ?? null)
        if(document===null)return {}
        const view = inspectWorldBookDocument(document, { filename: card.name })`)
  }
  if(!value.includes('// [dsh-tavern-worldbook-null:v1]'))value=once(value,'      const document = await options.rollbackResources.read(source,card.character_book ?? null)',`      const document = await options.rollbackResources.read(source,card.character_book ?? null)
      // [dsh-tavern-worldbook-null:v1] 明确已删除世界书，不能用空种子重建旧正文。
      if(document===null)throw new Error('人物卡没有自带世界书: '+source.cardPath)`)

  if(!value.includes('// [dsh-tavern-worldbook-binding-null:v1]')){
   value=value.replace('/人物卡不存在/.test(str(error && error.message))','/人物卡不存在|人物卡没有自带世界书/.test(str(error && error.message))')
   value=once(value,"    if (card.character_book && typeof card.character_book === 'object') {",`    // [dsh-tavern-worldbook-binding-null:v1] 默认绑定也按SQL有书/无书，新增不能受旧卡文件null阻挡。
    if (await options.rollbackResources.read({kind:'card',cardPath:normalized},card.character_book ?? null)!==null) {`)
  }
  if(value.includes('// [dsh-tavern-worldbook-sql-first:v1]'))return value
  const start=value.indexOf('    const text = await resources.readText(source.path)'),end=value.indexOf('    return {\n      source,',start)
  if(start<0||end<start)throw Error('世界书SQL先读边界缺失')
  return value.slice(0,start)+`    // [dsh-tavern-worldbook-sql-first:v1] 初始化后不再解析旧文件，种子只在确切首次读取。
    const document=await options.rollbackResources.read(source,async()=>{
      const text=await resources.readText(source.path)
      if(text===undefined)throw new Error('世界书不存在: '+source.path)
      try{return JSON.parse(text)}catch(error){throw new Error('世界书工作版 JSON 损坏: '+error.message)}
    })
    if(templateOnly)return templateRecord(JSON.stringify(document),source,source.path.split('/').pop())
`+value.slice(end)
 }
 if(source.includes(MARKER)){if(!source.includes('options.rollbackResources.save(record.source'))throw Error('世界书SQL标记不完整');return sqlFirst(source)}
 let next=MARKER+'\n'+source
 next=once(next,'      const document = embeddedDocument(card)','      const document = await options.rollbackResources.read(source,embeddedDocument(card))')
 next=once(next,'    if (templateOnly) return templateRecord(text, source, source.path.split(\'/\').pop())','')
 next=once(next,"\n    try { document = JSON.parse(text) } catch (error) { throw new Error('世界书工作版 JSON 损坏: ' + error.message) }",`\n    try { document = JSON.parse(text) } catch (error) { throw new Error('世界书工作版 JSON 损坏: ' + error.message) }
    document=await options.rollbackResources.read(source,document)
    if (templateOnly) return templateRecord(JSON.stringify(document),source,source.path.split('/').pop())`)
 next=once(next,'  async function update(locator, request) {','  async function update(locator, request, owner) {')
 next=once(next,`    if (record.source.kind === 'card') {
      await cards.update(record.source.cardPath, { character_book: changed.document })
    } else {
      await resources.write(record.source.path, JSON.stringify(changed.document, null, 2))
    }`,`    await options.rollbackResources.save(record.source,changed.document,record.document,owner)`)
 next=once(next,'  async function replaceNative(locator, document) {','  async function replaceNative(locator, document, owner) {')
 next=once(next,`    if (record.source.kind === 'card') {
      await cards.update(record.source.cardPath, { character_book: exportCharacterBook(native, { replace: true }) })
    } else {
      await resources.write(record.source.path, JSON.stringify(native, null, 2))
    }`,`    const nextDocument=record.source.kind==='card'?exportCharacterBook(native,{replace:true}):native
    await options.rollbackResources.save(record.source,nextDocument,record.document,owner)`)
 return sqlFirst(next)
}
export function applyRollbackWorldbookAdapterTransform(source){
 if(source.includes(MARKER))return source
 let next=MARKER+'\n'+source
 next=once(next,'options.worldBooks.update(resolved.record.source, request)','options.worldBooks.update(resolved.record.source, request, rollbackGlobalOwner(resolved.chat))')
 return once(next,'options.worldBooks.replaceNative(resolved.record.source, nativeDocument)','options.worldBooks.replaceNative(resolved.record.source, nativeDocument, rollbackGlobalOwner(resolved.chat))')
}
function singleStoreEdit(value){
 if(value.includes('// [dsh-tavern-card-single-store-edit:v1]'))return value
 value="import { isDeepStrictEqual as rollbackCardEqual } from 'node:util'\n"+value
 const start=value.indexOf('    // 定义编辑显式变量改动也进SQL'),end=value.indexOf('    const savedCard = change.view',start)
 if(start<0||end<start)throw Error('卡单存储编辑边界缺失')
 return value.slice(0,start)+`    // [dsh-tavern-card-single-store-edit:v1] 运行编辑单SQL提交；混合跨存储改动在写前拒绝，不能报错后留部分更新。
    const previousVariables=cardPreparation.present({card:workspace,as:'card-extensions'}).variables || {}
    const nextVariables=cardPreparation.present({card:savedWorkspace,as:'card-extensions'}).variables || {}
    const rawOf=value=>value.raw || value
    const dataOf=raw=>['chara_card_v2','chara_card_v3'].includes(raw.spec)&&raw.data?raw.data:raw
    const definitionOf=value=>{
      const raw=rawOf(value),data=dataOf(raw),extensions={...data.extensions},helper={...extensions.tavern_helper}
      delete helper.variables;extensions.tavern_helper=helper
      const stripped={...data,extensions};delete stripped.character_book
      return data===raw?stripped:{...raw,data:stripped}
    }
    const previousBook=dataOf(rawOf(workspace)).character_book ?? null,nextBook=dataOf(rawOf(savedWorkspace)).character_book ?? null
    const variablesChanged=!rollbackCardEqual(previousVariables,nextVariables),bookChanged=!rollbackCardEqual(previousBook,nextBook)
    const definitionChanged=!rollbackCardEqual(definitionOf(workspace),definitionOf(savedWorkspace))
    if(Number(variablesChanged)+Number(bookChanged)+Number(definitionChanged)>1 || ((variablesChanged||bookChanged)&&revision!=null))throw new Error('人物卡混合跨存储修改尚不支持原子提交，请分别修改定义、人物变量和世界书；未写入任何改动')
    if(variablesChanged)await characterVariableStore.save(normalizeResourcePath(cardPath,'card'),nextVariables,undefined,previousVariables)
    else if(bookChanged)await rollbackWorldbookResources.save({kind:'card',cardPath:normalizeResourcePath(cardPath,'card')},nextBook,previousBook)
    else if(definitionChanged){
      const definition={...savedWorkspace},raw={...rawOf(savedWorkspace)},data={...dataOf(raw)},extensions={...data.extensions},helper={...extensions.tavern_helper}
      delete helper.variables;extensions.tavern_helper=helper;data.extensions=extensions
      data.character_book=nextBook===null?null:{entries:[]}
      if(dataOf(raw)===raw)Object.assign(raw,data);else raw.data=data
      if(savedWorkspace.raw)definition.raw=raw;else Object.assign(definition,raw)
      await fileResources.writeWorking(normalizeResourcePath(cardPath,'card'),JSON.stringify(definition,null,2))
    }
    if(definitionChanged || (!variablesChanged&&!bookChanged))await bumpCardProjectionRevision(cardPath)
`+value.slice(end)
}
export function applyWorldbookSummaryCacheTransform(source){
 const marker='// [dsh-tavern-worldbook-summary-revision:v1]'
 if(source.includes(marker)){if(!source.includes('const storageRevision = await revision(path)')||!source.includes("storageRevision, value.dev"))throw Error('世界书摘要SQL版本标记不完整');return source}
 let out=once(source,'export function createCardSummaryCache({ absolute, read, limit = 512 }) {','export function createCardSummaryCache({ absolute, read, limit = 512, revision = async () => \'\' }) {')
 out=once(out,'  async function fingerprint(path) {','  async function fingerprint(path) {\n    const storageRevision = await revision(path)')
 return marker+'\n'+once(out,'return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs]', 'return [storageRevision, value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs]')
}
export function applyRollbackWorldbookHostTransform(source){
 function complete(value){
  if(value.includes('function cachedWorldBookSummary(kind)')&&!value.includes('revision: () => rollbackWorldbookResources.version()'))value=once(value,'createCardSummaryCache({ absolute: value => fileResources.absolute(value), read: compute })','createCardSummaryCache({ absolute: value => fileResources.absolute(value), read: compute, revision: () => rollbackWorldbookResources.version() })')
  if(!value.includes('// [dsh-tavern-card-worldbook-version:v1]'))value=once(value,"return Math.max(0, Number(state && state.cards && state.cards[str(cardPath)]) || 0)+Number((await characterVariableStore.version()).split(':').at(-1))",`// [dsh-tavern-card-worldbook-version:v1] 独立世界书SQL提交不再写卡文件，卡投影也要随书提交/恢复失效。
    return Math.max(0, Number(state && state.cards && state.cards[str(cardPath)]) || 0)+Number((await characterVariableStore.version()).split(':').at(-1))+Number((await rollbackWorldbookResources.version()).split(':').at(-1))`)
  value=value.replace("if(data.character_book&&typeof data.character_book==='object')data.character_book=await rollbackWorldbookResources.read({kind:'card',cardPath:normalizeResourcePath(cardPath,'card')},data.character_book)","data.character_book=await rollbackWorldbookResources.read({kind:'card',cardPath:normalizeResourcePath(cardPath,'card')},data.character_book ?? null)")
  value=value.replace("if(bookOf(previousBook)&&bookOf(nextBook))await rollbackWorldbookResources.save({kind:'card',cardPath:normalizeResourcePath(cardPath,'card')},bookOf(nextBook),bookOf(previousBook))","await rollbackWorldbookResources.save({kind:'card',cardPath:normalizeResourcePath(cardPath,'card')},bookOf(nextBook) ?? null,bookOf(previousBook) ?? null)")
  if(!value.includes('worldBooks.clearRollbackState()'))value=once(value,'      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)','      worldBooks.clearRollbackState()\n      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)')
  if(!value.includes('// [dsh-tavern-worldbook-card-projection:v1]'))value=once(value,"    data.extensions.tavern_helper.variables=await characterVariableStore.read(normalizeResourcePath(cardPath,'card'),data.extensions.tavern_helper.variables || {})",`    data.extensions.tavern_helper.variables=await characterVariableStore.read(normalizeResourcePath(cardPath,'card'),data.extensions.tavern_helper.variables || {})
    // [dsh-tavern-worldbook-card-projection:v1] 普通卡读取/导出也使用嵌入世界书SQL当前态。
    data.character_book=await rollbackWorldbookResources.read({kind:'card',cardPath:normalizeResourcePath(cardPath,'card')},data.character_book ?? null)`)
  if(!value.includes('// [dsh-tavern-worldbook-card-edit:v1]')&&!value.includes('// [dsh-tavern-card-single-store-edit:v1]'))value=once(value,"    await fileResources.writeWorking(normalizeResourcePath(cardPath, 'card'), JSON.stringify(definition, null, 2))",`    // [dsh-tavern-worldbook-card-edit:v1] 卡编辑世界书差异进SQL，不把运行条目重新写到定义文件。
    const previousBook=cardPreparation.present({card:workspace,as:'raw'})
    const nextBook=cardPreparation.present({card:savedWorkspace,as:'raw'})
    const bookOf=raw=>['chara_card_v2','chara_card_v3'].includes(raw.spec)&&raw.data?raw.data.character_book:raw.character_book
    await rollbackWorldbookResources.save({kind:'card',cardPath:normalizeResourcePath(cardPath,'card')},bookOf(nextBook) ?? null,bookOf(previousBook) ?? null)
    if(definitionData.character_book)definitionData.character_book={entries:[]}
    await fileResources.writeWorking(normalizeResourcePath(cardPath, 'card'), JSON.stringify(definition, null, 2))`)
  if(!value.includes('// [dsh-tavern-worldbook-sql-version:v1]'))value=once(value,'return JSON.stringify([binding, versions,',`// [dsh-tavern-worldbook-sql-version:v1]
      return JSON.stringify([binding, versions, await rollbackWorldbookResources.version(), await characterVariableStore.version(),`)
  return singleStoreEdit(value)
 }
 if(source.includes(MARKER)){if(!source.includes('const rollbackWorldbookResources=createRollbackWorldbookResources({dataRoot})'))throw Error('世界书SQL Host标记不完整');return complete(source)}
 let next="import { createRollbackWorldbookResources } from './domain/storage-rollback-business.js'\n"+MARKER+'\n'+source
 next=once(next,'  const worldBooks = createWorldBookLibrary({',`  const rollbackWorldbookResources=createRollbackWorldbookResources({dataRoot})
  ctx.effect(()=>()=>rollbackWorldbookResources.dispose(),'dsh-tavern: 世界书SQL释放')
  const worldBooks = createWorldBookLibrary({
    rollbackResources: rollbackWorldbookResources,`)
 return complete(next)
}
