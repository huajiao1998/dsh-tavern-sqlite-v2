// 原生开场只提交元数据：异步flush前捕获真实header基线，复用作者字段CAS合并，绝不伪造历史revision。
import { replaceOnce } from './upstream-compute-transform.mjs'
export const OPENING_COMMIT_MARKER = '// [dsh-tavern-opening-header-commit:v1]'
export function applyOpeningCommitHostTransform(source) {
  return replaceOnce(source,
    '    chats: { resolve: chatForSession, publish: conversationRegistry.publish, write: writeChat },',
    '    chats: { resolve: chatForSession, publish: conversationRegistry.publish, write: writeChat, writeHeader: writeChatHeader },')
}
export function applyOpeningCommitTransform(source) {
  if (source.includes(OPENING_COMMIT_MARKER)) {
    for (const required of ['const openingBaseline = captureChatHeader(chat)', "await chats.writeHeader(draft, openingBaseline, { source: 'opening.native-append' })", 'const committed = draft']) {
      if (!source.includes(required)) throw new Error('开场字段提交标记存在但实现不完整：' + required)
    }
    return source
  }
  let next = "import { captureChatHeader } from './chat-persistence.js'\n" + OPENING_COMMIT_MARKER + '\n' + source
  next = replaceOnce(next, '    if (chat.nativeOpeningAppended === true) return',
    '    if (chat.nativeOpeningAppended === true) return\n    const openingBaseline = captureChatHeader(chat)')
  next = replaceOnce(next,
    "    const saved = await chats.write(draft, { source: 'opening.native-append' })\n    const committed = saved && typeof saved === 'object' ? saved : draft",
    "    await chats.writeHeader(draft, openingBaseline, { source: 'opening.native-append' })\n    // writeHeader返回header；完整已刷新草稿才可回填，不能用header删除messages。\n    const committed = draft")
  return next
}
