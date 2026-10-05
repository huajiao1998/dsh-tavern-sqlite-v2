// 后台每任务删尾：复用现有manager/Session逻辑resync，不伪造Chat回退回执、不关闭物理WS。
const MARKER='// [dsh-tavern-session-cut-sync-client:v1]'
const BRANCH=`                if (frame.type === "projection" && frame.key === "$dsh-tavern/session-cut-sync-v1") {
                    try { this.applyTavernSessionCut(frame.value).catch(error => console.error("后台截断同连接同步失败", error)); } catch (error) { console.error("后台截断同连接同步失败", error); }
                    return;
                }
`
const METHOD=`            applyTavernSessionCut(value) {
                if (value?.protocol !== 1 || typeof value.sessionId !== "string" || !value.sessionId || typeof value.parentSessionId !== "string" || !value.parentSessionId || !Number.isSafeInteger(value.asOfSeq) || value.asOfSeq < -1 || !value.values || typeof value.values !== "object" || !Array.isArray(value.queues) || !Array.isArray(value.jobs)) throw new Error("后台截断同步基线无效");
                const store = this.projectionStore(value.sessionId);
                store.tavernRollbackGeneration = (store.tavernRollbackGeneration ?? 0) + 1;
                for (const key of [...store.rows.keys()]) { store.rows.delete(key); store.changed(key); }
                store.seed({ asOfSeq: value.asOfSeq, values: value.values });
                this.queues.set(value.sessionId, value.queues);
                if (value.jobs.length) this.jobsBySession.set(value.sessionId, value.jobs); else this.jobsBySession.delete(value.sessionId);
                const session = this.sessions.get(value.sessionId);
                // status走另一逻辑流，可能新running已先到；不以旧空闲通知覆盖新状态/输入草稿。
                session?.replaceControl(value.queues);
                this.notifier.markDirty();
                return session ? session.resync() : Promise.resolve();
            }
`
function once(source,a,b){if(source.split(a).length!==2)throw Error('后台截断客户端锚点缺失/不唯一：'+a.slice(0,90));return source.replace(a,b)}
export function applySessionCutSyncClientTransform(source){
 if(source.includes(MARKER)){for(const text of [MARKER,BRANCH,METHOD])if(source.split(text).length!==2)throw Error('后台截断客户端标记不完整');return source}
 const anchor='                if (frame.type === "projection" && frame.key === "$dsh-tavern/rollback-sync-v1") {'
 let next=once(source,anchor,BRANCH+anchor)
 const methodAnchor='            waitForTavernRollbackSync(receipt) {\n                if (receipt?.protocol'
 next=once(next,methodAnchor,METHOD+methodAnchor)
 return MARKER+'\n'+next
}
