// ⚠ 部署件：把本文件内容**整份写入**作者树 <tavern-plugin>/lib/domain/chat-sqlite-store.js
//    （替换我们此前放进作者树的实现；真实现已移到 dsh-tavern-sqlite-v2）
//
// 作用：把作者的模块注入我们包的实现 ——
//   · 真代码（v3 逐键/逐索引增量写 + L1 结构化脱离 + fail-loud 自检 + v1/v2 迁移）在**我们包里**，
//     上游更新碰不到；
//   · 投影与 JSON 工具仍是**作者那一份**（与作者其它代码同实现，不会出现两套投影分叉）。
//
// 卸载语义：本文件是**存储本体**（不是辅助层）⇒ 未安装本包时**响亮失败**，不静默降级
//   （降级 = 聊天存档写不进去，风险远大于报错）。要回到"原存档"须按卸载流程放回作者原实现。
//
// 作者应用树与数据 plugins 不在同一解析祖先链；统一经 storage-package 定位，不能裸导入本包。

import { copyJsonTree } from './copy-json-tree.js'
import { projectSceneImageState, projectChatSessionState, projectDisplayRuntimeState, projectChatBackgroundConfig, projectSettlementCheckpoint, projectSessionMessage } from './chat-session-state.js'
import { applyJsonChangesShared, diffJson } from './json-mutation.js'
// 作者 2.4 新读协议（readWindow / readHelperContext / readSettlementBase）的**协议投影**：
// 必须注入作者那一份（tavern-helper-context.js / scoped-messages.js），否则 Helper 上下文与结算基座会分叉出第二套投影。
// 缺了由包内**调用期**响亮失败 —— 不在构造期检查，只注 8 项的历史调用方不受影响。
import { projectTavernHelperMessage, projectTavernHelperContext, lastTavernHelperVariables } from './tavern-helper-context.js'
import { projectAgentMessageText } from './runtime-content-projection.js'
import * as scopedMessageHelpers from './scoped-messages.js'
const { createScopedMessages, isScopedMessages } = scopedMessageHelpers
import { copyLazyHistoryHeader } from './lazy-history-read.js'

const helpers = {
  copyJsonTree, diffJson, applyJsonChangesShared,
  projectSceneImageState, projectChatSessionState, projectDisplayRuntimeState,
  projectChatBackgroundConfig, projectSettlementCheckpoint,
  projectTavernHelperMessage, projectTavernHelperContext, lastTavernHelperVariables, projectAgentMessageText, createScopedMessages, isScopedMessages, projectSessionMessage, copyLazyHistoryHeader,
}

// 标准目录与其他作者薄垫片统一解析到同一份实现；缺包直接失败，不降级原档可写。
import { storagePackage } from './storage-package.js'
const impl = await storagePackage('chat-store')

// 作者对话迁移契约适配（见 lib/author-migration-adapter.js 的缺陷 C 说明）：
// 与 chat-store 同样经 storage-package 定位，不能写裸说明符。
// 它只被 S2(d) 迁移缝用到 ⇒ 加载不到不冒泡到模块顶层，缺包在调用期响亮失败。
let migrationImpl = null
try {
  migrationImpl = await storagePackage('author-migration-adapter')
} catch (error) {
  console.error('[chat-sqlite-store] 未能加载 dsh-tavern-sqlite-v2/author-migration-adapter：' + String(error?.message || error))
}

export function createChatSqliteStore(options = {}) {
  if (impl === null) {
    throw new Error('未安装 dsh-tavern-sqlite-v2：聊天存档(SQLite)不可用。请先安装该插件，或按卸载流程恢复作者原实现。')
  }
  return impl.createChatSqliteStore({ ...options, helpers })
}

// 给作者 createConversationMigration({ store }) 的作者存储契约包一层适配（缺陷 C）。
// 不改变我们自己的 version() 值域——那套判据被分叉/守卫/缓存键共同依赖。
export function wrapAuthorMigrationStore(store) {
  if (migrationImpl === null) {
    throw new Error('未安装 dsh-tavern-sqlite-v2/author-migration-adapter：作者对话迁移契约适配不可用。请先安装该插件，或按卸载流程恢复作者原实现。')
  }
  return migrationImpl.wrapAuthorMigrationStore(store)
}
