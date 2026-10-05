// 外部世界书按头字段和entry拆行；保SQL当前权威和完整读取前态CAS，不参与剧情撤销。
import {createRollbackGlobalVariables,validateRollbackJsonObject} from './rollback-global-variables.js'
function identity(source){
 const kind=source?.kind,path=kind==='card'?source.cardPath:source?.path,prefix=kind==='card'?'cards/':'worldbooks/'
 if(!['card','standalone'].includes(kind)||typeof path!=='string'||!path.startsWith(prefix)||path.includes('\\')||path.includes('\0')||path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('世界书SQL资源身份不合法')
 return JSON.stringify([kind,path.normalize('NFC')])
}
function rows(document){
 if(document===null)return {'document-kind':'null'}
 validateRollbackJsonObject(document)
 if(!document||typeof document!=='object'||Array.isArray(document)||!document.entries||typeof document.entries!=='object')throw Error('世界书SQL文档必须含entries')
 const result={}
 for(const [key,value] of Object.entries(document))if(key!=='entries'){
  // 作者导出携带转换前整书originalData，不能把它作为一个大JSON行暗存。
  if(key==='originalData'&&value?.entries&&typeof value.entries==='object'){for(const [nested,entry] of Object.entries(rows(value)))result['original:'+nested]=entry}
  else result['field:'+key]=value
 }
 result['entries-kind']=Array.isArray(document.entries)?'array':'object'
 for(const [key,value] of Object.entries(document.entries))result['entry:'+key]=value
 return result
}
function document(rows){
 if(rows['document-kind']==='null')return null
 const result=Object.fromEntries(Object.entries(rows).filter(([key])=>key.startsWith('field:')).map(([key,value])=>[key.slice(6),value]))
 const entries=Object.entries(rows).filter(([key])=>key.startsWith('entry:')).map(([key,value])=>[key.slice(6),value])
 result.entries=rows['entries-kind']==='array'?entries.sort((a,b)=>Number(a[0])-Number(b[0])).map(([,value])=>value):Object.fromEntries(entries)
 const original=Object.fromEntries(Object.entries(rows).filter(([key])=>key.startsWith('original:')).map(([key,value])=>[key.slice(9),value]))
 if(Object.keys(original).length)result.originalData=document(original)
 return result
}
export function createRollbackWorldbookResources({dataRoot,archiveForChat}){
 const sql=createRollbackGlobalVariables({dataRoot,archiveForChat,databaseName:'worldbook-resources.db',legacyName:null})
 return {...sql,
  movePath:(from,to)=>sql.moveScope(identity(from),to===null?null:identity(to)),
  read:async(source,seed)=>{
   const scope=identity(source);let current=await sql.readScope(scope)
   if(current===undefined){if(seed===undefined)throw Error('世界书SQL缺少确切资源种子');const initial=typeof seed==='function'?await seed():seed;await sql.seedScope(scope,rows(initial));current=await sql.readScope(scope)}
   return document(current)
  },
  save:async(source,next,expected,owner)=>{
   const scope=identity(source)
   if(await sql.readScope(scope)===undefined)throw Error('世界书SQL缺少初始化前态')
   if(expected===undefined)throw Error('世界书SQL写入必须提供读取前态')
   return document(await sql.save(rows(next),rows(expected),owner,scope))
  }
 }
}
