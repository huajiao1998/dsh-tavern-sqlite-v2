// 世界书绑定逐卡SQL权威；保留作者单书/多书/默认/none的配置语义，不存整表文档。
import {createRollbackGlobalVariables,validateRollbackJsonObject} from './rollback-global-variables.js'
function path(value,prefix){
 if(typeof value!=='string'||!value.startsWith(prefix)||value.includes('\\')||value.includes('\0')||value.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('世界书绑定资源路径不合法')
 return value.normalize('NFC')
}
function validate(bindings){
 validateRollbackJsonObject(bindings)
 for(const [card,value] of Object.entries(bindings)){
  if(card==='$global'){
   if(value?.version!==2||!Array.isArray(value.sources)||Object.keys(value).some(key=>!['version','sources'].includes(key)))throw Error('全局世界书绑定配置不合法')
   const seen=new Set()
   for(const source of value.sources){if(source?.kind!=='standalone'||Object.keys(source).some(key=>!['kind','path'].includes(key)))throw Error('全局世界书只允许独立来源');const key=path(source.path,'worldbooks/');if(seen.has(key))throw Error('全局世界书来源重复');seen.add(key)}
   continue
  }
  path(card,'cards/')
  if(value===null)continue
  if(typeof value==='string'){path(value,'worldbooks/');continue}
  if(value?.kind==='embedded'){path(value.cardPath,'cards/');continue}
  if(value?.version===2&&Array.isArray(value.sources)){
   const seen=new Set()
   for(const source of value.sources){const key=source?.kind==='embedded'?'card:'+path(source.cardPath,'cards/'):source?.kind==='standalone'?'book:'+path(source.path,'worldbooks/'):undefined;if(!key||seen.has(key))throw Error('世界书绑定来源类型错误或重复');seen.add(key)}
   continue
  }
  throw Error('世界书绑定配置不合法')
 }
 return bindings
}
export function createRollbackWorldbookBindings({dataRoot,profileData,archiveForChat}){
 const sql=createRollbackGlobalVariables({dataRoot,archiveForChat,profileData:{readJson:async name=>{const legacy=await profileData.readJson(name);return legacy===undefined?undefined:validate(legacy)},remove:name=>profileData.remove(name)},databaseName:'worldbook-bindings.db',legacyName:'.worldbook-bindings.json',legacyField:null})
 return {...sql,
  movePath:async(from,to)=>{
   const kind=from.startsWith('cards/')?'card':'standalone';path(from,kind==='card'?'cards/':'worldbooks/');if(to!==null)path(to,kind==='card'?'cards/':'worldbooks/')
   const before=await sql.read(),next=structuredClone(before)
   if(kind==='card'&&Object.hasOwn(next,from)){if(to!==null){if(Object.hasOwn(next,to))throw Error('SQL绑定目标已存在，拒绝覆盖');next[to]=next[from]}delete next[from]}
   for(const [card,value] of Object.entries(next)){
    if(typeof value==='string'&&kind==='standalone'&&value===from)next[card]=to
    else if(value?.kind==='embedded'&&kind==='card'&&value.cardPath===from)next[card]=to===null?null:{kind:'embedded',cardPath:to}
    else if(value?.version===2)next[card]={...value,sources:value.sources.flatMap(source=>{const key=source.kind==='embedded'?'cardPath':'path';return source[key]!==from?[source]:to===null?[]:[{...source,[key]:to}]})}
   }
   validate(next);return sql.save(next,before)
  },save:(next,expected,owner)=>{validate(next);if(expected===undefined)throw Error('世界书绑定写入缺少确切读取前态');validate(expected);return sql.save(next,expected,owner)}}
}
