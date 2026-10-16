// 作者2.5消费者：push为同步屏障；保失败恢复动作，沿作者读所有权取消旧请求。
import {applyRollbackViewReaderTransform,applyRollbackLiveViewTransform} from './rollback-sync-state-transform.mjs'
const MARKER='// [dsh-tavern-rollback-sync-author:v1]'
const NEXT=`${MARKER}
					if (typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退已落盘，但宿主缺少同连接同步消费者；请重开页面");
					await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync);
					// RPC旧view不安装；只有push之后的新读拥有发布权。`
// R2 普通回退重试闭环（2026-10-11）：
//   · 主 catch 失败后会刷新协调/view，视图可能已回到更早轮（甚至 canRollback=false）；
//     本次失败的**普通目标**必须留在组件 state 里，用户才能对同一目标原凭据重试。
//   · 若已有 retry 目标则沿用（不覆盖成刷新后的更早轮）；成功（同连接 push 之后）清空。
//   · 只影响普通回退：失败清理（clearIncomplete）走 failureTarget + 数字轮语义，不经该 state。
const RETRY_MARKER='// [dsh-tavern-rollback-retry-target:v1]'
const RETRY_SCOPE_MARKER='// [dsh-tavern-rollback-retry-session:v1]'
const RETRY_STATE=`${RETRY_SCOPE_MARKER}
const [rollbackRetryState, setRollbackRetryTarget] = React.useState(null);
const rollbackRetryOwner = React.useRef(props.sessionId);
rollbackRetryOwner.current = props.sessionId;
React.useEffect(function () { setRollbackRetryTarget(function (current) { return current && current.sessionId !== props.sessionId ? null : current; }); }, [props.sessionId]);
const rollbackRetryTarget = rollbackRetryState && rollbackRetryState.sessionId === props.sessionId ? rollbackRetryState : null;`
const ROLLING_STATE_OLD='const [rolling, setRolling] = React.useState(false);'
const ROLLING_STATE_NEW=`const [rollbackRunningSession, setRollbackRunningSession] = React.useState(null);
const rolling = rollbackRunningSession === props.sessionId;
function setRolling(value) { setRollbackRunningSession(function (current) { return value ? props.sessionId : current === props.sessionId ? null : current; }); }`
const CLEAR_MODE_OLD='const clearIncomplete = rollbackViewState.view && rollbackViewState.view.canClearIncompleteReply === true;'
const CLEAR_MODE_NEW='const clearIncomplete = !rollbackRetryTarget && rollbackViewState.view && rollbackViewState.view.canClearIncompleteReply === true;'
const CAN_OLD='const canRollback = rollbackViewState.view && rollbackViewState.view.canRollback === true;'
const CAN_NEW='const canRollback = !!rollbackRetryTarget || (rollbackViewState.view && rollbackViewState.view.canRollback === true);'
const RETRY_RPC_OLD='{ expectedTurn: ordinaryTurn }'
const RETRY_RPC_NEW='{ expectedTurn: rollbackRetryTarget || ordinaryTurn }'
const RETRY_CATCH_ANCHOR='                    liveTavernView.rebase(props.sessionId);\n                    tavernCoordination.invalidate(props.sessionId);\n                    tavernErrorHub.report("回退本轮", err);'
const RETRY_CATCH_NEXT=`                    // 只保留本session本次普通请求凭据；旧会话迟到的catch不得覆盖新会话。
                    if (!clearIncomplete && rollbackRetryOwner.current === props.sessionId) setRollbackRetryTarget(function (current) {
                        const target = rollbackRetryTarget || (rollbackViewState.view && rollbackViewState.view.rollbackTarget) || null;
                        return current && current.sessionId === props.sessionId ? current : target && target.sessionId === props.sessionId ? target : null;
                    });
                    liveTavernView.rebase(props.sessionId);
                    tavernCoordination.invalidate(props.sessionId);
                    tavernErrorHub.report("回退本轮", err);`
const RETRY_CLEAR_ANCHOR='await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync);'
const RETRY_CLEAR_NEXT=`await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync);
                    // 同连接完成已确认；只清理请求所属session的凭据，不能清掉新会话重试。
                    setRollbackRetryTarget(function (current) { return current && current.sessionId === props.sessionId ? null : current; });`
