// 失败错误行"隐藏此错误"改为"干净清理错误"：精确 view.failureTarget（当前最新可重放失败），失败only。
// rpc("rollbackTurn", { expectedTurn: turn, failureTarget: ft })；回执 view.rolledBack.cleanedFailureTarget 核 same turn/op/branch。
// alreadyClean 分支定向 live rebase/refresh 不等待；否则 waitForTavernRollbackSync(view.rolledBack.sync)。
// 不 global notify、不 invalidate 毁新 view；失败保留提示，pending same 目标可重试；历史旧失败行禁用保留。
// 2026-10-10 修 stale 闭包：控件经稳定 ref 活取当前视图，目标身份变化时用稳定 key 触发 effect 重建；
// 可清理资格每次 apply 双向写 disabled（原实现只在不可清理时置 true，目标后来活了无法解除）。
// 2026-10-10 native-only 目标：回执身份按 shape 校验（body=operationId 非空串；native-only=endSeq/eventCount 安全整数），
// 且 kind+turn+branchId+revision exact（禁止 String(undefined) 恒等放行）；正常清理等待同连接同步后同样 rebase+refresh，
// 令 43 清完后的 42 立刻重算（不再只依赖下一次 render）；不做 before-target 删除/软隐藏/自动双清。
// 目标身份 key 增 kind/endSeq/eventCount：43→42 切换必须重建控件并 refresh。
// kind 只认 native-only 或 undefined/body（未知值一律拒）；branchId/revision 两侧 exact；body operationId 不做 string 转换比较。
// 菜单clear分支与错误行共同委托tavernStorageUi.cleanFailure；普通回退仍走作者同连接等待，旧内联块只用于严格升级识别。
const MARKER_TURN = '// [dsh-tavern-error-purge-turn:v1]'
const MARKER_PLAY = '// [dsh-tavern-error-purge-play:v1]'
// 仅用于严格识别旧 marked 菜单的升级输入；新产物不再内联这份旧比较器。
const TARGET_COMPARE_LINES = [
  'var targetCompare = function (ft, cft) {',
  '    if (!ft || !cft || typeof ft !== "object" || typeof cft !== "object") return "目标缺失";',
  '    var kindOf = function (value) { return value === "native-only" ? "native-only" : (value === undefined || value === "body" ? "body" : null) };',
  '    var ftKind = kindOf(ft.kind), cftKind = kindOf(cft.kind);',
  '    if (ftKind === null || cftKind === null || ftKind !== cftKind) return "kind 不一致";',
  '    if (!Number.isSafeInteger(cft.turn) || Number(cft.turn) !== Number(ft.turn)) return "turn 不一致";',
  '    if (typeof ft.branchId !== "string" || ft.branchId === "" || cft.branchId !== ft.branchId) return "branchId 不一致";',
  '    if (!Number.isSafeInteger(cft.revision) || !Number.isSafeInteger(ft.revision) || Number(cft.revision) !== Number(ft.revision)) return "revision 不一致";',
  '    if (ftKind === "native-only") {',
  '        if (ft.operationId !== undefined || cft.operationId !== undefined) return "native 不得带 operationId";',
  '        if (!Number.isSafeInteger(ft.endSeq) || ft.endSeq <= 0 || !Number.isSafeInteger(ft.eventCount) || ft.eventCount !== ft.endSeq + 1) return "native 目标形状不合法";',
  '        if (!Number.isSafeInteger(cft.endSeq) || cft.endSeq <= 0 || !Number.isSafeInteger(cft.eventCount) || cft.eventCount !== cft.endSeq + 1) return "native 回执形状不合法";',
  '        if (Number(cft.endSeq) !== Number(ft.endSeq) || Number(cft.eventCount) !== Number(ft.eventCount)) return "native 身份不一致";',
  '    } else if (typeof cft.operationId !== "string" || cft.operationId === "" || cft.operationId !== ft.operationId) return "operationId 不一致";',
  '    if (typeof ft.chatId === "string" && typeof cft.chatId === "string" && cft.chatId !== ft.chatId) return "chatId 不一致";',
  '    if (typeof ft.sessionId === "string" && typeof cft.sessionId === "string" && cft.sessionId !== ft.sessionId) return "sessionId 不一致";',
  '    return "";',
  '};',
]
const targetCompareText = indent => TARGET_COMPARE_LINES.join('\n' + indent)
// 菜单：split 单文件与 built 产物都经作者动作变换（built 走 core-host-transform:138 → rollback-sync-author:58）
// 按 exact RPC 插入该 wait 行；只有 inline（作者 main.js 无 include）没有它。
const MENU_WAIT_ANCHOR = 'await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync);'
const MENU_WAIT_NEXT = 'if (!(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) await props.sessions.waitForTavernRollbackSync(result?.view?.rolledBack?.sync); if (clearIncomplete && result && result.view && result.view.rolledBack) { liveTavernView.rebase(props.sessionId); tavernCoordination.invalidate(props.sessionId); }'
// built/inline 布局（无作者 wait）追加的 clearIncomplete 专用 wait+refresh：alreadyClean 不等待，normal rollback 原逻辑不动。
// 正常等待一律 await（不做 typeof 跳过）：缺 sync 消费者由 RPC 前的 clear-only guard 响亮失败，绝不静默越过。
const MENU_CLEAR_WAIT_BLOCK = [
  'if (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) {',
  '\tawait props.sessions.waitForTavernRollbackSync(result && result.view && result.view.rolledBack && result.view.rolledBack.sync);',
  '\tliveTavernView.rebase(props.sessionId);',
  '\ttavernCoordination.invalidate(props.sessionId);',
  '}',
].map(line => '\n\t\t\t\t\t' + line).join('')
// built/inline 布局的 clear-only 同步消费者守卫（RPC 前即抛）；split 布局作者 guard 已在位 ⇒ 不重复插。
const MENU_CLEAR_GUARD = '\n\t\t\t\t\tif (clearIncomplete && typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行清理");'
// 普通回退的发起凭据（R2）：完成记录/reconcile 未就绪时退回作者原数字语义，非法值大声拒绝。
// 失败清理（clearIncomplete）**不使用**该目标，仍按原 failureTarget + 数字 turn 语义（PURGE_CLEAR_ONLY）。
// 只做目标选择与非法值拒绝，**不新增**live/协调失效配对（既有协调接线计数保持不变）。
const MENU_ORDINARY_TURN = [
  'var ordinaryRetry = typeof rollbackRetryTarget === "undefined" ? null : rollbackRetryTarget;',
  'var ordinaryTarget = ordinaryRetry || (rollbackViewState.view && rollbackViewState.view.rollbackTarget);',
  '// 对象凭据（kind rollback + turn/revision/branchId/chatId/sessionId 齐备）与纯数字目标都接受；',
  '// 重试时视图可能已被主 catch 刷新成更早轮甚至 canRollback=false，凭据仍在就必须能用同一目标重试。',
  'var ordinaryObject = !!(ordinaryTarget && typeof ordinaryTarget === "object" && ordinaryTarget.kind === "rollback" && Number.isSafeInteger(ordinaryTarget.turn) && ordinaryTarget.turn > 0 && Number.isSafeInteger(ordinaryTarget.revision) && ordinaryTarget.revision >= 0 && typeof ordinaryTarget.branchId === "string" && ordinaryTarget.branchId !== "" && typeof ordinaryTarget.chatId === "string" && ordinaryTarget.chatId !== "" && ordinaryTarget.sessionId === props.sessionId && (!props.chatId || ordinaryTarget.chatId === props.chatId));',
  'var ordinaryNumber = Number.isSafeInteger(ordinaryTarget) && ordinaryTarget > 0 ? ordinaryTarget : (ordinaryTarget == null && Number.isSafeInteger(targetTurn) && targetTurn > 0 ? targetTurn : NaN);',
  'var ordinaryTurn = ordinaryObject ? ordinaryTarget : ordinaryNumber;',
  'if (clearIncomplete && targetTurn <= 0) throw new Error("清理缺少目标轮号，拒绝按普通回退发起");',
  'if (!clearIncomplete && !(ordinaryObject || (Number.isSafeInteger(ordinaryTurn) && ordinaryTurn > 0))) throw new Error("普通回退缺少有效目标，请刷新后重试");',
].map(line => '\n\t\t\t\t\t' + line).join('')
const MENU_ORDINARY_ANCHOR = 'var ordinaryObject ='
// 清理场景回执缺失必须响亮失败（不许 skip receipt 后继续 refresh）。
const MENU_RECEIPT_REQUIRED = '\n\t\t\t\t\tif (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.cleanedFailureTarget)) throw new Error(\'清理未确认目标失败轮，不更新本地状态\');'
// built/inline 布局的旧软视图行：清理场景不得安装旧 view，常规回退保持原 pipeline。
const SOFT_VIEW_ANCHOR = 'historyProjection.rolledBack(props.sessionId, result && result.view);'
const SOFT_VIEW_NEXT = 'if (!clearIncomplete) historyProjection.rolledBack(props.sessionId, result && result.view);'
// 菜单侧回执核对：同一 targetCompare 文本 + 菜单缩进约定（\n\t\t\t\t\t 由变换替换为真实行首缩进）。
const MENU_RECEIPT_CHECK = targetCompareText('\t\t\t\t\t') + [
  'var menuMismatch = targetCompare(menuFailureTarget, cft);',
  'if (menuMismatch !== "") throw new Error(\'清理回执目标与请求不一致，拒绝更新：\' + menuMismatch);',
].map(line => '\n\t\t\t\t\t' + line).join('')
const TOGGLE_ONCLICK_OLD = `                toggle.onclick = function () {
                    if (folded(id)) { revealed.add(id); apply(); return; }
                    const dismiss = !hidden.has(id);
                    function commit() {
                        if (disposed) return;
                        if (dismiss) hidden.add(id); else { hidden.delete(id); revealed.add(id); }
                        save(); apply();
                    }
                    if (!options.onToggle) { commit(); return; }
                    if (toggle.disabled) return;
                    toggle.disabled = true;
                    return Promise.resolve().then(function () { return options.onToggle(Number(id), dismiss); })
                        .then(commit, function (error) { if (options.onError) options.onError(error); })
                        .finally(function () { toggle.disabled = false; });
                };`
