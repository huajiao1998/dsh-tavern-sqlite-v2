// V2本档历史书引用只接到时间线恢复及物理回退，不改模型/Helper当前书接口。
const MARKER='// [dsh-tavern-worldbook-history-host:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('本档书历史接线锚点未命中/不唯一：'+old);return source.replace(old,next)}
export function applyRollbackWorldbookHistoryHostTransform(source){
 if(source.includes(MARKER)){
  if(!source.includes('readRollbackWorldbook: (chat, ref) => chatJournalStore.readRollbackWorldbook(chat, ref), readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef(chat)') || !source.includes('readRollbackWorldbook: chatJournalStore.readRollbackWorldbook'))throw Error('本档书历史接线标记不完整')
  return source
 }
 let next=MARKER+'\n'+source
 next=once(next,'createStoryTimeline({ id: uid, now: Date.now })','createStoryTimeline({ id: uid, now: Date.now, readRollbackWorldbook: (chat, ref) => chatJournalStore.readRollbackWorldbook(chat, ref), readRollbackWorldbookRef: chat => chatJournalStore.readCurrentRollbackWorldbookRef(chat) })')
 return once(next,'rollbackArchivePath: chatJournalStore.rollbackArchivePath },','rollbackArchivePath: chatJournalStore.rollbackArchivePath, readRollbackWorldbook: chatJournalStore.readRollbackWorldbook },')
}
