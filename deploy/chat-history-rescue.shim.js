// ⚠ 部署件：把本文件内容**整份写入**作者树 <tavern-plugin>/lib/domain/chat-history-rescue.js
//
// 真实现已 fork 进 dsh-tavern-sqlite-v2（`lib/chat-history-rescue.js`，唯一差异 = ④ 允许字符串 schema）。
// 该文件**零相对依赖** ⇒ 无需 DI（比 fork-point 更简单）。
//
// 作者树的公开面（5 个引用者要的 4 个符号，形状不变）：
//   rescueHistoryInput / isRescuedHistoryMessage / assertRescueHistoryEditable / rescueHistoryNotice
//   引用者：index.js(rescueHistoryNotice) / rollback-surface.js / chat-session-state.js / round-history.js
//          / conversation-fork-point.js / chat-history-import-service.js
//
// 卸载语义：这是**功能本体**（存档救援）⇒ 缺包时**调用即响亮抛错**（模块仍可加载）。
let impl = null
try {
  impl = await import('dsh-tavern-sqlite-v2/chat-history-rescue')
} catch (error) {
  console.error('[chat-history-rescue] 未能加载 dsh-tavern-sqlite-v2/chat-history-rescue：' + String(error?.message || error))
}

function unavailable() {
  throw new Error('未安装 dsh-tavern-sqlite-v2：存档救援不可用')
}

export const rescueHistoryInput = impl === null ? unavailable : impl.rescueHistoryInput
export const isRescuedHistoryMessage = impl === null ? unavailable : impl.isRescuedHistoryMessage
export const assertRescueHistoryEditable = impl === null ? unavailable : impl.assertRescueHistoryEditable
export const rescueHistoryNotice = impl === null ? unavailable : impl.rescueHistoryNotice