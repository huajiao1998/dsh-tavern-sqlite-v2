// 人物变量权威按卡路径+变量键拆行；角色定义只是首次种子，业务写不再落卡文件。
import {createRollbackGlobalVariables} from './rollback-global-variables.js'
const cardPath=value=>{
 if(typeof value!=='string'||!value.startsWith('cards/')||value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..')||value.includes('\0'))throw Error('人物变量卡路径不合法')
 return value.normalize('NFC')
}
export function createRollbackCharacterVariables({dataRoot,archiveForChat}){
 const sql=createRollbackGlobalVariables({dataRoot,archiveForChat,databaseName:'character-variables.db',legacyName:null})
 return {...sql,
  movePath:(from,to)=>sql.moveScope(cardPath(from),to===null?null:cardPath(to)),
  read:async(path,seed)=>{
   const key=cardPath(path),current=await sql.readScope(key)
   if(current!==undefined)return current
   if(seed===undefined)throw Error('人物变量尚未初始化，必须由确切人物卡读口提供种子')
   await sql.seedScope(key,seed);return sql.readScope(key)
  },
  save:async(path,variables,owner,expected)=>{
   const key=cardPath(path)
   if(await sql.readScope(key)===undefined)throw Error('人物变量尚未初始化，禁止猜测写前态')
   return sql.save(variables,expected,owner,key)
  }
 }
}
