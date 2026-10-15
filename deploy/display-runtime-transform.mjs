// 新酒馆完整iframe诊断改接本档SQL；回执/去重/读取工具保作者消费者，不写整档JSON。
const MARK = '// [dsh-tavern-display-runtime-sql:v1]'
const INIT = '  const displayRuntimeStore = createDisplayRuntimeStore({ store: profileData })'
const NEXT = `  ${MARK}
  // 方法运行时才读取chatJournalStore；作者实例声明早于Chat存储装配。
  const displayRuntimeStore = Object.freeze({
    read: async (...args) => chatJournalStore.displayRuntime.read(...args),
    recent: async (...args) => chatJournalStore.displayRuntime.recent(...args),
    mergeFrame: (...args) => chatJournalStore.displayRuntime.mergeFrame(...args),
    remove: (...args) => chatJournalStore.displayRuntime.remove(...args)
  })`
const MERGE = 'await displayRuntimeStore.mergeFrame(chat.id, turn, frame, { reset: !receipt, sourceActivityAt, seed: inline && Array.isArray(inline.frames) ? inline.frames : [] })'
const GUARDED = 'if (!await displayRuntimeStore.mergeFrame(chat.id, turn, frame, { revision: chat._storageRevision, messageIndex: chat.messageIndex, reset: !receipt, sourceActivityAt, seed: inline && Array.isArray(inline.frames) ? inline.frames : [] })) continue'
function once(source, old, next) {
  if (source.split(old).length !== 2) throw Error('iframe诊断SQL锚点缺失或重复：' + old.slice(0, 100))
  return source.replace(old, next)
}
export function applyDisplayRuntimeTransform(source) {
  if (source.includes(MARK)) {
    if (source.split(MARK).length !== 2 || !source.includes(NEXT) || !source.includes(GUARDED)) throw Error('iframe诊断SQL接线不完整')
    return source
  }
  // 旧酒馆没有外置接口，原行内行为不变；出现任一新接口却缺另一项必须拒绝。
  if (!source.includes('displayRuntimeStore')) return source
  return once(once(source, INIT, NEXT), MERGE, GUARDED)
}
