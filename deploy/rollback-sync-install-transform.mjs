// 同连接补丁必须安装到既有sessions/manager/驻留Session；仅eval产物不构成接管。
const MARKER='// [dsh-tavern-rollback-sync-install:v1]'
function once(s,a,b){if(s.split(a).length!==2)throw Error('同步安装锚点缺失/不唯一：'+a.slice(0,90));return s.replace(a,b)}
export function applyRollbackSyncActionGuardTransform(source){
 const old='const result = await rpc("rollbackTurn", { expectedTurn: clearIncomplete ? null : targetTurn }, props.sessionId);'
 const next='if (typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行回退");\n                    '+old
 if(source.includes(next))return source
 return once(source,old,next)
}
export function applyRollbackSyncInstallTransform(source,{runtimeOnly=false}={}){
 if(source.includes(MARKER)){
  if(source.split(MARKER).length!==2 || !source.includes('installTavernSessionHistoryPatch(require, rpc, ctx);') || (source.includes('function installTavernSessionHistoryPatch(') && !source.includes('ctx.effect(() => evaluated.installTavernRollbackSync(ctx.sessions),')) || source.includes('installTavernSessionHistoryPatch(require, rpc);'))throw Error('同连接安装接线不完整')
  return source
 }
 let out=runtimeOnly?source:applyRollbackSyncActionGuardTransform(source)
 out=once(out,'function apply(ctx) {','function apply(ctx) {\n            installTavernSessionHistoryPatch(require, rpc, ctx);')
 out=once(out,'installTavernSessionHistoryPatch(require, rpc);','// 历史及同连接补丁统一在apply取得实际sessions后安装。')
 // source的host-session-patch是include，built则为内联，分别施缝。
 if(out.includes('function installTavernSessionHistoryPatch(require, rpc) {'))out=applyRollbackSyncHandshakeTransform(out)
 return MARKER+'\n'+out
}
export function applyRollbackSyncHandshakeTransform(source){
 if(source.includes('ctx.effect(() => evaluated.installTavernRollbackSync(ctx.sessions),'))return source
 let out=once(source,'function installTavernSessionHistoryPatch(require, rpc) {','function installTavernSessionHistoryPatch(require, rpc, ctx) {')
 out=once(out,'patched = evaluated.SessionEventStream.prototype','if (typeof evaluated.installTavernRollbackSync !== "function") throw new Error("同连接补丁没有安装入口");\n            ctx.effect(() => evaluated.installTavernRollbackSync(ctx.sessions), "dsh-tavern: install same-connection consumer");\n            patched = evaluated.SessionEventStream.prototype')
 return out
}
// 函数在rc.2补丁factory内部，复用已转换类的闭包；不new服务、不重开物理连接。
export const ROLLBACK_INSTALLER=`
        exports.installTavernRollbackSync = function (sessions) {
            const manager = sessions && sessions.manager;
            if (!manager || !manager.sessions || typeof sessions.rootCtx?.emit !== "function") throw new Error("同连接安装拿不到实际会话服务");
            const restores = [];
            const replace = (owner, key, value) => {
                const descriptor = Object.getOwnPropertyDescriptor(owner, key);
                Object.defineProperty(owner, key, { configurable: true, writable: true, value });
                restores.push(() => { if (owner[key] !== value) return; if (descriptor) Object.defineProperty(owner, key, descriptor); else delete owner[key]; });
            };
            const patchSession = session => {
                for (const key of ["resync", "loadOlder", "loadThrough"]) replace(session, key, Session.prototype[key]);
            };
            try {
                for (const key of ["handleControlFrame", "waitForTavernRollbackSync", "applyTavernRollbackSync", "applyTavernSessionCut", "recordMutation", "refreshList", "refreshSubagents"]) {
                    if (typeof SessionManager.prototype[key] !== "function") throw new Error("同连接manager方法缺失：" + key);
                    replace(manager, key, SessionManager.prototype[key]);
                }
                for (const session of manager.sessions.values()) patchSession(session);
                const createSession = manager.createSession;
                replace(manager, "createSession", function (...args) { const session = createSession.apply(this, args); patchSession(session); return session; });
                replace(manager, "tavernRollbackNotify", receipt => sessions.rootCtx.emit("tavern-storage/rollback-synced", receipt));
                replace(sessions, "waitForTavernRollbackSync", receipt => manager.waitForTavernRollbackSync(receipt));
            } catch (error) { for (let i = restores.length - 1; i >= 0; i--) restores[i](); throw error; }
            return () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
        };
`
