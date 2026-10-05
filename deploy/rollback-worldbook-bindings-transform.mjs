const MARKER='// [dsh-tavern-worldbook-bindings-sql:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('世界书绑定SQL锚点缺失/不唯一：'+old);return source.replace(old,next)}
export function applyRollbackWorldbookBindingsFileTransform(source){
 function retireGuards(value){
  if(value.includes('// [dsh-tavern-resource-path-sql:v1]'))return value
  value=value.replace("    if(kind==='card'||kind==='worldbook')throw new Error('SQL资源身份生命周期尚未接管，禁止文件层删除人物卡/世界书')\n",'').replace("    if(kind==='card'||kind==='worldbook')throw new Error('SQL资源身份生命周期尚未接管，禁止文件层改名人物卡/世界书')\n",'')
  // 绑定当前值由SQL更新；不将SQL投影或写前值放入作者文件journal。
  value=value.replaceAll("      if(worldBookBindingsChanged)throw new Error('禁止世界书绑定写回文件journal')",'')
  const helper=`  // [dsh-tavern-resource-path-sql:v1] 沿用资源图原操作重试，无新身份或日志层。
  async function moveSqlResource(from,to){
    const kind=resourceKind(from)
    if(kind!=='card'&&kind!=='worldbook')return
    if(kind==='card')await options.characterVariables.movePath(from,to)
    const source=kind==='card'?{kind:'card',cardPath:from}:{kind:'standalone',path:from}
    const target=to===null?null:kind==='card'?{kind:'card',cardPath:to}:{kind:'standalone',path:to}
    await options.worldbookResources().movePath(source,target)
    await options.rollbackBindings.movePath(from,to)
  }
`
  value=once(value,'  async function remove(relative) {',helper+'  async function remove(relative) {')
  value=once(value,"    })\n  }\n\n  async function renameResource(relative, requestedName)","    })\n    await moveSqlResource(normalized,null)\n  }\n\n  async function renameResource(relative, requestedName)")
  value=once(value,'      return { oldPath, path: newPath, scriptOldPath, scriptPath }','      await moveSqlResource(oldPath,newPath)\n      return { oldPath, path: newPath, scriptOldPath, scriptPath }')
  return once(value,'\n    return { oldPath, path: newPath, scriptOldPath, scriptPath }','\n    await moveSqlResource(oldPath,newPath)\n    return { oldPath, path: newPath, scriptOldPath, scriptPath }')
 }
 if(source.includes(MARKER))return copyConsumers(retireGuards(source))
 let next=MARKER+'\n'+source
 next=once(next,"  const worldBookBindingsPath = path.join(dataRoot, '.worldbook-bindings.json')",'  const bindingBefore=new WeakMap()')
 // 只替换读/写两函数；不吞作者新增全局选择/串行消费者。
 const start=next.indexOf('  async function readWorldBookBindings()'),writeAt=next.indexOf('  async function writeWorldBookBindings(',start)
 const end=next.indexOf('\n  async function ',writeAt+10)
 if(start<0||end<start)throw Error('世界书绑定函数边界缺失')
 next=next.slice(0,start)+`  async function readWorldBookBindings(){
    const current=await options.rollbackBindings.read()
    bindingBefore.set(current,structuredClone(current));return current
  }
  async function writeWorldBookBindings(bindings,owner){
    const expected=bindingBefore.get(bindings)
    if(expected===undefined)throw new Error('世界书绑定写入未经过确切SQL读取')
    return options.rollbackBindings.save(bindings,expected,owner)
  }
`+next.slice(end)
 if(next.includes('  async function setGlobalWorldBook(relative, enabled)'))next=once(next,'  async function setGlobalWorldBook(relative, enabled)','  async function setGlobalWorldBook(relative, enabled, owner)')
 for(const name of ['bindWorldBook','bindWorldBooks','unbindWorldBook']){
  const signature=name==='bindWorldBook'?'cardPath, locator':name==='bindWorldBooks'?'cardPath, sources':'cardPath'
  next=once(next,'async function '+name+'('+signature+')','async function '+name+'('+signature+', owner)')
 }
 next=next.replaceAll('await writeWorldBookBindings(bindings)','await writeWorldBookBindings(bindings,owner)')
 next=next.replaceAll('      if (worldBookBindingsChanged) await plan.write(worldBookBindingsPath, JSON.stringify(worldBookBindings, null, 2))','')
 next=next.replaceAll('        await plan.write(worldBookBindingsPath, JSON.stringify(bindings, null, 2))',"        throw new Error('禁止世界书绑定写回文件journal')")
 return copyConsumers(retireGuards(next))
}
function retireBindingCalculations(value){
 // 两个作者文件journal消费者已交SQL movePath；删除无写口的重复整表计算。
 if(value.includes('// [dsh-tavern-retired-binding-calculations:v1]'))return value
 for(const [startAnchor,endAnchor] of [
  ['    let worldBookBindings = null',"    await mutations.run('remove-resource:"],
  ['    const worldBookBindings = await readWorldBookBindings()',"    await mutations.run('rename-resource:"]
 ]){
  const start=value.indexOf(startAnchor),end=value.indexOf(endAnchor,start)
  if(start<0||end<start)throw Error('文件journal废弃绑定计算边界缺失')
  value=value.slice(0,start)+value.slice(end)
 }
 return '// [dsh-tavern-retired-binding-calculations:v1]\n'+value
}
function copyConsumers(value){
 value=retireBindingCalculations(value)
 if(value.includes('// [dsh-tavern-resource-copy-sql:v1]'))return value
 value="import { isDeepStrictEqual as resourceSqlEqual } from 'node:util'\n"+value
 value=value.replace("    return Promise.reject(new Error('SQL资源身份生命周期尚未接管，禁止文件层MVU转换复制与绑定'))\n",'')
 const helpers=`  // [dsh-tavern-resource-copy-sql:v1] 文件仅供新资源首次种子；复制/转换读当前SQL，已有运行值不复写。
  function cardDataSql(document){const raw=document.raw || document;return ['chara_card_v2','chara_card_v3'].includes(raw.spec)&&raw.data?raw.data:raw}
  async function seedCardSql(relative,document){
    const data=cardDataSql(document)
    await options.characterVariables.read(relative,data.extensions?.tavern_helper?.variables || {})
    await options.worldbookResources().read({kind:'card',cardPath:relative},data.character_book ?? null)
  }
  async function projectResourceSql(relative,text){
    if(text===undefined)return text
    const kind=resourceKind(relative)
    if(kind==='worldbook'){const document=await options.worldbookResources().read({kind:'standalone',path:relative},()=>JSON.parse(text));return JSON.stringify(document,null,2)}
    if(kind!=='card')return text
    const document=JSON.parse(text),data=cardDataSql(document),before=structuredClone(data)
    data.extensions ||= {};data.extensions.tavern_helper ||= {}
    data.extensions.tavern_helper.variables=await options.characterVariables.read(relative,data.extensions.tavern_helper.variables || {})
    data.character_book=await options.worldbookResources().read({kind:'card',cardPath:relative},data.character_book ?? null)
    return resourceSqlEqual(before,data)?text:JSON.stringify(document,null,2)
  }
`
 value=once(value,'  async function readText(relative) {',helpers+'  async function readText(relative) {')
 value=once(value,"    return value === undefined ? undefined : value.toString('utf8')","    return projectResourceSql(normalizeResourcePath(relative),value === undefined ? undefined : value.toString('utf8'))")
 // 旧MVU入口的四处变换只对确实存在 saveMvuCard 的作者源执行：新一代已完整删除该入口，
 // 无旧入口时不得凭空插入，也不得把缺失忽略成成功（缺入口=该代无此API，与锚点漂移必须区分）。
 // 半缺（有入口但任一MVU锚点数量不为1）与重复入口均拒绝，不做catchcontinue、不造通用parser。
 const mvuEntries=value.split('  function saveMvuCard(').length-1
 if(mvuEntries>1)throw Error('saveMvuCard旧入口重复：'+mvuEntries)
 const mvuAnchors=[
  ['      if (finalize) finalize(saved)',`      if(expectedTargetText!==undefined){
        const before=cardDataSql(JSON.parse(expectedTargetText)),after=cardDataSql(saved)
        if(!resourceSqlEqual(before.extensions?.tavern_helper?.variables || {},after.extensions?.tavern_helper?.variables || {})||!resourceSqlEqual(before.character_book ?? null,after.character_book ?? null))throw new Error('已有MVU副本跨文件/SQL运行值修改尚不支持原子提交；请用新名称转换，未写入任何改动')
      }
      if (finalize) finalize(saved)`],
  ["        throw new Error('禁止世界书绑定写回文件journal')",''],
  ['      const text = JSON.stringify(saved, null, 2)\n      const bindings = await readWorldBookBindings()',`      const published=clone(saved)
      if(expectedTargetText!==undefined){const data=cardDataSql(published);if(data.extensions?.tavern_helper)delete data.extensions.tavern_helper.variables;data.character_book=data.character_book===null?null:{entries:[]}}
      const text = JSON.stringify(published, null, 2)
      const bindings = await readWorldBookBindings()`],
  ['      return { path: target, changed: result.changed, imageCopied: !!image }','      await seedCardSql(target,saved)\n      await writeWorldBookBindings(bindings)\n      return { path: target, changed: result.changed, imageCopied: !!image }']
 ]
 const present=mvuAnchors.map(function(entry){return value.split(entry[0]).length-1})
 if(mvuEntries===1){
  for(let i=0;i<mvuAnchors.length;i++)if(present[i]!==1)throw Error('旧saveMvuCard入口存在但MVU锚点缺失/不唯一（第'+(i+1)+'处='+present[i]+'）：'+mvuAnchors[i][0])
  for(const [old,next] of mvuAnchors)value=once(value,old,next)
 }else if(present.some(function(count){return count!==0})){
  throw Error('旧saveMvuCard入口已删除但残留MVU专用锚点（形态漂移）：'+JSON.stringify(present))
 }
 return once(value,'      return { path: target, sourcePath: source, imageCopied: !!image }','      await seedCardSql(target,saved)\n      return { path: target, sourcePath: source, imageCopied: !!image }')
}
export function applyRollbackWorldbookBindingsHostTransform(source){
 const connect=value=>value.replace('createFileResourceStore({ dataRoot, rollbackBindings:rollbackWorldbookBindings })','createFileResourceStore({ dataRoot, rollbackBindings:rollbackWorldbookBindings, characterVariables:characterVariableStore, worldbookResources:()=>rollbackWorldbookResources })')
 source=source.replace("  // [dsh-tavern-resource-lifecycle-guard:v1] 文件资源图写意图之前拒绝，不留下永远无法执行的journal。\n  function assertSqlResourceLifecycle(resourcePath){const kind=resourceKind(resourcePath);if(kind==='card'||kind==='worldbook')throw new Error('SQL资源身份生命周期尚未接管，禁止文件层改名或删除')}\n",'').replace('assertSqlResourceLifecycle(resourcePath);','').replace('    assertSqlResourceLifecycle(resourcePath)\n','')
 if(source.includes(MARKER))return connect(source)
 let next="import { createRollbackWorldbookBindings } from './domain/storage-rollback-business.js'\n"+MARKER+'\n'+source
 next=once(next,'  const fileResources = createFileResourceStore({ dataRoot })',`  const rollbackWorldbookBindings=createRollbackWorldbookBindings({dataRoot,profileData})
  ctx.effect(()=>()=>rollbackWorldbookBindings.dispose(),'dsh-tavern: 世界书绑定SQL释放')
  const fileResources = createFileResourceStore({ dataRoot, rollbackBindings:rollbackWorldbookBindings })`)
 return connect(once(next,'versions, await rollbackWorldbookResources.version(),','versions, await rollbackWorldbookBindings.version(), await rollbackWorldbookResources.version(),'))
}