const TOGGLE_ONCLICK_NEXT = `${MARKER_TURN}
                toggle.onclick = function () {
                    if (toggle.disabled) return;
                    var target = turnErrorRowTurn(row);
                    if (!Number.isSafeInteger(target) || target < 1) { if (options.onError) options.onError(new Error('无法确认当前失败轮号，拒绝清理')); return; }
                    var purge = typeof options.onPurge === 'function' ? options.onPurge : null;
                    if (!purge) { if (options.onError) options.onError(new Error('干净清理尚未接线，拒绝隐藏式清理')); return; }
                    var allowed = options.failureTarget && Number(options.failureTarget.turn) === target;
                    if (!allowed) { if (options.onError) options.onError(new Error('此错误不是当前可清理失败，保留不清理')); return; }
                    toggle.disabled = true;
                    return Promise.resolve().then(function () { return purge(target, options.failureTarget); })
                        .then(function () {
                            if (disposed) return;
                            hidden.delete(id); revealed.delete(id);
                            try {
                                var key = 'dsh-tavern-hidden-errors:' + options.sessionId;
                                var stored = JSON.parse(options.storage.getItem(key) || '[]');
                                if (Array.isArray(stored)) options.storage.setItem(key, JSON.stringify(stored.filter(function (v) { return v !== id; })));
                            } catch (_) {}
                            apply();
                        }, function (error) { if (options.onError) options.onError(error); })
                        .finally(function () { toggle.disabled = false; });
                };`
const TOGGLE_TEXT_OLD = `            const toggleText = folded(id) ? '查看错误' : dismissed ? '恢复错误提示' : '隐藏此错误';`
const TOGGLE_TEXT_NEXT = `${MARKER_TURN}
            // 干净清理：目标 active 无论 hidden/folded 都是清理；不可清理行禁用并说明原因，不再显示“隐藏此错误”。
            var purgeActive = options.failureTarget && Number(options.failureTarget.turn) === turnErrorRowTurn(row);
            // 每次 apply 按当前判定双向写：目标后来才可清理时同样解除禁用（原实现只在 false 时置 true，会永久卡死）。
            entry.toggle.disabled = !purgeActive;
            entry.toggle.title = purgeActive ? '' : (options.failureCleanupReason || '此错误不是当前可清理的最新失败轮');
            const toggleText = purgeActive ? '干净清理错误' : (folded(id) ? '查看错误' : dismissed ? '恢复错误提示' : '无法清理此错误');`
const PLAY_ONTOGGLE_OLD = `                    onToggle: !Array.isArray(hiddenTurns) ? undefined : async function (turn, hidden) {
                        const result = await rpc("setFailedErrorVisibility", { sessionId: props.sessionId, turn: turn, hidden: hidden });
                        liveTavernView.setView(props.sessionId, result.view);
                    },`