const RETRY_LABEL_OLD='clearIncomplete ? "清除未完成回复" : targetLabel);'
const RETRY_LABEL_NEW='clearIncomplete ? "清除未完成回复" : rollbackRetryTarget ? "重试完成回退" : targetLabel);'
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
function scopedRetryMode(source){
 const start=source.indexOf('function TavernRollbackAction(props)'),end=source.indexOf('async function rollback()',start)
 if(start<0 || end<start)throw Error('普通回退模式组件边界缺失')
 return source.slice(0,start)+once(source.slice(start,end),CLEAR_MODE_OLD,CLEAR_MODE_NEW)+source.slice(end)
}
// R2 重试闭环接线（幂等）：state + canRollback + 普通 RPC 选择 + catch 记录 + 成功清空 + 标签。
// 已带 RETRY_MARKER 的产物只核结构完整，不重复施缝（与 error-purge 的标记产物兼容）。
export function applyRollbackRetryState(source){
 if(source.includes(RETRY_MARKER)){
  const retryLabel = source.includes('// [dsh-tavern-rollback-menu:v1]') ? 'rollbackRetryTarget ? "重试完成回退" : clearIncomplete ? targetLabel + "（未完成发送）" : targetLabel);' : RETRY_LABEL_NEW
   for(const needle of [RETRY_STATE,ROLLING_STATE_NEW,CAN_NEW,retryLabel,CLEAR_MODE_NEW,RETRY_CATCH_NEXT,'return current && current.sessionId === props.sessionId ? null : current;'])
   if(!source.includes(needle))throw Error('回退重试闭环标记不完整：'+needle.slice(0,60))
  if(!source.includes(RETRY_RPC_NEW) && source.includes(RETRY_RPC_OLD)) throw Error('回退重试闭环标记不完整：普通RPC未接重试目标')
  return source
 }
 const start=source.indexOf('async function rollback()',source.indexOf('function TavernRollbackAction(props)'))
 const end=source.indexOf('if (!canRollback) {',start)
 if(start<0 || end<start)throw Error('回退重试闭环callback边界漂移')
 // hook 只声明在 TavernRollbackAction 组件体内，且必须早于 canRollback 的读取（TDZ）。
 const compStart=source.indexOf('function TavernRollbackAction(props)')
 const viewDecl='const rollbackViewState = useLiveTavernView(props.sessionId, "rollback:'
 const anchorAt=source.indexOf(viewDecl,compStart)
 if(compStart<0 || anchorAt<0 || source.split(viewDecl).length!==2 || anchorAt>start)throw Error('回退重试闭环组件锚点缺失或漂移')
 const lineStart=source.lastIndexOf('\n',anchorAt)+1
 const indent=source.slice(lineStart,anchorAt)
 let out=source.slice(0,lineStart)+RETRY_MARKER+'\n'+indent+RETRY_STATE+'\n'+source.slice(lineStart)
 out=once(out,ROLLING_STATE_OLD,ROLLING_STATE_NEW)
 out=once(out,CAN_OLD,CAN_NEW)
 out=scopedRetryMode(out)
 // 普通 RPC 行：新施缝时 error-purge 后施（此刻还没有 ordinaryTurn），此处只对已施过 purge 的产物兜底。
 if(out.includes(RETRY_RPC_OLD))out=out.replace(RETRY_RPC_OLD,RETRY_RPC_NEW)
 out=once(out,RETRY_CATCH_ANCHOR,RETRY_CATCH_NEXT)
 out=once(out,RETRY_LABEL_OLD,RETRY_LABEL_NEW)
 return once(out,RETRY_CLEAR_ANCHOR,RETRY_CLEAR_NEXT)
}
function inlineModule(source,name,transform){
 const start=source.indexOf('function '+name+'('),end=source.indexOf('\n\t\tfunction ',start+10)
 if(start<0 || end<start)throw Error('作者内联状态模块边界漂移：'+name)
 const marker=name==='createSessionViewReader'?'// [dsh-tavern-rollback-view-reader:v1]':'// [dsh-tavern-rollback-live-view:v1]'
 const markerStart=source.lastIndexOf(marker,start),begin=markerStart>=0 && source.slice(markerStart+marker.length,start).trim()===''?markerStart:start
 const raw=source.slice(begin,end).replace(/^\t\t/gm,'')
 return source.slice(0,begin)+transform(raw).replace(/\n/g,'\n\t\t')+source.slice(end)
}
function recoverOrdinaryAction(source) {
 const marker='// [dsh-tavern-rollback-error-refresh:v1]'
 if(source.includes(marker))return applyRollbackRetryState(source)
 const start=source.indexOf('async function rollback()',source.indexOf('function TavernRollbackAction(props)'))
 const end=source.indexOf('if (!canRollback) {',start)
 if(start<0 || end<start)throw Error('回退错误刷新callback边界漂移')
 const block=source.slice(start,end)
 const anchor='tavernErrorHub.report("回退本轮", err);'
 const next=`${marker}
                    liveTavernView.rebase(props.sessionId);
                    tavernCoordination.invalidate(props.sessionId);
                    ${anchor}`
 return applyRollbackRetryState(source.slice(0,start)+once(block,anchor,next)+source.slice(end))
}
// 统一目标（kind:'rollback'）下的普通回退忙资格放开：running/busy/settlement 不再禁止点击，
// 执行端会先取消在途发送再走物理纯尾；regen（重新生成）与编辑正文的 gate 一律不动。
const BUSY_MARKER='// [dsh-tavern-unified-rollback-busy-relax:v1]'
const BUSY_BLOCKED_OLD='\t\t\tconst blocked = rolling || frontRunning || regenBusy || activity.busy || settlementActive;'
const BUSY_BLOCKED_NEW=`\t\t\t${BUSY_MARKER}
\t\t\tconst signedUnifiedTarget = !!(rollbackViewState.view && rollbackViewState.view.rollbackTarget && rollbackViewState.view.rollbackTarget.kind === 'rollback')
\t\t\tconst blocked = rolling;`
const BUSY_TITLE_OLD='disabled: blocked, title: blocked ? "请等待当前生成或后台处理完成后再回退" : clearIncomplete ?'
const BUSY_TITLE_NEW='disabled: blocked, title: blocked ? "请等待当前生成或后台处理完成后再回退" : signedUnifiedTarget && (frontRunning || activity.busy || settlementActive) ? "将先停止当前发送，再回退到这条消息之前" : clearIncomplete ?'
export function applyUnifiedRollbackBusyRelax(source){
  for(const old of [
   'const blocked = rolling || regenBusy || (!signedUnifiedTarget && (frontRunning || activity.busy || settlementActive));',
   'const blocked = rolling || (!signedUnifiedTarget && (frontRunning || regenBusy || activity.busy || settlementActive));'
  ])source=source.replace(old,'const blocked = rolling;')
 if(source.includes(BUSY_MARKER)){
  source=source.replace('const blocked = rolling || regenBusy || (!signedUnifiedTarget && (frontRunning || activity.busy || settlementActive));','const blocked = rolling || (!signedUnifiedTarget && (frontRunning || regenBusy || activity.busy || settlementActive));')
  if(source.split(BUSY_MARKER).length!==2 || !source.includes('const signedUnifiedTarget =') || !source.includes('将先停止当前发送'))
   throw Error('统一回退忙资格放开不完整')
  return source
 }
 source=source.replace('const blocked = rolling || regenBusy || (!signedUnifiedTarget && (frontRunning || activity.busy || settlementActive));','const blocked = rolling || (!signedUnifiedTarget && (frontRunning || regenBusy || activity.busy || settlementActive));')
 if(!source.includes(BUSY_BLOCKED_OLD))return source
 let out=once(source,BUSY_BLOCKED_OLD,BUSY_BLOCKED_NEW,'普通回退忙资格行锚点缺失/不唯一')
 // 提示行可能已被上一代补过（marker 缺失但已接线）⇒ 仅在旧锚点仍在时替换，最终仍必须含新提示。
 if(out.includes(BUSY_TITLE_OLD))out=once(out,BUSY_TITLE_OLD,BUSY_TITLE_NEW,'普通回退按钮提示锚点缺失/不唯一')
 if(!out.includes('将先停止当前发送'))throw Error('统一回退忙资格放开不完整：按钮提示未接线')
 return out
}
export function applyAuthorRollbackActionTransform(source){
 if(source.includes(MARKER)){
  if(source.split(MARKER).length!==2 || !source.includes('await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync);')
    || !source.includes('typeof props.sessions?.waitForTavernRollbackSync !== "function"')
    || source.includes('// [dsh-tavern-core-client-resync:v1]'))throw Error('同连接回退按钮消费者不完整')
  return applyUnifiedRollbackBusyRelax(recoverOrdinaryAction(source))
 }
 const start=source.indexOf('async function rollback()',source.indexOf('function TavernRollbackAction(props)')),end=source.indexOf('if (!canRollback) {',start)
 if(start<0 || end<start)throw Error('回退同步callback边界漂移')
 let callback=source.slice(start,end)
 callback=once(callback,'historyProjection.rolledBack(props.sessionId, result && result.view);',NEXT)
 callback=once(callback,'notifyTavernDataChanged(["sessions"], "play-controls");','// 同连接push只定向通知本档。')
 callback=once(callback,'setRolling(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId);','setRolling(false);')
 return applyUnifiedRollbackBusyRelax(recoverOrdinaryAction(source.slice(0,start)+callback+source.slice(end)))
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
