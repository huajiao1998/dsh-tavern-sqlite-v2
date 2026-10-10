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
// 菜单路径复用作者同步消费者（applyAuthorRollbackActionTransform）已插入的 wait：alreadyClean 不等待，clearIncomplete 在 wait 后定向 rebase+refresh（不 double wait）。
const MARKER_TURN = '// [dsh-tavern-error-purge-turn:v1]'
const MARKER_PLAY = '// [dsh-tavern-error-purge-play:v1]'
// 目标身份比较的唯一实现（同一文本按两处缩进渲染：面板 24 空格、菜单走 \n\t\t\t\t\t 约定；自包含不引用文件外符号）。
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
                    get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null },
                    get failureCleanupReason() { return failureViewRef.current.view && failureViewRef.current.view.failureCleanupReason || '' },
                    onPurge: async function (turn, failureTarget) {
                        // 清理的**唯一实现**在自有 UI 服务（tavernStorageUi.cleanFailure）。SupersededTurnErrors
                        // 定义在 register(ctx) 之外，函数体内拿不到 ctx ⇒ 由注册语句注入 storageUi 取用函数
                        // （registration 闭包里的 ctx 合法），这里只经 props 调用，不假设存在全局 ctx。
                        var current = failureViewRef.current.view;
                        var liveTarget = (current && current.failureTarget) || null;
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
const PLAY_MENU_RPC_NEXT = `${MARKER_PLAY}
var menuFailureTarget = clearIncomplete ? (rollbackViewState.view && rollbackViewState.view.failureTarget) || null : null;
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
\t\t\t\tconst target = view && view.failureTarget || null;
\t\t\t\tconst reason = String(view && view.failureCleanupReason || "");
\t\t\t\tif (!target) return JSON.stringify([null, reason]);
\t\t\t\tconst field = function (value) { return value === undefined || value === null ? null : value };
\t\t\t\treturn JSON.stringify([field(target.chatId), field(target.sessionId), field(target.kind), field(target.turn), field(target.operationId),
\t\t\t\t\tfield(target.branchId), field(target.revision), field(target.endSeq), field(target.eventCount), field(target.rollbackId), reason]);
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
    // 严格 2：拆出共享清理后组件内只应剩 2 对（4 说明未拆干净，0 说明接线缺失）；共享消费者必须在位。
    if (newHits !== 2 || sharedHits < 1) throw new Error('干净清理协调接线缺失/归属不明确：旧调用=0，新配对=' + newHits + '，共享消费者=' + sharedHits)
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
  if (!source.includes('get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }')
    || !source.includes("get failureCleanupReason() { return failureViewRef.current.view && failureViewRef.current.view.failureCleanupReason || '' }")) {
    throw new Error('干净清理 getter 未接 ref：' + label)
  }
  if (source.split(PLAY_DEPS_ANCHOR).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label + '-deps')
  if (!source.includes(PLAY_DEPS_NEXT)) source = source.replace(PLAY_DEPS_ANCHOR, PLAY_DEPS_NEXT)
  if (source.split(PLAY_EFFECT_DECL_ANCHOR).length !== 2) throw new Error('干净清理锚点缺失/不唯一：' + label + '-effect')
  if (!source.includes('const failureTargetKey = (function (view) {')) source = source.replace(PLAY_EFFECT_DECL_ANCHOR, PLAY_EFFECT_DECL_NEXT)
  if (!source.includes('failureTargetKey')) throw new Error('干净清理目标身份 key 未接线：' + label)
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
  if (source.includes(MARKER_PLAY)) {
    // 核实际共享消费者及各布局等待合同；不要求已经退出算法的说明文字，也不禁止旧内联布局必需的 clear-only wait。
    if (source.split(MARKER_PLAY).length !== 4 || !source.includes('onToggle: undefined,') || !source.includes('get failureTarget()')
      || !source.includes('menuFailureTarget') || source.includes(PLAY_ONTOGGLE_OLD)
      || !source.includes('const failureViewRef = React.useRef(state);')
      || !source.includes('get failureTarget() { return failureViewRef.current.view && failureViewRef.current.view.failureTarget || null }')
      || !source.includes('const failureTargetKey = (function (view) {') || !source.includes('field(target.endSeq)') || !source.includes('var targetCompare = function (ft, cft) {') || !source.includes('var menuMismatch = targetCompare(menuFailureTarget, cft);') || !source.includes('storageUi.cleanFailure(props.sessionId, turn, failureTarget || liveTarget)') || !source.includes('精简清理未接线') || !source.includes('清理未确认目标失败轮，不更新本地状态') || !(source.includes('回退同步尚未接线') || source.includes('回退已落盘，但宿主缺少同连接同步消费者')) || !(source.includes(MENU_WAIT_ANCHOR) || (source.includes(MENU_CLEAR_GUARD.trim()) && source.includes('await props.sessions.waitForTavernRollbackSync(result && result.view && result.view.rolledBack && result.view.rolledBack.sync);') && source.includes('if (clearIncomplete && !(result && result.view && result.view.rolledBack && result.view.rolledBack.alreadyClean === true)) {')))
      || !source.includes('var storageUi = typeof props.storageUi === "function" ? props.storageUi() : undefined;')
      || source.split('[props.sessionId, revision, failureTargetKey]);').length !== 2
      || source.includes(PLAY_DEPS_ANCHOR)) throw new Error('干净清理标记不完整（play-controls）')
    if (source.split(PLAY_STATE_ANCHOR).length !== 2) throw new Error('干净清理锚点缺失/不唯一：play-controls-state')
    // 旧版已施缝（PLAY marker 齐全）但缺 sessions 接线：仍过 helper **精确补齐一次**，再次调用 no-op；
    // 不新增 PLAY marker（marker 统计恒为 4），也不重施其余变换。
    return ensurePurgeCoordinationWiring(ensureSupersededSessionsWiring(source, 'play-controls'))
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
  return ensurePurgeCoordinationWiring(ensureSupersededSessionsWiring(applyPlayControlsSupersededState(out, 'play-controls'), 'play-controls'))
}