const PLAY_ONTOGGLE_NEXT = `${MARKER_PLAY}
                    onToggle: undefined,
                    // [dsh-tavern-error-purge:play-controls] onPurge(turn, failureTarget)：失败only，
                    // 仅 row turn === view.failureTarget.turn（含 pending 重试，不看 replayTurn）；
                    // rpc 附 failureTarget；回执核 cleanedFailureTarget same turn/op/branch；alreadyClean 定向 rebase/refresh 不等待；
                    // 否则 waitForTavernRollbackSync(view.rolledBack.sync)；不 global notify、不 invalidate 毁新 view。
                    // failureTarget/failureCleanupReason 经 failureViewRef 活取当前 state.view：该 ref 对象跨 render 稳定，
                    // 控件不因 effect 未重建而吃创建时快照（stale 闭包）。
                    get failureTarget() { const liveView = failureViewRef.current.view; return (liveView && (liveView.rollbackTarget || liveView.failureTarget)) || null },
                    get failureCleanupReason() { return failureViewRef.current.view && failureViewRef.current.view.failureCleanupReason || '' },
                    onPurge: async function (turn, failureTarget) {
                        // 清理的**唯一实现**在自有 UI 服务（tavernStorageUi.cleanFailure）。SupersededTurnErrors
                        // 定义在 register(ctx) 之外，函数体内拿不到 ctx ⇒ 由注册语句注入 storageUi 取用函数
                        // （registration 闭包里的 ctx 合法），这里只经 props 调用，不假设存在全局 ctx。
                        var current = failureViewRef.current.view;
                        var liveTarget = (current && (current.rollbackTarget || current.failureTarget)) || null;
                        if (!liveTarget) throw new Error('当前视图没有可清理的失败目标，拒绝清理');
                        if (!Number.isSafeInteger(turn) || turn < 1 || turn !== Number(liveTarget.turn)) throw new Error('清理目标不是当前最新失败轮，拒绝清理');
                        var storageUi = typeof props.storageUi === "function" ? props.storageUi() : undefined;
                        if (!storageUi || typeof storageUi.cleanFailure !== "function") throw new Error("精简清理未接线：找不到共享 tavernStorageUi.cleanFailure，拒绝清理");
                        var resp = await storageUi.cleanFailure(props.sessionId, turn, failureTarget || liveTarget);
                        // 目标已清：关闭仍指向旧目标的候选/重生成面板选择，避免面板停留在过期身份上。
                        setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
                        return resp;
                    },`
// 菜单清未完成：与 sync guard 已施加形态兼容——仅替换 exact RPC 行，不动 guard/其余回调。
// client-seams 顺序：applyAuthorRollbackActionTransform → applyRollbackSyncActionGuardTransform → purge（本变换在 guard 之后）。
const PLAY_MENU_RPC_OLD = `const result = await rpc("rollbackTurn", { expectedTurn: clearIncomplete ? null : targetTurn }, props.sessionId);`
// R2：菜单里的普通回退行（clear-only 行保持数字 targetTurn + failureTarget，不动）。
// 施缝后按真实缩进落地；已 marked 的旧产物（缓存旧字串）同样按旧字串严格原位升级。
const MENU_ORDINARY_RPC_OLD = ': await rpc("rollbackTurn", { expectedTurn: targetTurn }, props.sessionId);'
const MENU_ORDINARY_RPC_NEW = ': await rpc("rollbackTurn", { expectedTurn: ordinaryTurn }, props.sessionId);'
const RETRY_RPC_NEW = '{ expectedTurn: rollbackRetryTarget || ordinaryTurn }'
// 严格原位升级：只在「RPC 行唯一 + 旧普通行唯一 + 尚无普通目标行」时插目标行并替换普通行，其余一律 fail-closed。
// TavernRollbackAction.rollback 的 region 与「已渲染」clear-only 行锚点：
// finished 产物里模板占位 /*DSH_PURGE_*&#47; 已被替换，绝不能用含占位的 PLAY_MENU_RPC_NEXT 去 indexOf。
const RENDERED_CLEAR_LINE='const result = clearIncomplete'
function rollbackRegion(out){
 const comp=out.lastIndexOf('function TavernRollbackAction(props) {')
 if(comp<0) throw new Error('干净清理锚点缺失/不唯一：找不到 TavernRollbackAction')
 const end=out.indexOf('if (!canRollback) {',comp)
 if(end<comp) throw new Error('干净清理锚点缺失/不唯一：找不到 rollback callback 边界')
 return {comp,end}
}
function renderedClearAt(out){
 const {comp,end}=rollbackRegion(out)
 const hits=[]
 let at=out.indexOf(RENDERED_CLEAR_LINE,comp)
 while(at>=0 && at<end){ hits.push(at); at=out.indexOf(RENDERED_CLEAR_LINE,at+1) }
 if(hits.length!==1) throw new Error('干净清理锚点缺失/不唯一：callback 内 clear 行=' + hits.length)
 return hits[0]
}
function upgradeOrdinaryMenuRpc(out, label) {
  if (out.includes(MENU_ORDINARY_ANCHOR)) {
    // 已升级产物：仍须核 RPC 形态在位（缺 RPC 的畸形产物不得被原样 return 当成功）。
    const retryHits = out.split(RETRY_RPC_NEW).length - 1
    const plainHits = out.split(MENU_ORDINARY_RPC_NEW).length - 1
    if (retryHits === 1 && plainHits === 0) return out
    if (retryHits === 0 && plainHits === 1 && !out.includes('const [rollbackRetryState,')) return out
    // 半缝：普通行已在、RPC 还是纯对象形态 ⇒ 补一次 retry 前缀（仅当重试 state 在位）。
    if (retryHits === 0 && plainHits === 1 && out.includes('const [rollbackRetryState,')) return out.replace('{ expectedTurn: ordinaryTurn }', RETRY_RPC_NEW)
    throw new Error('干净清理锚点缺失/不唯一：' + label + '-menu-ordinary-upgrade(已标记但RPC形态不符 retry=' + retryHits + ',plain=' + plainHits + ')')
  }
  const oldHits = out.split(MENU_ORDINARY_RPC_OLD).length - 1
  if (oldHits !== 1) throw new Error('干净清理锚点缺失/不唯一：' + label + '-menu-ordinary-upgrade(old=' + oldHits + ')')
  const rpcAt = renderedClearAt(out)
  const {comp}=rollbackRegion(out)
  const markerAt = out.lastIndexOf(MARKER_PLAY, rpcAt)
  if (markerAt < comp) throw new Error('干净清理锚点缺失/不唯一：' + label + '-menu-ordinary-upgrade(缺 callback PLAY marker 行)')
  const lineStartOfMarker = out.lastIndexOf('\n', markerAt) + 1
  const indentOfMarker = out.slice(lineStartOfMarker, markerAt)
  const ordinaryLines = MENU_ORDINARY_TURN.replace(/\n\t\t\t\t\t/g, '\n' + indentOfMarker).replace(/\n\t\t\t\t\t\t/g, '\n' + indentOfMarker + '\t').slice(1)
  const inserted = out.slice(0, lineStartOfMarker) + ordinaryLines + '\n' + indentOfMarker + out.slice(markerAt)
  let upgraded = inserted
  if (inserted.split(MENU_ORDINARY_RPC_OLD).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label + '-menu-ordinary-upgrade(普通RPC旧形态不唯一)')
  upgraded = upgraded.replace(MENU_ORDINARY_RPC_OLD, MENU_ORDINARY_RPC_NEW)
  // 旧 marked 升级的两缝幂等：作者缝先跑（那时还是数字行），purge 后插普通行——retry 前缀必须在这里恰好补一次。
  if (upgraded.includes('const [rollbackRetryState,')) {
    if (upgraded.split(MENU_ORDINARY_RPC_NEW).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label + '-menu-ordinary-upgrade(普通RPC形态不唯一)')
    upgraded = upgraded.replace('{ expectedTurn: ordinaryTurn }', RETRY_RPC_NEW)
  }
  return upgraded
}
const PLAY_MENU_RPC_NEXT = `${MARKER_PLAY}
var menuFailureTarget = clearIncomplete ? (rollbackViewState.view && (rollbackViewState.view.rollbackTarget || rollbackViewState.view.failureTarget)) || null : null;
					if (clearIncomplete && !menuFailureTarget) throw new Error('当前没有可安全清理的失败目标，不发送清理请求');/*DSH_PURGE_CLEAR_GUARD*/
					const result = clearIncomplete
						? await rpc("rollbackTurn", { expectedTurn: Number(menuFailureTarget.turn), failureTarget: menuFailureTarget }, props.sessionId)
						: await rpc("rollbackTurn", { expectedTurn: targetTurn }, props.sessionId);/*DSH_PURGE_RECEIPT_REQUIRED*/
					if (clearIncomplete && result && result.view && result.view.rolledBack && result.view.rolledBack.cleanedFailureTarget) {
						var cft = result.view.rolledBack.cleanedFailureTarget;
						${MENU_RECEIPT_CHECK}
					}
					if (clearIncomplete && result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true) {
						liveTavernView.rebase(props.sessionId);
						tavernCoordination.invalidate(props.sessionId);
						return result;
					}/*DSH_PURGE_CLEAR_WAIT*/`
