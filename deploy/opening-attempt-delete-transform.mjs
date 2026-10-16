// 用户明确删除成功后，只清对应Session的待完成开局；不删其他尝试、不改预设或自动重开。
import { replaceOnce } from './upstream-compute-transform.mjs'
export const OPENING_ATTEMPT_DELETE_MARKER = '// [dsh-tavern-opening-attempt-delete:v1]'
const ORIGINAL = '\t\t\t\t\tawait call("deleteChat", { chatId: item.chatId });'
const CLEANUP = '\t\t\t\t\tstartAttemptsRef.current.complete(item.sessionId);'
export function applyOpeningAttemptDeleteTransform(source) {
  // 老作者没有持久开局attempt，不给其注入不存在的服务；已有此能力则锚点异常须拒绝。
  if (!source.includes('createConversationAttemptStore(window.localStorage)')) return source
  if (source.includes(OPENING_ATTEMPT_DELETE_MARKER)) {
    if (source.split(OPENING_ATTEMPT_DELETE_MARKER).length !== 2 || !source.includes(ORIGINAL + '\n\t\t\t\t\t' + OPENING_ATTEMPT_DELETE_MARKER + '\n' + CLEANUP)) throw Error('开局删除清理接缝实现不完整')
    return source
  }
  return replaceOnce(source, ORIGINAL, ORIGINAL + '\n\t\t\t\t\t' + OPENING_ATTEMPT_DELETE_MARKER + '\n' + CLEANUP, '删除对话成功后清理对应开局attempt')
}
