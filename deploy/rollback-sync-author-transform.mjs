// 作者2.5消费者：push为同步屏障；保失败恢复动作，沿作者读所有权取消旧请求。
import {applyRollbackViewReaderTransform,applyRollbackLiveViewTransform} from './rollback-sync-state-transform.mjs'
const MARKER='// [dsh-tavern-rollback-sync-author:v1]'
const NEXT=`${MARKER}
					if (typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退已落盘，但宿主缺少同连接同步消费者；请重开页面");
					await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync);
					// RPC旧view不安装；只有push之后的新读拥有发布权。`
const EVENT=`const slots = ctx.slots;
            ctx.effect(function () {
                return ctx.on("tavern-storage/rollback-synced", function (receipt) {
                    if (!receipt || typeof receipt.sessionId !== "string" || !receipt.sessionId) throw new Error("回退同步缺少目标Session");
                    beginSessionViewRead.rebase(receipt.sessionId);
                    liveTavernView.rebase(receipt.sessionId);
                    tavernCoordination.invalidate(receipt.sessionId);
                });
            }, "dsh-tavern: same-connection rollback sync");
            // [dsh-tavern-storage-view:v2] 只转发作者既有读所有权/同步语义，不新增第二套 view 或清理引擎。
            ctx.provide("tavernStorageView", {
                apiVersion: 2,
                selectFailure: function (sessionId) {
                    if (typeof sessionId !== "string" || !sessionId) return null;
                    return liveTavernView.select(sessionId, [["failureTarget"], ["failureCleanupReason"], ["activity"]]);
                },
                getSnapshot: function (sessionId) {
                    return sessionId ? liveTavernView.getSnapshot(sessionId) : null;
                },
                request: function (method, args, sessionId) {
                    if (method !== "rollbackTurn") throw new Error("tavernStorageView 只允许 rollbackTurn");
                    return rpc(method, args, sessionId);
                },
                refresh: function (sessionId) {
                    if (!sessionId) return;
                    beginSessionViewRead.rebase(sessionId);
                    liveTavernView.rebase(sessionId);
                    tavernCoordination.invalidate(sessionId);
                }
            });`
function once(s,a,b){if(s.split(a).length!==2)throw Error('回退同步作者锚点缺失/不唯一：'+a.slice(0,90));return s.replace(a,b)}
function inlineModule(source,name,transform){
 const start=source.indexOf('function '+name+'('),end=source.indexOf('\n\t\tfunction ',start+10)
 if(start<0 || end<start)throw Error('作者内联状态模块边界漂移：'+name)
 const marker=name==='createSessionViewReader'?'// [dsh-tavern-rollback-view-reader:v1]':'// [dsh-tavern-rollback-live-view:v1]'
 const markerStart=source.lastIndexOf(marker,start),begin=markerStart>=0 && source.slice(markerStart+marker.length,start).trim()===''?markerStart:start
 const raw=source.slice(begin,end).replace(/^\t\t/gm,'')
 return source.slice(0,begin)+transform(raw).replace(/\n/g,'\n\t\t')+source.slice(end)
}
export function applyAuthorRollbackActionTransform(source){
 if(source.includes(MARKER)){
  if(source.split(MARKER).length!==2 || !source.includes(NEXT) || source.includes('// [dsh-tavern-core-client-resync:v1]'))throw Error('同连接回退按钮消费者不完整')
  return source
 }
 const start=source.indexOf('async function rollback()',source.indexOf('function TavernRollbackAction(props)')),end=source.indexOf('if (!canRollback) {',start)
 if(start<0 || end<start)throw Error('回退同步callback边界漂移')
 let callback=source.slice(start,end)
 callback=once(callback,'historyProjection.rolledBack(props.sessionId, result && result.view);',NEXT)
 callback=once(callback,'notifyTavernDataChanged(["sessions"], "play-controls");','// 同连接push只定向通知本档。')
 callback=once(callback,'setRolling(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId);','setRolling(false);')
 return source.slice(0,start)+callback+source.slice(end)
}
export function applyAuthorRollbackRuntimeTransform(source){
 const marker='// [dsh-tavern-rollback-sync-runtime:v1]'
 if(source.includes(marker)){if(source.split(marker).length!==2 || !source.includes(EVENT))throw Error('同连接回退运行消费者不完整');return source}
 return marker+'\n'+once(source,'const slots = ctx.slots;',EVENT)
}
export function applyAuthorCoordinationTransform(source){
 const marker='// [dsh-tavern-rollback-coordination:v1]'
 const refresh='refresh: () => { rollbackRead = true; reconcile = true; controller.replace(); controller.request(); },'
 const signal='if (rollbackRead) { controller.request(); return; }'
 if(source.includes(marker)){if(source.split(marker).length!==2 || !source.includes(refresh) || !source.includes(signal))throw Error('回退协调标记不完整');return source}
 let out=marker+'\n'+source
 out=once(out,'let active = true, reconcile = true;','let active = true, reconcile = true, rollbackRead = false;')
 // SSE快照没有同连接回退水位：刷新之后只唤醒权威HTTP读，不安装可能迟到的旧快照。
 out=once(out,'if (signal && signal.snapshot) {','if (signal && signal.snapshot) {\n            '+signal)
 out=once(out,'refresh: () => controller.request(),',refresh)
 return out
}
export function applyAuthorRollbackSyncTransform(source){
 const built=source.includes('function createLiveTavernViewModule(options)')
 let out=applyAuthorRollbackActionTransform(source)
 out=applyAuthorRollbackRuntimeTransform(out)
 if(built){
  out=inlineModule(out,'createSessionViewReader',applyRollbackViewReaderTransform)
  out=inlineModule(out,'createLiveTavernViewModule',applyRollbackLiveViewTransform)
  out=applyAuthorCoordinationTransform(out)
 }else if(!out.includes('// @include modules/session-view-sync.js') || !out.includes('// @include modules/live-tavern-view.js'))throw Error('作者状态模块include布局未知')
 return out
}
export function applyRollbackSyncHostTransform(source){
 const old="    webServerProvider: () => ctx.get('webServer'),",next="    rollbackSyncProvider: () => ctx.get('tavernRollbackSync'),"
 if(source.includes(next)){if(source.split(next).length!==2 || source.includes(old))throw Error('同连接Host接线不完整');return source}
 return once(source,old,next)
}
