// 失败错误行"隐藏此错误"改为"干净清理错误"：精确 view.failureTarget（当前最新可重放失败），失败only。
// rpc("rollbackTurn", { expectedTurn: turn, failureTarget: ft })；回执 view.rolledBack.cleanedFailureTarget 核 same turn/op/branch。
// alreadyClean 分支定向 live rebase/refresh 不等待；否则 waitForTavernRollbackSync(view.rolledBack.sync)。
// 不 global notify、不 invalidate 毁新 view；失败保留提示，pending same 目标可重试；历史旧失败行禁用保留。
const MARKER_TURN = '// [dsh-tavern-error-purge-turn:v1]'
const MARKER_PLAY = '// [dsh-tavern-error-purge-play:v1]'
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
            // 干净清理：目标 active 无论 hidden/folded 都是清理；历史旧失败行禁用保留。
            var purgeActive = options.failureTarget && Number(options.failureTarget.turn) === turnErrorRowTurn(row);
            if (!purgeActive) entry.toggle.disabled = true;
            const toggleText = purgeActive ? '干净清理错误' : (folded(id) ? '查看错误' : dismissed ? '恢复错误提示' : '隐藏此错误');`
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
                    failureTarget: state.view && state.view.failureTarget || null,
                    onPurge: async function (turn, failureTarget) {
                        var ft = failureTarget || (state.view && state.view.failureTarget) || null;
                        if (!ft || !Number.isSafeInteger(turn) || turn < 1 || turn !== Number(ft.turn)) throw new Error('清理目标不是当前最新失败轮，拒绝清理');
                        if (typeof props.sessions?.waitForTavernRollbackSync !== "function") throw new Error("回退同步尚未接线或尚未就绪，未执行清理");
                        var resp = await rpc("rollbackTurn", { expectedTurn: turn, failureTarget: ft }, props.sessionId);
                        var rb = resp && resp.view && resp.view.rolledBack;
                        if (!rb || !rb.cleanedFailureTarget) throw new Error('清理未确认目标失败轮，不更新本地状态');
                        if (Number(rb.cleanedFailureTarget.turn) !== Number(ft.turn) || String(rb.cleanedFailureTarget.operationId) !== String(ft.operationId) || String(rb.cleanedFailureTarget.branchId) !== String(ft.branchId)) throw new Error('清理回执目标与请求不一致，拒绝更新');
                        if (rb.alreadyClean === true) {
                            liveTavernView.rebase(props.sessionId);
                            tavernCoordination.refresh(props.sessionId);
                            return resp;
                        }
                        await props.sessions.waitForTavernRollbackSync(rb.sync);
                        setCandidatePanel(null); setRegenPanel(null); setCandidateGuidePanel(null);
                        return resp;
                    },`
// 菜单清未完成：与 sync guard 已施加形态兼容——仅替换 exact RPC 行，不动 guard/其余回调。
// client-seams 顺序：applyAuthorRollbackActionTransform → applyRollbackSyncActionGuardTransform → purge（本变换在 guard 之后）。
const PLAY_MENU_RPC_OLD = `const result = await rpc("rollbackTurn", { expectedTurn: clearIncomplete ? null : targetTurn }, props.sessionId);`
const PLAY_MENU_RPC_NEXT = `${MARKER_PLAY}
var menuFailureTarget = clearIncomplete ? (rollbackViewState.view && rollbackViewState.view.failureTarget) || null : null;
					if (clearIncomplete && !menuFailureTarget) throw new Error('当前没有可安全清理的失败目标，不发送清理请求');
					const result = clearIncomplete
						? await rpc("rollbackTurn", { expectedTurn: Number(menuFailureTarget.turn), failureTarget: menuFailureTarget }, props.sessionId)
						: await rpc("rollbackTurn", { expectedTurn: targetTurn }, props.sessionId);
					if (clearIncomplete && result && result.view && result.view.rolledBack && result.view.rolledBack.cleanedFailureTarget) {
						var cft = result.view.rolledBack.cleanedFailureTarget;
						if (Number(cft.turn) !== Number(menuFailureTarget.turn) || String(cft.operationId) !== String(menuFailureTarget.operationId) || String(cft.branchId) !== String(menuFailureTarget.branchId)) throw new Error('清理回执目标与请求不一致，拒绝更新');
					}
					if (clearIncomplete && result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true) {
						liveTavernView.rebase(props.sessionId);
						tavernCoordination.refresh(props.sessionId);
						return result;
					}`
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
export function applyErrorPurgeTurnControlsTransform(source) {
  if (source.includes(MARKER_TURN)) {
    if (source.split(MARKER_TURN).length !== 3 || !source.includes('options.onPurge') || !source.includes('干净清理错误')) throw new Error('干净清理标记不完整（turn-error-controls）')
    return source
  }
  return withDedentedBlock(source, 'toggle.onclick = function () {', `const toggleText = folded(id) ? '查看错误' : dismissed ? '恢复错误提示' : '隐藏此错误';`, (block) => {
    let out = once(block, TOGGLE_ONCLICK_OLD, TOGGLE_ONCLICK_NEXT, 'toggle.onclick')
    out = once(out, TOGGLE_TEXT_OLD, TOGGLE_TEXT_NEXT, 'toggleText')
    return out
  })
}
export function applyErrorPurgePlayControlsTransform(source) {
  if (source.includes(MARKER_PLAY)) {
    if (source.split(MARKER_PLAY).length !== 3 || !source.includes('onToggle: undefined,') || !source.includes('menuFailureTarget') || source.includes(PLAY_ONTOGGLE_OLD)) throw new Error('干净清理标记不完整（play-controls）')
    return source
  }
  let out = once(source, PLAY_ONTOGGLE_OLD, PLAY_ONTOGGLE_NEXT, 'onToggle→onPurge')
  // 菜单 RPC 行：built 经 sync 链后带 \t 缩进与混合换行，仅行内容替换，不碰行首缩进。
  const lineStart = out.indexOf(PLAY_MENU_RPC_OLD)
  if (lineStart < 0) throw new Error('干净清理锚点缺失/不唯一：menu-rpc-failureTarget')
  const indentEnd = out.lastIndexOf('\n', lineStart) + 1
  const indent = out.slice(indentEnd, lineStart)
  const rpcNext = PLAY_MENU_RPC_NEXT.replace(/\n\t\t\t\t\t/g, '\n' + indent).replace(/\n\t\t\t\t\t\t/g, '\n' + indent + '\t')
  out = out.slice(0, lineStart) + rpcNext + out.slice(lineStart + PLAY_MENU_RPC_OLD.length)
  return out
}