// 菜单基准行的两代精确形态：当前代读统一 rollbackTarget 优先，上一代只读 failureTarget。
// 升级只认这两代**完整自有块**（半截/外改块仍不匹配 ⇒ fail-closed），不猜删。
const MENU_TARGET_NEW_LINE = 'var menuFailureTarget = clearIncomplete ? (rollbackViewState.view && (rollbackViewState.view.rollbackTarget || rollbackViewState.view.failureTarget)) || null : null;'
const MENU_TARGET_OLD_LINE = 'var menuFailureTarget = clearIncomplete ? (rollbackViewState.view && rollbackViewState.view.failureTarget) || null : null;'
// 当前菜单只委托共享服务；回执身份/同连接等待/定向刷新均归 cleanFailure。
const MENU_DELEGATED_MARKER = '// [dsh-tavern-error-purge-menu-delegated:v1]'
const PLAY_MENU_DELEGATED = `${MARKER_PLAY}
${MENU_DELEGATED_MARKER}
var menuFailureTarget = clearIncomplete ? (rollbackViewState.view && (rollbackViewState.view.rollbackTarget || rollbackViewState.view.failureTarget)) || null : null;
					if (clearIncomplete && !menuFailureTarget) throw new Error('当前没有可安全清理的失败目标，不发送清理请求');
					const result = clearIncomplete
						? await (async function () {
							var menuStorageUi = typeof props.storageUi === "function" ? props.storageUi() : undefined;
							if (!menuStorageUi || typeof menuStorageUi.cleanFailure !== "function") throw new Error("精简清理未接线：找不到共享 tavernStorageUi.cleanFailure，拒绝清理");
							return await menuStorageUi.cleanFailure(props.sessionId, Number(menuFailureTarget.turn), menuFailureTarget);
						})()
						: await rpc("rollbackTurn", { expectedTurn: targetTurn }, props.sessionId);
					if (clearIncomplete) {
						setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
						return result;
					}`
