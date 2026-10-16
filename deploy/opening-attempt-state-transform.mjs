// 侧栏二状态：新开清旧游玩attempt，继续保留；放弃只清当前卡。只清浏览器记录，不删服务器会话。
import { replaceOnce } from './upstream-compute-transform.mjs'
export const OPENING_ATTEMPT_STORE_MARKER = '// [dsh-tavern-opening-attempt-store:v1]'
export const OPENING_ATTEMPT_STATE_MARKER = '// [dsh-tavern-opening-attempt-state:v1]'
const STORE_ANCHOR = '                delete(key) { memory.delete(key); storage.removeItem(prefix + key); },'
const STORE_METHOD = `                ${OPENING_ATTEMPT_STORE_MARKER}
                discardPlay(cardPath) {
                    const keys = new Set(memory.keys());
                    for (let index = 0; index < storage.length; index++) {
                        const key = storage.key(index);
                        if (key && key.startsWith(prefix)) keys.add(key.slice(prefix.length));
                    }
                    for (const key of keys) {
                        let request;
                        try { request = JSON.parse(key); } catch (_) { continue; }
                        if (Array.isArray(request) && request[0] === "play" && (cardPath === undefined || request[2] === cardPath)) this.delete(key);
                    }
                },`
const OPEN_ANCHOR = '\t\t\tfunction openPicker() {'
const OPEN_IMPL = OPEN_ANCHOR + '\n\t\t\t\t' + OPENING_ATTEMPT_STATE_MARKER + '\n\t\t\t\tif (uiMode === "play" && !openingPicker) startAttemptsRef.current.discardPlay();'
const DISCARD_ANCHOR = '\t\t\t\tconst id = openingPicker && openingPicker.preparationId;\n\t\t\t\tplayPrewarmRef.current.cancel();'
const DISCARD_IMPL = '\t\t\t\tconst id = openingPicker && openingPicker.preparationId;\n\t\t\t\tif (openingPicker && openingPicker.card && openingPicker.card.path) startAttemptsRef.current.discardPlay(openingPicker.card.path);\n\t\t\t\tplayPrewarmRef.current.cancel();'
function requireOnce(source, fragment, label) {
  if (source.split(fragment).length !== 2) throw Error('开局二状态接缝实现不完整：' + label)
}
export function applyOpeningAttemptStateTransform(source) {
  let next = source
  if (source.includes('function createConversationAttemptStore(storage)')) {
    if (source.includes(OPENING_ATTEMPT_STORE_MARKER)) requireOnce(source, STORE_METHOD, '待开局清理方法')
    else next = replaceOnce(next, STORE_ANCHOR, STORE_ANCHOR + '\n' + STORE_METHOD, '待开局清理方法')
  }
  if (source.includes('createConversationAttemptStore(window.localStorage)')) {
    if (source.includes(OPENING_ATTEMPT_STATE_MARKER)) {
      requireOnce(source, OPEN_IMPL, '新开/继续分支'); requireOnce(source, DISCARD_IMPL, '确认放弃分支')
    } else {
      next = replaceOnce(next, OPEN_ANCHOR, OPEN_IMPL, '侧栏新开/继续分支')
      next = replaceOnce(next, DISCARD_ANCHOR, DISCARD_IMPL, '确认放弃后清当前卡')
    }
  }
  return next
}
