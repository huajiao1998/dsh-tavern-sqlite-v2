// ⚠ 部署件：把本文件内容**整份写入**作者树 <tavern-plugin>/lib/domain/conversation-fork-point.js
//
// 真实现已 fork 进 dsh-tavern-sqlite-v2（`lib/conversation-fork-point.js`，唯一差异 = A4a 关闭历史回溯）。
// 作者树的公开面不变（index.js:41）：conversationStateAtTurn / conversationForkBoundary。
//
// 依赖注入（DI）：把作者的 4 个工具注入我们包的 fork —— 语义必须与作者其它代码同一份实现。
// 卸载语义：缺包时**调用即响亮抛错**（模块本身仍能加载 ⇒ 酒馆不会因此起不来，只是分叉功能不可用）。
import { isRescuedHistoryMessage } from './chat-history-rescue.js'
import { assistantResultForTurn } from './session-turn-result.js'
import { sessionEvents } from './session-events.js'
import { assertConversationForkable } from './conversation-fork.js'

let impl = null
try {
  impl = await import('dsh-tavern-sqlite-v2/conversation-fork-point')
  impl.configureConversationForkPoint({ isRescuedHistoryMessage, assistantResultForTurn, sessionEvents, assertConversationForkable })
} catch (error) {
  console.error('[conversation-fork-point] 未能加载 dsh-tavern-sqlite-v2/conversation-fork-point：' + String(error?.message || error))
}

function unavailable() {
  throw new Error('未安装 dsh-tavern-sqlite-v2：分叉点计算不可用')
}

export const conversationStateAtTurn = impl === null ? unavailable : impl.conversationStateAtTurn
export const conversationForkBoundary = impl === null ? unavailable : impl.conversationForkBoundary