// 菜单侧最终形态＝作者原样 props 透传：CandidateDockActions 已把 props 原样交给 TavernMoreActions，
// 再由 MoreActions 交给 TavernRollbackAction；共享服务取用函数必须在**持有 ctx 的 register 闭包**里
// 注入到 dock 注册的 props 对象上（作者 play-controls.js 的 CandidateDockActions 注册行），
// 不能在 MoreActions 内引用作用域外的 ctx（那会抛 ReferenceError: ctx is not defined）。
const ROLLBACK_UI_OLD = 'React.createElement(TavernRollbackAction, props)'
/** 上一代(0.4.4)错误形态：MoreActions 内内联引用作用域外 ctx；升级时回退为 props 透传。 */
const ROLLBACK_UI_CTX_INLINE = 'React.createElement(TavernRollbackAction, Object.assign({}, props, { storageUi: function () { return ctx.get("tavernStorageUi") } }))'
const DOCK_UI_ANCHOR = 'React.createElement(CandidateDockActions, Object.assign({}, props, {'
const DOCK_UI_NEW = DOCK_UI_ANCHOR + ' storageUi: function () { return ctx.get("tavernStorageUi") },'
/** 作者 onError 旧标签（清理已交共享服务，标签须说明"干净清理错误"）；只替这一句。 */
const ERROR_LABEL_OLD = 'tavernErrorHub.report("保存错误提示状态失败", error);'
const ERROR_LABEL_NEW = 'tavernErrorHub.report("干净清理错误失败", error);'
function ensureRollbackUiWiring(source) {
  let out = source
  // ① 旧内联形态 → 回到 props 透传（once 保证锚点唯一；仍残留即拒绝）
  if (out.includes(ROLLBACK_UI_CTX_INLINE)) out = once(out, ROLLBACK_UI_CTX_INLINE, ROLLBACK_UI_OLD, '菜单内联取用函数回退为props透传')
  if (out.includes(ROLLBACK_UI_CTX_INLINE)) throw new Error('干净清理菜单仍引用作用域外 ctx，拒绝清理接线')
  // ② 报错标签：新旧并存或重复都拒绝
  const labelNew = out.split(ERROR_LABEL_NEW).length - 1
  if (labelNew > 1) throw new Error('干净清理错误标签重复：' + labelNew)
  if (labelNew === 0) out = once(out, ERROR_LABEL_OLD, ERROR_LABEL_NEW, '干净清理错误标签')
  else if (out.includes(ERROR_LABEL_OLD)) throw new Error('干净清理错误标签半截：新旧标签并存，拒绝')
  // ③ props 透传守卫：菜单必须以作者原样 props 调用 RollbackAction（恰 1）；被外改/丢失时即使 dock getter
  //    在场，菜单也取不到服务，不能按幂等放过
  const passthrough = out.split(ROLLBACK_UI_OLD).length - 1
  if (passthrough !== 1) throw new Error('菜单 RollbackAction 必须保持作者原样 props 透传且唯一：hits=' + passthrough)
  // ④ 注册处：已有合法 getter 则幂等（并拒绝重复/残留裸锚点），否则唯一注入
  const dockNew = out.split(DOCK_UI_NEW).length - 1
  if (dockNew > 1) throw new Error('注册处共享服务取用接线重复：' + dockNew)
  if (dockNew === 1) {
    if (out.split(DOCK_UI_NEW).join('').includes(DOCK_UI_ANCHOR)) throw new Error('注册处共享服务取用接线重复：另有未注入的 dock 锚点')
    return out
  }
  return once(out, DOCK_UI_ANCHOR, DOCK_UI_NEW, '注册处注入共享服务取用函数')
}
function ensureDelegatedMenu(source) {
  let out = source
  const rowReturn='var resp = await storageUi.cleanFailure(props.sessionId, turn, failureTarget || liveTarget);'
  const rowWarning='if (resp && resp.view && resp.view.rollbackWarning) tavernErrorHub.report("回退提示", new Error(resp.view.rollbackWarning));'
  if(!out.includes(rowWarning))out=once(out,rowReturn,rowReturn+'\n                        '+rowWarning,'部分恢复错误行提示')
  if (!out.includes(MENU_DELEGATED_MARKER)) {
    // 只升级本包上一代完整菜单块，任何被改动/半截块都拒绝猜删。
    const rpcAt = renderedClearAt(out)
    const { comp } = rollbackRegion(out)
    const markerAt = out.lastIndexOf(MARKER_PLAY, rpcAt)
    if (markerAt < comp) throw new Error('干净清理菜单升级缺 callback marker')
    const lineStart = out.lastIndexOf('\n', markerAt) + 1
    const indent = out.slice(lineStart, markerAt)
    // 只替换模板的五tab基础缩进一次，余下tab原样保留；不能再次匹配替换后的缩进。
    const render = text => text.replace(/\n\t{5}/g, () => '\n' + indent)
    const expectedTurn = out.includes(RETRY_RPC_NEW) ? 'rollbackRetryTarget || ordinaryTurn' : 'ordinaryTurn'
    const menuTemplates = PLAY_MENU_RPC_NEXT.includes(MENU_TARGET_NEW_LINE)
      ? [PLAY_MENU_RPC_NEXT, PLAY_MENU_RPC_NEXT.replace(MENU_TARGET_NEW_LINE, MENU_TARGET_OLD_LINE)]
      : (() => { throw new Error('干净清理菜单模板基准行未命中：模板已变，拒绝猜删') })()
    const choices = [false, true].flatMap(inline => menuTemplates.map(template => render(template
      .replace('/*DSH_PURGE_CLEAR_GUARD*/', inline ? MENU_CLEAR_GUARD : '')
      .replace('/*DSH_PURGE_RECEIPT_REQUIRED*/', MENU_RECEIPT_REQUIRED)
      .replace('/*DSH_PURGE_CLEAR_WAIT*/', inline ? MENU_CLEAR_WAIT_BLOCK : '')
      .replace('{ expectedTurn: targetTurn }', '{ expectedTurn: ' + expectedTurn + ' }'))))
    const oldBlock = choices.find(text => out.slice(markerAt).startsWith(text))
    if (!oldBlock) throw new Error('干净清理菜单旧块不完整/被修改，拒绝猜删')
    out = out.slice(0, markerAt) + render(PLAY_MENU_DELEGATED.replace('{ expectedTurn: targetTurn }', '{ expectedTurn: ' + expectedTurn + ' }')) + out.slice(markerAt + oldBlock.length)
    // 旧菜单的成功刷新已移到共享服务；普通回退仍保作者 wait（及 R2 凭据清空）。
    if (out.includes(MENU_WAIT_NEXT)) out = out.replace(MENU_WAIT_NEXT, MENU_WAIT_ANCHOR)
    else {
      // 作者重试缝在wait后插入成功清空，旧完整句因此被分开；只移除确切的本包clear尾句。
      const oldWait='if (!(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) ' + MENU_WAIT_ANCHOR
      const oldRefresh=' if (clearIncomplete && result && result.view && result.view.rolledBack) { liveTavernView.rebase(props.sessionId); tavernCoordination.invalidate(props.sessionId); }'
      if (out.includes(oldWait)) {
        out=once(out,oldWait,MENU_WAIT_ANCHOR,'旧菜单重试wait移交')
        out=once(out,oldRefresh,'','旧菜单重试refresh移交')
      }
    }
  }
  const { comp, end } = rollbackRegion(out)
  let callback = out.slice(comp, end)
  const finallyOld = 'setRolling(false); liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId);'
  const finallyNew = 'setRolling(false); if (!clearIncomplete) { liveTavernView.invalidate(props.sessionId); tavernCoordination.invalidate(props.sessionId); }'
  if (callback.includes(finallyOld)) callback = once(callback, finallyOld, finallyNew, '菜单finally移交共享刷新')
  out = out.slice(0, comp) + callback + out.slice(end)
  for (const needle of ['var menuStorageUi = typeof props.storageUi === "function" ? props.storageUi() : undefined;',
    'if (!menuStorageUi || typeof menuStorageUi.cleanFailure !== "function") throw new Error("精简清理未接线：找不到共享 tavernStorageUi.cleanFailure，拒绝清理");',
    'menuStorageUi.cleanFailure(props.sessionId, Number(menuFailureTarget.turn), menuFailureTarget)',
    'if (clearIncomplete) {', 'return result;']) {
    if (!callback.includes(needle)) throw new Error('干净清理菜单共享标记不完整：' + needle)
  }
  if (out.split(MENU_DELEGATED_MARKER).length !== 2 || callback.includes('var menuMismatch') || callback.includes('var targetCompare = function')) throw new Error('干净清理菜单共享标记不完整')
  // 部分恢复必须可见；清未完成在此提前return，不会走作者普通回退提示行。
  const warning='if (result && result.view && result.view.rollbackWarning) tavernErrorHub.report("回退提示", new Error(result.view.rollbackWarning));'
  const clearReturn='setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);\n\t\t\t\t\t\treturn result;'
  if(out.includes(clearReturn))out=once(out,clearReturn,clearReturn.replace('return result;',warning+'\n\t\t\t\t\t\treturn result;'),'部分恢复菜单提示')
  out=out.replace('if (typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行回退");','// 显示同步不作物理回退资格。')
  return ensureRollbackUiWiring(out)
}
function once(source, anchor, replacement, label) {
  if (source.split(anchor).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label)
  return source.replace(anchor, replacement)
}
// built 缩进归一：仅在函数边界内把行首 "\t\t" 还原为空格，变换后复原；不改任意文本。
function withDedentedBlock(source, startNeedle, endNeedle, fn) {
  const startIdx = source.indexOf(startNeedle)
  if (startIdx < 0) throw new Error('干净清理锚点缺失/不唯一：函数边界起始')
  const endIdx = source.indexOf(endNeedle, startIdx)
  if (endIdx < 0) throw new Error('干净清理锚点缺失/不唯一：函数边界结束')
  const lineStart = source.lastIndexOf('\n', startIdx) + 1
  let lineEnd = source.indexOf('\n', endIdx + endNeedle.length)
  if (lineEnd < 0) lineEnd = source.length
  const head = source.slice(0, lineStart), block = source.slice(lineStart, lineEnd), tail = source.slice(lineEnd)
  const lines = block.split('\n')
  const isBuilt = lines.some(l => l.startsWith('\t\t'))
  const norm = isBuilt ? lines.map(l => l.startsWith('\t\t') ? l.slice(2) : l).join('\n') : block
  const out = fn(norm)
  if (out === norm) return source
  if (!isBuilt) return head + out + tail
  const restored = out.split('\n').map(l => l.length === 0 ? l : '\t\t' + l).join('\n')
  return head + restored + tail
}
// 旧"插件自有失败提示行" DOM 兜底（MARKER_FALLBACK / FALLBACK_* 锚点 / FALLBACK_LINES / insertLines）
// 已**完全退出**：当前失败由自有输入 dock 的 FailureCleanupStrip（client.js）承担，本变换只做 toggle/文案/协调接线。
// SupersededTurnErrors 内三处注入（均在真函数内；source/built 共用带缩进归一的形式）。
// ① state 之后挂稳定 ref；② 可清理资格的 disabled 每次 apply 双向写；③ effect deps 换成带目标身份的稳定字符串，getter/onPurge 读 ref。
const PLAY_STATE_ANCHOR = `\t\t\tconst state = useLiveTavernView(props.sessionId, "suppression:" + String(latestMessageId || "") + ":" + String(running));`
const PLAY_STATE_NEXT = `${PLAY_STATE_ANCHOR}
\t\t\t${MARKER_PLAY}
\t\t\t// state 是本次 render 的快照；该 ref 对象跨 render 稳定，控件据此活取当前视图（不吃创建时快照）。
\t\t\tconst failureViewRef = React.useRef(state);
\t\t\tfailureViewRef.current = state;`
const PLAY_DEPS_ANCHOR = `[props.sessionId, revision]);`
const PLAY_DEPS_NEXT = `[props.sessionId, revision, failureTargetKey]);`
const PLAY_EFFECT_DECL_ANCHOR = `\t\t\tReact.useEffect(function () {\n\t\t\t\tconst root = marker.current && marker.current.closest("[data-conversation-scroll]");`
const PLAY_EFFECT_DECL_NEXT = `\t\t\t// 目标身份/reason 的稳定 key：目标变化必须重建控制器并 refresh，否则按钮文案与可清理资格停在旧视图。
\t\t\t// 自包含内联（不引用 bundle 外符号）：拆分客户端的 play-controls 单文件也会被本变换处理。
\t\t\t// 不能依赖 view/target 对象本身——每次投影都新建 target 对象，按引用依赖会每 render 重建 observer。
\t\t\tconst failureTargetKey = (function (view) {
\t\t\t\tconst target = view && (view.rollbackTarget || view.failureTarget) || null;
\t\t\t\tconst reason = String(view && view.failureCleanupReason || "");
\t\t\t\tif (!target) return JSON.stringify([null, reason]);
\t\t\t\tconst field = function (value) { return value === undefined || value === null ? null : value };
\t\t\t\treturn JSON.stringify([field(target.chatId), field(target.sessionId), field(target.kind), field(target.turn), field(target.operationId),
\t\t\t\t\tfield(target.branchId), field(target.revision), field(target.endSeq), field(target.eventCount), field(target.rollbackId),
\t\t\t\t\tfield(target.nativeAnchor && target.nativeAnchor.turn), field(target.nativeAnchor && target.nativeAnchor.input), field(target.nativeAnchor && target.nativeAnchor.reply), reason]);
\t\t\t})(state.view);
${PLAY_EFFECT_DECL_ANCHOR}`
// 2026-10-10 修「控件拿不到 sessions」：作者在 conversation.input.dock 的同一次注册里给 CandidateQuestion/CandidateDockActions
// 等都注入了 sessions，唯独 SupersededTurnErrors 只传 key ⇒ 控件内 props.sessions 恒 undefined，清理 guard 直接拒绝（RPC 都发不出）。
// 该注册行三种布局（inline 作者 main.js / split 单文件 / built lib/client.js）文本相同，缩进由所在行原样保留。
const SUPERSEDED_SESSIONS_OLD = 'React.createElement(SupersededTurnErrors, Object.assign({}, props, { key: props.sessionId }))'
const SUPERSEDED_SESSIONS_NEW = 'React.createElement(SupersededTurnErrors, Object.assign({}, props, { key: props.sessionId, sessions: ctx.sessions, storageUi: function () { return ctx.get("tavernStorageUi") } }))'
// 幂等接线（必须在 marker 早返回之前）：旧产物只带 play marker 而无该接线时**就地补齐**，不静默放过、也不重施其余变换。
function ensureSupersededSessionsWiring(source, label) {
  // 唯一准入：old 与 new 各自计数，只有 (old=1,new=0) 才替换、(old=0,new=1) 才原样通过；其余（0/0、>1、混合）一律 fail-closed。
  const oldHits = source.split(SUPERSEDED_SESSIONS_OLD).length - 1
  const newHits = source.split(SUPERSEDED_SESSIONS_NEW).length - 1
  if (oldHits === 0 && newHits === 1) return source
  if (oldHits === 1 && newHits === 0) return source.replace(SUPERSEDED_SESSIONS_OLD, SUPERSEDED_SESSIONS_NEW)
  throw new Error('干净清理锚点缺失/不唯一：' + label + '-superseded-sessions(old=' + oldHits + ',new=' + newHits + ')')
}
// 协调模块的公开接口是 invalidate；refresh 仅属于它管理的连接 handle。
// 已带PLAY标记的旧产物也须精确迁移：只接管本变换的四个 rebase→协调调用，不泛改作者调用或补假接口。
function ensurePurgeCoordinationWiring(source) {
  const oldCall = 'tavernCoordination.refresh(props.sessionId);'
  const oldPair = /liveTavernView\.rebase\(props\.sessionId\);(\s*)tavernCoordination\.refresh\(props\.sessionId\);/g
  const newPair = /liveTavernView\.rebase\(props\.sessionId\);\s*tavernCoordination\.invalidate\(props\.sessionId\);/g
  const oldHits = source.split(oldCall).length - 1
  const pairs = [...source.matchAll(oldPair)].length
  const newHits = [...source.matchAll(newPair)].length
  // 2026-10-10 变更：失败清理已拆到共享客户端服务（client.js 的 tavernStorageUi.cleanFailure 经桥做
  // live.rebase + coordination.invalidate），组件内的 rebase→invalidate 配对由 4 减到 2 ⇒ 期望值随之收窄；
  // 同时要求**共享消费者在位**（ctx.get('tavernStorageUi') / storageUi.cleanFailure），否则视为接线不完整。
  const sharedHits = (source.match(/storageUi\.cleanFailure\(|ctx\.get\("tavernStorageUi"\)|ctx\.get\('tavernStorageUi'\)/g) || []).length
  if (oldHits !== pairs) throw new Error('干净清理协调接线缺失/归属不明确：旧调用=' + oldHits + '，旧配对=' + pairs + '，新配对=' + newHits)
  if (oldHits === 0) {
    // 已委托菜单不再内联清理配对；只有已安装作者同步链的普通回退catch保留一次。
    const catchPairs=source.includes('// [dsh-tavern-rollback-error-refresh:v1]') ? 1 : 0
    const expected=source.includes(MENU_DELEGATED_MARKER) ? catchPairs : 2 + catchPairs
    if (newHits !== expected || sharedHits < 1) throw new Error('干净清理协调接线缺失/归属不明确：旧调用=0，新配对=' + newHits + '，共享消费者=' + sharedHits)
    return source
  }
  if (newHits !== 0 || pairs !== oldHits) throw new Error('干净清理协调接线缺失/归属不明确：旧调用=' + oldHits + '，旧配对=' + pairs + '，新配对=' + newHits)
  return source.replace(oldPair, 'liveTavernView.rebase(props.sessionId);$1tavernCoordination.invalidate(props.sessionId);')
}
// SupersededTurnErrors 生效点（真作者函数内）：ref + 目标身份 deps + ref 读视图。source/built 同形，幂等。
function applyPlayControlsSupersededState(source, label) {
  if (source.split(PLAY_STATE_ANCHOR).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label + '-state')
  if (source.includes('const failureViewRef = React.useRef(state);')) {
    if (!source.includes('failureViewRef.current = state;')) throw new Error('干净清理 ref 标记不完整：' + label)
    if (!source.includes('var current = failureViewRef.current.view;')) throw new Error('干净清理 onPurge 未接 ref：' + label)
  } else source = source.replace(PLAY_STATE_ANCHOR, PLAY_STATE_NEXT)
  if (!(source.includes('get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }') || source.includes('get failureTarget() { const liveView = failureViewRef.current.view;'))
    || !source.includes("get failureCleanupReason() { return failureViewRef.current.view && failureViewRef.current.view.failureCleanupReason || '' }")) {
    throw new Error('干净清理 getter 未接 ref：' + label)
  }
  if (source.split(PLAY_DEPS_ANCHOR).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label + '-deps')
  if (!source.includes(PLAY_DEPS_NEXT)) source = source.replace(PLAY_DEPS_ANCHOR, PLAY_DEPS_NEXT)
  if (source.split(PLAY_EFFECT_DECL_ANCHOR).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label + '-effect')
  if (!source.includes('const failureTargetKey = (function (view) {')) source = source.replace(PLAY_EFFECT_DECL_ANCHOR, PLAY_EFFECT_DECL_NEXT)
  if (!source.includes('failureTargetKey')) throw new Error('干净清理目标身份 key 未接线：' + label)
  // 旧代 getter（只读 view.failureTarget）就地升级为统一 rollbackTarget 优先：已施缝树否则 purge 永远 disabled。
  const PURGE_GETTER_OLD = 'get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }'
  const PURGE_GETTER_NEW = 'get failureTarget() { const liveView = failureViewRef.current.view; return (liveView && (liveView.rollbackTarget || liveView.failureTarget)) || null }'
  if (source.includes(PURGE_GETTER_OLD)) source = source.replace(PURGE_GETTER_OLD, PURGE_GETTER_NEW)
  if (!source.includes(PURGE_GETTER_NEW)) throw new Error('干净清理 getter 未统一到 rollbackTarget：' + label)
  return source
}
export function applyErrorPurgeTurnControlsTransform(source) {
  if (source.includes(MARKER_TURN)) {
    // 幂等：不要求兜底块存在（它已退役）；只核仍在位的 toggle/文案接线（marker 恰两处：onclick + 文案）。
    if (source.split(MARKER_TURN).length !== 3 || !source.includes('options.onPurge') || !source.includes('干净清理错误')
      || !source.includes('无法清理此错误') || !source.includes('purgeActive ?')) throw new Error('干净清理标记不完整（turn-error-controls）')
  }
  let out = source.includes(MARKER_TURN) ? source : withDedentedBlock(source, 'toggle.onclick = function () {', `const toggleText = folded(id) ? '查看错误' : dismissed ? '恢复错误提示' : '隐藏此错误';`, (block) => {
    let blockOut = once(block, TOGGLE_ONCLICK_OLD, TOGGLE_ONCLICK_NEXT, 'toggle.onclick')
    blockOut = once(blockOut, TOGGLE_TEXT_OLD, TOGGLE_TEXT_NEXT, 'toggleText')
    return blockOut
  })
  // DOM 兜底已完全退出：这里不再插入任何失败提示行（历史块由卸载/comment engine 处理，不就地刨代码）。
  return out
}
export function applyErrorPurgePlayControlsTransform(source) {
  // getter 归一（旧代"只读 view.failureTarget"⇒统一 rollbackTarget 优先）：**已施缝树也必须在入口就地升级**，
  // 否则已装现场 purge/菜单永远 disabled（升级不能只放在首次施缝路径里）。
  const PURGE_GETTER_OLD_TEXT = 'get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }'
  const PURGE_GETTER_NEW_TEXT = 'get failureTarget() { const liveView = failureViewRef.current.view; return (liveView && (liveView.rollbackTarget || liveView.failureTarget)) || null }'
  if (source.includes(PURGE_GETTER_OLD_TEXT)) source = source.replace(PURGE_GETTER_OLD_TEXT, PURGE_GETTER_NEW_TEXT)
  // 目标身份 key 归一：统一目标（kind/op/branch/revision + nativeAnchor 坐标）必须进入 key，且优先读 rollbackTarget。
  const KEY_TARGET_OLD = 'const target = view && view.failureTarget || null;'
  const KEY_TARGET_NEW = 'const target = view && (view.rollbackTarget || view.failureTarget) || null;'
  const KEY_FIELDS_OLD = 'field(target.branchId), field(target.revision), field(target.endSeq), field(target.eventCount), field(target.rollbackId), reason]);'
  const KEY_FIELDS_NEW = `field(target.branchId), field(target.revision), field(target.endSeq), field(target.eventCount), field(target.rollbackId),
\t\t\t\t\tfield(target.nativeAnchor && target.nativeAnchor.turn), field(target.nativeAnchor && target.nativeAnchor.input), field(target.nativeAnchor && target.nativeAnchor.reply), reason]);`
  if (source.includes(KEY_TARGET_OLD)) source = source.replace(KEY_TARGET_OLD, KEY_TARGET_NEW)
  if (source.includes(KEY_FIELDS_OLD)) source = source.replace(KEY_FIELDS_OLD, KEY_FIELDS_NEW)
  if (source.includes(MENU_DELEGATED_MARKER)) {
    for (const needle of ['onToggle: undefined,', 'const failureViewRef = React.useRef(state);', 'failureViewRef.current = state;',
      'get failureTarget() {',
      'get failureCleanupReason() { return failureViewRef.current.view && failureViewRef.current.view.failureCleanupReason ||',
      'const failureTargetKey = (function (view) {', 'field(target.endSeq)', 'field(target.rollbackId)', '[props.sessionId, revision, failureTargetKey]);',
      'storageUi.cleanFailure(props.sessionId, turn, failureTarget || liveTarget)', 'if (clearIncomplete) {']) {
      if (!source.includes(needle)) throw new Error('干净清理共享标记不完整：' + needle)
    }
    if (source.split(MARKER_PLAY).length !== 4 || source.includes(PLAY_DEPS_ANCHOR)) throw new Error('干净清理共享标记数量/依赖不完整')
    return ensurePurgeCoordinationWiring(ensureDelegatedMenu(upgradeOrdinaryMenuRpc(ensureSupersededSessionsWiring(source, 'play-controls'), 'play-controls')))
  }
  if (source.includes(MARKER_PLAY)) {
    // 核实际共享消费者及各布局等待合同；不要求已经退出算法的说明文字，也不禁止旧内联布局必需的 clear-only wait。
    if (source.split(MARKER_PLAY).length !== 4 || !source.includes('onToggle: undefined,') || !source.includes('get failureTarget()')
      || !source.includes('menuFailureTarget') || source.includes(PLAY_ONTOGGLE_OLD)
      || !source.includes('const failureViewRef = React.useRef(state);')
      || !source.includes('get failureTarget() {')
      || !source.includes('const failureTargetKey = (function (view) {') || !source.includes('field(target.endSeq)') || !source.includes('var targetCompare = function (ft, cft) {') || !source.includes('var menuMismatch = targetCompare(menuFailureTarget, cft);') || !source.includes('storageUi.cleanFailure(props.sessionId, turn, failureTarget || liveTarget)') || !source.includes('精简清理未接线') || !source.includes('清理未确认目标失败轮，不更新本地状态') || !(source.includes('回退同步尚未接线') || source.includes('回退已落盘，但宿主缺少同连接同步消费者')) || !(source.includes(MENU_WAIT_ANCHOR) || (source.includes(MENU_CLEAR_GUARD.trim()) && source.includes('await props.sessions.waitForTavernRollbackSync(result && result.view && result.view.rolledBack && result.view.rolledBack.sync);') && source.includes('if (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) {')))
      || !source.includes('var storageUi = typeof props.storageUi === "function" ? props.storageUi() : undefined;')
      || source.split('[props.sessionId, revision, failureTargetKey]);').length !== 2
      || source.includes(PLAY_DEPS_ANCHOR)) throw new Error('干净清理标记不完整（play-controls）')
    if (source.split(PLAY_STATE_ANCHOR).length !== 2) throw new Error('干净清理锚点缺失/不唯一：play-controls-state')
    // 旧版已施缝（PLAY marker 齐全）但缺 sessions 接线/普通目标行：仍过 helper **精确补齐一次**，再次调用 no-op；
    // 不新增 PLAY marker（marker 统计恒为 4），也不重施其余变换。
    return ensureDelegatedMenu(upgradeOrdinaryMenuRpc(ensurePurgeCoordinationWiring(ensureSupersededSessionsWiring(source, 'play-controls')), 'play-controls'))
  }
  let out = once(source, PLAY_ONTOGGLE_OLD, PLAY_ONTOGGLE_NEXT, 'onToggle→onPurge')
  // 菜单 RPC 行：built 经 sync 链后带 \t 缩进与混合换行，仅行内容替换，不碰行首缩进。
  const lineStart = out.indexOf(PLAY_MENU_RPC_OLD)
  if (lineStart < 0) throw new Error('干净清理锚点缺失/不唯一：menu-rpc-failureTarget')
  const indentEnd = out.lastIndexOf('\n', lineStart) + 1
  const indent = out.slice(indentEnd, lineStart)
  // 布局分流（已核事实）：split 的单文件与 built 产物**都**经作者动作变换（built 走 core-host-transform:138
  // → rollback-sync-author:58）⇒ 两处作者 wait 都在位，只改条件与后续重投影；只有 inline（作者 main.js 无 include）没有这条 wait
  // ⇒ 追加 clearIncomplete 专用 wait+refresh（normal rollback 原逻辑不动，不 double wait）。
  const waitHits = out.split(MENU_WAIT_ANCHOR).length - 1
  if (waitHits > 1) throw new Error('干净清理锚点缺失/不唯一：menu-wait→rebase')
  const menuText = PLAY_MENU_RPC_NEXT
    .replace('/*DSH_PURGE_CLEAR_GUARD*/', waitHits === 1 ? '' : MENU_CLEAR_GUARD)
    .replace('/*DSH_PURGE_RECEIPT_REQUIRED*/', MENU_RECEIPT_REQUIRED)
    .replace('/*DSH_PURGE_CLEAR_WAIT*/', waitHits === 1 ? '' : MENU_CLEAR_WAIT_BLOCK)
  const rpcNext = menuText.replace(/\n\t\t\t\t\t/g, '\n' + indent).replace(/\n\t\t\t\t\t\t/g, '\n' + indent + '\t')
  out = out.slice(0, lineStart) + rpcNext + out.slice(lineStart + PLAY_MENU_RPC_OLD.length)
  // R2 普通目标：目标行插在清洗块之前（clear-only 守卫的失败判定不动），普通 RPC 行换成对象凭据。
  // 清洗块按真实缩进定位；标题行插入点用行的前缀回填，避免对缩进/空白做假设。
  const markerAt = (() => { const {comp,end}=rollbackRegion(out); const at=out.indexOf(MARKER_PLAY,comp); if(at<0||at>=end) throw new Error('干净清理锚点缺失/不唯一：menu-rpc-failureTarget'); return at })()
  const lineStartOfMarker = out.lastIndexOf('\n', markerAt) + 1
  const indentOfMarker = out.slice(lineStartOfMarker, markerAt)
  const ordinaryLines = MENU_ORDINARY_TURN.replace(/\n\t\t\t\t\t/g, '\n' + indentOfMarker).replace(/\n\t\t\t\t\t\t/g, '\n' + indentOfMarker + '\t').slice(1)
  out = out.slice(0, markerAt) + ordinaryLines + '\n' + indentOfMarker + out.slice(markerAt)
  if (out.split(MENU_ORDINARY_RPC_OLD).length !== 2) throw new Error('干净清理锚点缺失/不唯一：menu-rpc-ordinary')
  out = out.replace(MENU_ORDINARY_RPC_OLD, MENU_ORDINARY_RPC_NEW)
  // R2 重试闭环（作者侧 state）：普通回退必须优先使用「本次失败保留下来的同目标凭据」。
  if (out.includes('const [rollbackRetryState,')) out = out.replace('{ expectedTurn: ordinaryTurn }', '{ expectedTurn: rollbackRetryTarget || ordinaryTurn }')
  if (out.includes(MENU_ORDINARY_RPC_OLD)) throw new Error('干净清理锚点缺失/不唯一：menu-rpc-ordinary-residue')
  if (!out.includes(MENU_ORDINARY_ANCHOR)) throw new Error('干净清理锚点缺失/不唯一：menu-ordinary-anchor')
  if (waitHits === 1) out = out.replace(MENU_WAIT_ANCHOR, MENU_WAIT_NEXT)
  else {
    // built/inline 布局的旧软视图行：清理场景不得安装旧 view（常规回退保持原 pipeline）。
    // 该行在同文件其它函数里也出现（真夹具 3 处）⇒ 只在菜单 rollback() 区间 [RPC 行, 本函数 catch) 内替换，绝不全局替换。
    const regionEnd = out.indexOf('} catch (err) {', lineStart)
    const end = regionEnd > lineStart ? regionEnd : out.length
    const region = out.slice(lineStart, end)
    const softHits = region.split(SOFT_VIEW_ANCHOR).length - 1
    if (softHits > 1) throw new Error('干净清理锚点缺失/不唯一：menu-soft-view')
    if (softHits === 1) out = out.slice(0, lineStart) + region.replace(SOFT_VIEW_ANCHOR, SOFT_VIEW_NEXT) + out.slice(end)
  }
  return ensureDelegatedMenu(ensurePurgeCoordinationWiring(ensureSupersededSessionsWiring(applyPlayControlsSupersededState(out, 'play-controls'), 'play-controls')))
}
