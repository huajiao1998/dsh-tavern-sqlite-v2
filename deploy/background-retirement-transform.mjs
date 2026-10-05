// 仅退役无任务尾、无当前引用的旧酒馆worker发现记录；不删日志/不改剧情回退。
const MARKER='// [dsh-tavern-v1-empty-worker-discovery:v1]'
const HOST_MARKER='// [dsh-tavern-v1-empty-worker-reader:v1]'
function once(s,a,b){if(s.split(a).length!==2)throw Error('空后台退役锚点缺失/不唯一：'+a.slice(0,100));return s.replace(a,b)}
const SIGNATURE='export function createBackgroundSessionRetirement(store, { readState, isRunning } = {}) {'
const SIGNATURE_NEXT='export function createBackgroundSessionRetirement(store, { readState, isRunning, readEmptyIdentity } = {}) {'
const ANCHOR='          for (const op of operations) {'
const BLOCK=`          ${MARKER}
          if (readEmptyIdentity) {
            const references = new Set(Object.values(chat.timeline.participants || {}).map(p=>p?.sessionId));
            for (const op of operations) {references.add(op.startedSessionId);references.add(op.participant?.sessionId);}
            for (const checkpoint of chat.timeline.checkpoints || []) for (const p of Object.values(checkpoint.participants || {})) references.add(p?.sessionId);
            for (const row of rows) {
              if (row.kind !== 'child' || (row.parentId || parentId) !== owner || references.has(row.id)
                || row.activity === 'running' || row.hasChildren === true || isRunning?.(row.id) === true || retired[row.id]) continue;
              try {
                if (await readEmptyIdentity(row.id, owner)) Object.defineProperty(retired,row.id,{value:{parentId:owner},enumerable:true,configurable:true});
              } catch (_) { /* 无法证明身份/纯初始化就保持可见，不猜、不删除。 */ }
            }
          }
${ANCHOR}`
export function applyBackgroundRetirementTransform(s){
 if(s.includes(MARKER)){if(!s.includes(SIGNATURE_NEXT)||s.split(BLOCK).length!==2)throw Error('空后台退役标记不完整');return s}
 return once(once(s,SIGNATURE,SIGNATURE_NEXT),ANCHOR,BLOCK)
}
const HOST="  const backgroundRetirement = createBackgroundSessionRetirement(profileData, { readState: taskStateReader.forSession, isRunning: id => agentRegistry.get(id)?.status === 'running' })"
const HOST_NEXT=`  ${HOST_MARKER}
  const backgroundRetirement = createBackgroundSessionRetirement(profileData, { readState: taskStateReader.forSession, isRunning: id => agentRegistry.get(id)?.status === 'running',
    readEmptyIdentity: async (id,parentId) => {
      const persistence=ctx.get('sessionPersistence'), info=await persistence.stat(id);
      if (info.eventCount !== 4 || info.header?.parentSession !== parentId || info.header?.origin !== 'subagent') return false;
      // 先header/count筛选，只读四条初始化；不对有任务的worker读整日志，不观察/恢复Agent。
      const stored=await persistence.requireStoredLog(id), events=stored.events;
      if (stored.meta?.parentSession !== parentId || stored.meta?.origin !== 'subagent' || !Array.isArray(events) || events.length !== 4) return false;
      const kinds=['permission/preset','sandbox/mode','approval/policy','subagent/descriptor'];
      if (events.some((e,i)=>e.seq!==i || e.type!==kinds[i])) return false;
      return events[3].data?.provider === 'dsh-tavern-background-tools-v4' && events[3].data?.mode === 'continuable';
    }
  })`
export function applyBackgroundRetirementHostTransform(s){
 if(s.includes(HOST_MARKER)){if(s.split(HOST_NEXT).length!==2)throw Error('空后台读口标记不完整');return s}
 return once(s,HOST,HOST_NEXT)
}
