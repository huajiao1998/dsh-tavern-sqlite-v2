// ⚠ 部署件：把本文件内容**整份写入**作者树 <tavern-plugin>/lib/domain/read-variables.js
//
// 真实现已移到 dsh-tavern-sqlite-v2（`lib/read-variables.js`，md5 与原现网一致）。
// 作者树的 import 形状**不变**（index.js:3）：
//     import {registerVariableReadTool} from './domain/read-variables.js'
//
// 卸载语义：这是**功能本体**（变量查询 + agent 工具注册）⇒ 缺包时**响亮抛错**，不做静默空实现。
let impl = null
try {
  impl = await import('dsh-tavern-sqlite-v2/read-variables')
} catch (error) {
  console.error('[read-variables] 未能加载 dsh-tavern-sqlite-v2/read-variables：' + String(error?.message || error))
}

export function readVariables(chat, args) {
  if (impl === null) throw new Error('未安装 dsh-tavern-sqlite-v2：变量查询不可用')
  return impl.readVariables(chat, args)
}

export function registerVariableReadTool(options) {
  if (impl === null) throw new Error('未安装 dsh-tavern-sqlite-v2：变量查询工具无法注册')
  return impl.registerVariableReadTool(options)
}