// ⚠ 部署件：把本文件内容**整份写入**作者树 <tavern-plugin>/lib/domain/variable-sqlite-store.js
//
// 真实现已移到 dsh-tavern-sqlite-v2/variable-store（我们的模块：变量 SQLite 一档一库
// chats/<id>/variables.db + 快照链 + 瘦身 2.0）。作者树里只留这一层转出，
// **index.js 的 import 一个字都不用改**（它仍 `import { createVariableSqliteStore } from './domain/variable-sqlite-store.js'`）。
//
// 卸载语义：这是**存储本体**（变量丢了就没法玩）⇒ 未安装本包时**响亮失败**，不静默降级。
let impl = null
try {
  impl = await import('dsh-tavern-sqlite-v2/variable-store')
} catch (error) {
  console.error('[variable-sqlite-store] 未能加载 dsh-tavern-sqlite-v2/variable-store：' + String(error?.message || error))
}

export function createVariableSqliteStore(options) {
  if (impl === null) {
    throw new Error('未安装 dsh-tavern-sqlite-v2：变量存储(SQLite)不可用。请先安装该插件，或按卸载流程恢复作者原实现。')
  }
  return impl.createVariableSqliteStore(options)
}