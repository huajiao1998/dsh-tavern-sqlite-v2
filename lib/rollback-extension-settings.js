// 复用逐键SQL当前值存储；实际设置契约必须提供expected，不改变跨窗口合并语义。
import {createRollbackGlobalVariables} from './rollback-global-variables.js'
export function createRollbackExtensionSettings(options){
 const store=createRollbackGlobalVariables({...options,databaseName:'tavern-extension-settings.db',legacyName:'tavern-extension-settings.json',legacyField:null})
 return Object.freeze({...store,save:(settings,expected,owner)=>{
  if(expected===undefined)return Promise.reject(new Error('插件设置保存缺少读取基准'))
  return store.save(settings,expected,owner)
 }})
}
