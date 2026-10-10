// 自有 UI 走两条公开面：① 页头 slots 入口（conversation.session.header.utilities）打开完整存档面板；
// ② 输入区 dock（conversation.input.dock）的失败提示条 + 共享清理服务 tavernStorageUi。
// 作者 live view 只经 tavernStorageView 桥只读转发（不建第二 view、不轮询）；变量查询/工具仍保留在 Host。
// 用户点击：只读 prepare → 私有 SQLite claim → 官方 native fork → complete → open。
window.__ModuleLoader__.load({
  id: 'dsh-tavern-sqlite-v2',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const UI_EVENT = 'tavern-storage-ui/change'
    const ZH = {
      title: '数据库存档', reading: '正在读取存档状态…',
      description: '原档只读，保留原档并创建独立的数据库分叉后继续游玩。',
      migrate: '分叉迁移到数据库存档', busy: '正在创建独立分叉…',
      done: '已创建数据库分叉', created: '原档保持只读，已创建的独立数据库分叉可从侧栏打开。',
      pending: '分叉尚未完成；未确认原生分叉身份时请人工核实，不要重复创建。',
      recoverable: '已有分叉身份已安全保存。点击下方按钮完成这个分叉，不会创建第二个会话。',
      uncertain: '操作结果尚未确认，请核实已有分叉，不要重新创建。',
      retry: '重试完成已有分叉', failed: '失败', unavailable: '未接线',
      missing: '已记录的分叉目标已不存在（可能已被删除），旧记录仍标记为已完成，因此不能直接重新分叉。',
      release: '目标已删除，允许重新创建', releaseBusy: '正在释放旧分叉记录…',
      releaseNote: '释放只清除这条已完成的分叉记录：不会删除原生会话，也不会自动创建数据库存档；释放后仍需你再次点击上面的创建按钮。',
      released: '旧分叉记录已释放，现在可以重新创建数据库存档。',
      dbStatus: '当前为数据库存档。',
    }
    // 样式仅引用语义主题变量；透明混色不携带固定皮肤色。
    const CSS = `
.dsh-sqlite-save{padding-block:12px;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);border-block-start:1px solid var(--dsw-alias-border-l2)}
.dsh-sqlite-save__title{font-weight:600;margin-block-end:6px}
.dsh-sqlite-save__description{color:var(--dsw-alias-label-secondary);margin:0 0 8px}
.dsh-sqlite-save__button{appearance:none;font:inherit;padding:6px 12px;min-height:30px;border:1px solid transparent;border-radius:var(--dsh-tavern-radius-sm,6px);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsh-sqlite-save__button:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}
.dsh-sqlite-save__button:active:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}
.dsh-sqlite-save__button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-sqlite-save__button:disabled{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);cursor:not-allowed}
.dsh-sqlite-save__release{display:flex;flex-direction:column;gap:8px;align-items:flex-start;margin-block-start:10px;padding-block-start:10px;border-block-start:1px solid var(--dsw-alias-border-l2)}
.dsh-sqlite-save__note{color:var(--dsw-alias-label-secondary);margin:0}
.dsh-sqlite-save__release-button{align-self:flex-start}
.dsh-sqlite-save__error{color:var(--dsh-tavern-accent-error,var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary)));margin-block:8px 0;overflow-wrap:anywhere}
.dsh-sqlite-save__head{display:flex;align-items:center;gap:6px}
.dsh-sqlite-save__icon{display:inline-flex;align-items:center;justify-content:center;flex:none}
.dsh-sqlite-save__state{color:var(--dsw-alias-label-secondary);margin:0 0 8px}
.dsh-sqlite-save__dialog{width:min(420px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:80vh;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;overflow:auto}
.dsh-sqlite-save__dialog::backdrop{background:color-mix(in srgb,var(--dsw-alias-label-primary) 45%,transparent)}
.dsh-sqlite-save__dialog-head{display:flex;align-items:center;gap:6px;margin-block-end:8px}
.dsh-sqlite-save__dialog-head .dsh-sqlite-save__title{margin:0;flex:1 1 auto}
.dsh-sqlite-save__close{appearance:none;font:inherit;line-height:1;min-height:24px;min-width:24px;padding:2px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-sqlite-save__close:hover{color:var(--dsw-alias-label-primary)}
.dsh-sqlite-save__failure-strip{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--dsw-tavern-accent-error,var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2)));border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,var(--dsw-alias-border-l2)) 10%,transparent)}
.dsh-sqlite-save__failure-text{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-primary)}
.dsh-sqlite-save__failure-clean{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px}
`
    let sessionsRef = null
    let active = false
    let tavernUiRef = null   // apply 捕获注入的 tavernUi；停用/卸载时清空（不得 late call）
    // 酒馆 rc.2 locale 契约尚未取得，不能把 Desktop 0.2 API 猜成相同；文案集中待受支持接口接入。
    const translate = key => ZH[key]
    // 只保存当前插件代的已知尝试，tab 重挂仍复用目标；整页重载由 Host pending 禁重复。
    const attempts = new Map()
    /**
     * 对账只清**本页已成功完成过**的本地尝试：服务端已确认没有任何分叉记录（forked=false/pending=false）时
     * 它已陈旧，留着会永久挡住重新创建。未完成、无 SID 或结果未知的尝试一律保留 —— 绝不代替用户清除。
     */
    function reconcileAttempts(sessionId, result) {
      const known = attempts.get(sessionId)
      if (known?.done !== true) return
      if (result?.forked === false && result?.pending === false) attempts.delete(sessionId)
    }

    async function saveRpc(method, args, sessionId) {
      if (!active) throw new Error('存档插件已经卸载，停止后续操作')
      if (!sessionId) throw new Error('拿不到当前会话 id')
      const tavernUi = tavernUiRef
      if (!tavernUi || typeof tavernUi.callHost !== 'function') throw new Error('存档RPC缺少tavernUi服务（inject 需含 tavernUi）')
      // 8s 定向窗口：race + 清理计时器；不自动重试、不另造取消或重新分叉。
      let timer = null
      const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('存档接口超时（8s）')), 8000) })
      let envelope
      try {
        envelope = await Promise.race([
          // 与宿主注册名同式：上游 HANDLER_NAME 只允许小写 ⇒ 驼峰方法名转 kebab
          tavernUi.callHost('dsh-tavern-sqlite-v2/' + String(method).replace(/[A-Z]/g, character => '-' + character.toLowerCase()), { ...(args || {}), sessionId }), timeout,
        ])
      } finally { if (timer !== null) clearTimeout(timer) }
      if (!envelope || envelope.ok !== true) {
        const error = new Error(envelope?.error || '存档接口失败')
        if (typeof envelope?.errorCode === 'string') error.code = envelope.errorCode   // 业务错误码原样保留
        throw error
      }
      return envelope
    }
    const isDatabase = result => result?.migrated === true && result.legacy === false
      && result.readonly === false && /^sqlite:gen:\d+(?::empty)?$/.test(result.stamp || '')
    const isOriginal = result => result?.legacy === true && result.migrated === false
      && result.readonly === true && /^legacy:\d+:\d+$/.test(result.stamp || '')

    /**
     * 目标身份比较的**唯一实现**（与 deploy/error-purge-transform.mjs 的 TARGET_COMPARE 逐字同规则）：
     * kind（body/native-only 二者之一）/ turn / branchId / revision 必须 exact；body 认非空 operationId；
     * native-only 不得带 operationId 且 endSeq/eventCount === endSeq+1；chatId/sessionId 仅在两边都是字符串时比。
     * 返回 "" 表示同一身份，否则返回不一致原因（用于拒绝清理与拒绝接受回执）。
     */
    function targetCompare(ft, cft) {
      if (!ft || !cft || typeof ft !== 'object' || typeof cft !== 'object') return '目标缺失'
      const kindOf = value => (value === 'native-only' ? 'native-only' : (value === undefined || value === 'body' ? 'body' : null))
      const ftKind = kindOf(ft.kind)
      const cftKind = kindOf(cft.kind)
      if (ftKind === null || cftKind === null || ftKind !== cftKind) return 'kind 不一致'
      if (!Number.isSafeInteger(cft.turn) || Number(cft.turn) !== Number(ft.turn)) return 'turn 不一致'
      if (typeof ft.branchId !== 'string' || ft.branchId === '' || cft.branchId !== ft.branchId) return 'branchId 不一致'
      if (!Number.isSafeInteger(cft.revision) || !Number.isSafeInteger(ft.revision) || Number(cft.revision) !== Number(ft.revision)) return 'revision 不一致'
      if (ftKind === 'native-only') {
        if (ft.operationId !== undefined || cft.operationId !== undefined) return 'native 不得带 operationId'
        if (!Number.isSafeInteger(ft.endSeq) || ft.endSeq <= 0 || !Number.isSafeInteger(ft.eventCount) || ft.eventCount !== ft.endSeq + 1) return 'native 目标形状不合法'
        if (!Number.isSafeInteger(cft.endSeq) || cft.endSeq <= 0 || !Number.isSafeInteger(cft.eventCount) || cft.eventCount !== cft.endSeq + 1) return 'native 回执形状不合法'
        if (Number(cft.endSeq) !== Number(ft.endSeq) || Number(cft.eventCount) !== Number(ft.eventCount)) return 'native 身份不一致'
      } else if (typeof cft.operationId !== 'string' || cft.operationId === '' || cft.operationId !== ft.operationId) return 'operationId 不一致'
      if (typeof ft.chatId === 'string' && typeof cft.chatId === 'string' && cft.chatId !== ft.chatId) return 'chatId 不一致'
      if (typeof ft.sessionId === 'string' && typeof cft.sessionId === 'string' && cft.sessionId !== ft.sessionId) return 'sessionId 不一致'
      return ''
    }

    function MigrationPanel(props) {
      const sessionId = props.sessionId || ''
      const [state, setState] = React.useState({ phase: 'reading', result: null, error: '' })
      const [busy, setBusy] = React.useState(false)
      const [releasing, setReleasing] = React.useState(false)
      const running = React.useRef(false)
      const mounted = React.useRef(false)
      React.useEffect(() => {
        mounted.current = true
        return () => { mounted.current = false }
      }, [])
      React.useEffect(() => {
        let alive = true
        setState({ phase: 'reading', result: null, error: '' })
        saveRpc('sqliteSaveStatus', {}, sessionId)
          .then(result => {
            if (!alive) return
            reconcileAttempts(sessionId, result)
            setState({ phase: 'ready', result, error: '' })
          })
          .catch(error => { if (alive) setState({ phase: 'failed', result: null, error: String(error?.message || error) }) })
        return () => { alive = false }
      }, [sessionId])
      const result = state.result
      const known = attempts.get(sessionId)
      const persistentRetry = !known && result?.recoverable === true && result?.pending === true
        && ['bound', 'created'].includes(result?.targetInfo?.state)
        && !!result?.targetInfo?.targetSessionId && result.targetInfo.targetSessionId !== sessionId
      const retry = (!!known?.targetSessionId && !known.done) || persistentRetry
      const canAct = state.phase === 'ready' && isOriginal(result) && result.forked === false
        && (!known || retry) && (result.pending === false || (result.pending === true && retry))
      // 释放门（严格 fail-closed）：只认后端权威组合 —— 仍是只读原档 + forked=true + pending=false
      // + **明确 targetExists=false**（目标确已不存在）+ 完整 targetInfo(state/targetChatId/targetSessionId)。
      // targetExists 缺失、pending 未知、targetInfo 不完整一律不放行：宁可禁用，绝不猜目标身份。
      const canRelease = state.phase === 'ready' && isOriginal(result) && result.forked === true
        && result.pending === false && result.targetExists === false
        && result.targetInfo?.state === 'complete'
        && String(result.targetInfo?.targetChatId || '') !== ''
        && String(result.targetInfo?.targetSessionId || '') !== ''

      const migrate = React.useCallback(async () => {
        // 禁用只是视觉门；同步 ref 抵御同一事件循环的双击/旧 handler 重入。
        if (!active || running.current || !canAct) return
        running.current = true
        setBusy(true)
        let attempt = attempts.get(sessionId)
        try {
          if (!sessionsRef || typeof sessionsRef.fork !== 'function' || typeof sessionsRef.open !== 'function') throw new Error('当前宿主缺少原生分叉/打开服务')
          if (persistentRetry) {
            const target = result.targetInfo.targetSessionId
            const completed = await saveRpc('sqliteSaveRecover', { targetSessionId: target }, sessionId)
            if (!isDatabase(completed) || completed.sessionId !== target || !completed.chatId || completed.chatId === result.chatId) throw new Error('恢复回执未确认独立的数据库目标')
            if (mounted.current) setState({ phase: 'ready', result: { ...result, forked: true, pending: false }, error: '' })
            if (active) await sessionsRef.open(completed.sessionId)
            return
          }
          if (!attempt?.targetSessionId) {
            if (attempt) throw new Error(translate('uncertain'))
            const plan = await saveRpc('sqliteSavePrepare', {}, sessionId)
            const claimed = await saveRpc('sqliteSaveClaim', plan, sessionId)
            if (!claimed.token || !claimed.sourceSessionId) throw new Error('分叉占位未返回完整身份')
            attempt = { plan: claimed, targetSessionId: '', done: false }
            attempts.set(sessionId, attempt)
            if (!active) throw new Error('存档插件已经卸载，未创建分叉')
            const target = await sessionsRef.fork({ sessionId: claimed.sourceSessionId, atSeq: claimed.atSeq, increaseTitle: false })
            if (!target || target === claimed.sourceSessionId) throw new Error('宿主没有返回独立的新会话')
            attempt.targetSessionId = target
          }
          const completed = await saveRpc('sqliteSaveComplete', { ...attempt.plan, targetSessionId: attempt.targetSessionId }, sessionId)
          if (!isDatabase(completed) || completed.sessionId !== attempt.targetSessionId
            || !completed.chatId || completed.chatId === attempt.plan.sourceChatId) throw new Error('完成回执未确认独立的数据库目标')
          attempt.done = true
          if (mounted.current) setState({ phase: 'ready', result: { ...result, forked: true, pending: false }, error: '' })
          if (active) await sessionsRef.open(completed.sessionId)
        } catch (error) {
          // complete 超时可能仍在服务器运行；只查询状态，不重新 fork。
          let refreshed = result
          try { refreshed = await saveRpc('sqliteSaveStatus', {}, sessionId) } catch { /* 保留真实错误与已知尝试，不假称成功。 */ }
          if (mounted.current) setState({ phase: 'ready', result: refreshed,
            error: String(error?.message || error) + (attempt && !attempt.targetSessionId ? '；' + translate('uncertain') : '') })
        } finally {
          running.current = false
          if (mounted.current) setBusy(false)
        }
      }, [sessionId, canAct, result])

      const release = React.useCallback(async () => {
        // 独立显式动作：只释放后端那条已完成的分叉记录 —— 不 fork、不创建、不碰原生会话。
        if (!active || running.current || !canRelease) return
        running.current = true
        setReleasing(true)
        const info = result?.targetInfo || {}
        try {
          await saveRpc('sqliteSaveRelease', { targetChatId: String(info.targetChatId),
            targetSessionId: String(info.targetSessionId) }, sessionId)
          // 释放成功：只忘掉本页**已成功完成**的旧尝试（留着会永久挡住重新创建）；
          // 未完成/无 SID 的未知尝试永不代清。
          const settled = attempts.get(sessionId)
          if (settled?.done === true) attempts.delete(sessionId)
          let refreshed = result
          try { refreshed = await saveRpc('sqliteSaveStatus', {}, sessionId) } catch {
            // 释放已由服务端确认（回执 ok）；刷新失败不谎称失败，但也不能继续显示"目标缺失带释放按钮"。
            refreshed = { ...result, forked: false, pending: false, targetInfo: undefined, targetExists: undefined }
          }
          if (mounted.current) setState({ phase: 'ready', result: refreshed, error: '', notice: translate('released') })
        } catch (error) {
          // 失败或结果未知：保留已知尝试与该按钮，只按服务端状态对账，绝不代 fork。
          let refreshed = result
          try { refreshed = await saveRpc('sqliteSaveStatus', {}, sessionId) } catch { /* 保留真实错误，不假称已释放。 */ }
          reconcileAttempts(sessionId, refreshed)
          if (mounted.current) setState({ phase: 'ready', result: refreshed, error: String(error?.message || error) })
        } finally {
          running.current = false
          if (mounted.current) setReleasing(false)
        }
      }, [sessionId, canRelease, result])

      // 已在数据库存档：状态 tab 里保持不渲染（原契约）；从页头按钮打开时必须显示状态而不是空面板。
      if (state.phase === 'ready' && isDatabase(result)) {
        if (!props.alwaysShowStatus) return null
        return h('section', { className: 'dsh-tavern-status-section dsh-sqlite-save' },
          h('style', null, CSS),
          h('div', { className: 'dsh-sqlite-save__head' },
            h('span', { className: 'dsh-sqlite-save__icon', 'aria-hidden': 'true' }, props.icon || null),
            h('div', { className: 'dsh-sqlite-save__title' }, translate('title'))),
          h('p', { className: 'dsh-sqlite-save__state', role: 'status' }, translate('dbStatus')))
      }
      const label = busy ? translate('busy') : result?.forked === true ? translate('done')
        : retry && result?.pending === true ? translate('retry') : translate('migrate')
      const description = state.notice || (state.phase === 'reading' ? translate('reading')
        : canRelease ? translate('missing')
        : result?.forked === true ? translate('created')
        : persistentRetry ? translate('recoverable')
        : result?.pending === true ? translate('pending')
        : known && !known.done && !known.targetSessionId ? translate('uncertain') : translate('description'))
      return h('section', { className: 'dsh-tavern-status-section dsh-sqlite-save', 'aria-busy': busy || releasing },
        h('style', null, CSS),
        h('div', { className: 'dsh-sqlite-save__title' }, translate('title')),
        h('p', { className: 'dsh-sqlite-save__description', role: 'status' }, description),
        h('button', { className: 'dsh-tavern-btn dsh-sqlite-save__button', type: 'button',
          disabled: !canAct || busy || releasing, onClick: migrate }, label),
        canRelease ? h('div', { className: 'dsh-sqlite-save__release' },
          h('p', { className: 'dsh-sqlite-save__note' }, translate('releaseNote')),
          h('button', { className: 'dsh-tavern-btn dsh-sqlite-save__button dsh-sqlite-save__release-button',
            type: 'button', disabled: releasing, onClick: release },
          releasing ? translate('releaseBusy') : translate('release'))) : null,
        state.error ? h('p', { className: 'dsh-sqlite-save__error', role: 'alert' }, translate('failed') + '：' + state.error) : null)
    }

    // ── 页头入口：直接可见的「数据库存档」按钮 + React 声明式 dialog 承载完整 MigrationPanel ──
    // 只经公开 slots 服务注册（与作者同形），不改作者 source anchor、不劫持原有菜单、不接管状态位置。
    let DbIcon = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      // 用宿主原生图标；旧导出变体先试 16，再试不带后缀，最后退为纯文字（不手工 SVG）。
      DbIcon = primitives?.IconDatabaseOutline16 || primitives?.IconDatabaseOutline || null
    } catch (_) { DbIcon = null }

    function dbIconNode() {
      return DbIcon ? h(DbIcon, { size: 16, 'aria-hidden': 'true' }) : null
    }

    /**
     * **React 声明式 dialog**：h('dialog') + ref + useEffect(showModal)，取消/关闭由 React 状态控制。
     * 不再用 document.createElement / ReactDOM.createRoot：内容与宿主 React 同根，没有第二个 root、没有 loading 死窗口。
     * backdrop 只认"点在 dialog 矩形之外"（点内部 padding 不关）；Escape 走 React onCancel；关闭/卸载自动归还焦点。
     */
    function HeaderSaveDialog({ sessionId, open, onClose }) {
      const ref = React.useRef(null)
      const opener = React.useRef(null)
      // 打开前先抓住当前焦点元素（showModal 会先抢走焦点，之后再读就晚了）；关闭/卸载时一律归还。
      React.useEffect(() => {
        if (open) opener.current = document.activeElement
        return () => {
          const previous = opener.current
          opener.current = null
          if (previous && typeof previous.focus === 'function') { try { previous.focus() } catch (_) {} }
        }
      }, [open])
      React.useEffect(() => {
        const dialog = ref.current
        if (!dialog) return undefined
        if (open && typeof dialog.showModal === 'function' && !dialog.open) {
          try { dialog.showModal() } catch (_) { try { dialog.setAttribute('open', '') } catch (_) {} }
        } else if (open && typeof dialog.showModal !== 'function' && !dialog.open) {
          // 无原生 showModal：明确退化为 open 属性（非模态），不装作模态。
          try { dialog.setAttribute('open', '') } catch (_) {}
        } else if (!open && dialog.open && typeof dialog.close === 'function') {
          try { dialog.close() } catch (_) {}
        }
        return undefined
      }, [open])
      // 主体变更 / 卸载：自动关闭，避免面板停在别人家的 session 上。
      React.useEffect(() => () => {
        const dialog = ref.current
        if (dialog && dialog.open && typeof dialog.close === 'function') { try { dialog.close() } catch (_) {} }
      }, [sessionId])
      // owner 变更：主动 close（不靠卸载时机），并通知上层清掉打开态。
      const firstOwner = React.useRef(sessionId)
      React.useEffect(() => {
        if (firstOwner.current === sessionId) return
        firstOwner.current = sessionId
        const dialog = ref.current
        if (dialog && dialog.open && typeof dialog.close === 'function') { try { dialog.close() } catch (_) {} }
        onClose()
      }, [sessionId, onClose])
      if (!open) return null
      const onPointerDown = event => {
        if (event.target !== ref.current) return
        const rect = ref.current.getBoundingClientRect()
        const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom
        if (outside) onClose()
      }
      return h('dialog', {
        ref, className: 'dsh-sqlite-save__dialog', 'aria-label': translate('title'),
        onCancel: event => { event.preventDefault(); onClose() },
        onPointerDown,
      },
      h('div', { className: 'dsh-sqlite-save__dialog-head' },
        h('span', { className: 'dsh-sqlite-save__icon', 'aria-hidden': 'true' }, dbIconNode()),
        h('span', { className: 'dsh-sqlite-save__title' }, translate('title')),
        h('button', { className: 'dsh-tavern-btn dsh-sqlite-save__close', type: 'button',
          title: '关闭', 'aria-label': '关闭', onClick: onClose }, '×')),
      h(MigrationPanel, { sessionId, alwaysShowStatus: true }))
    }

    /** 页头 utility 按钮：图标 + 文字，点击展开完整面板（声明式 dialog；不在页头里直接执行分叉）。 */
    function HeaderSaveButton(props) {
      const raw = props && (props.sessionId || (props.scope && props.scope.sessionId))
      const owner = raw ? (sessionsRef?.subagentAddress?.(raw)?.parentSessionId || raw) : ''
      // 面板打开时锁住 owner：session 切换即关闭并按新 owner 重开，绝不让面板停在旧档上。
      const [panel, setPanel] = React.useState({ open: false, owner: '' })
      const disabled = !owner
      const close = React.useCallback(() => setPanel({ open: false, owner: '' }), [])
      // owner 变化 ⇒ 主动关掉面板（不靠 dialog 内部锁旧参数判断）。
      React.useEffect(() => {
        setPanel(current => (current.open && current.owner !== owner ? { open: false, owner: '' } : current))
      }, [owner])
      // 只有面板 owner 与当前 owner 一致才允许打开，且交给 dialog 的永远是**当前** owner。
      const dialogOwner = panel.open && panel.owner === owner ? owner : ''
      return h(React.Fragment, null,
        h('style', null, CSS),
        h('button', {
          className: 'dsh-tavern-btn dsh-sqlite-save__button dsh-sqlite-save__header-button',
          type: 'button', title: translate('title'), disabled,
          'aria-haspopup': 'dialog', 'aria-expanded': dialogOwner ? 'true' : 'false',
          onClick: () => { if (!disabled) setPanel({ open: true, owner }) },
        },
        h('span', { className: 'dsh-sqlite-save__icon', 'aria-hidden': 'true' }, dbIconNode()),
        translate('title')),
        h(HeaderSaveDialog, { sessionId: dialogOwner || owner, open: Boolean(dialogOwner) && !disabled, onClose: close }))
    }

    // 失败提示条用宿主原生 trash 图标（不手工 SVG）；缺失则退为纯文字。
    let TrashIcon = null
    try {
      const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
      TrashIcon = primitives?.IconTrashOutline16 || null
    } catch (_) { TrashIcon = null }

    /**
     * 输入区 dock 的失败提示条：**只在当前存在 canonical failureTarget 时**渲染（正常态返回 null，不占位）。
     * handle 由 ui.selectFailure(owner) 在 useMemo 里取一次（stable），订阅走作者同一 live view select；
     * 不轮询、不另发 getSession、不造 DOM 行、不做软隐藏。
     */
    function FailureCleanupStrip(props) {
      const raw = props && (props.sessionId || (props.scope && props.scope.sessionId))
      const owner = raw ? (sessionsRef?.subagentAddress?.(raw)?.parentSessionId || raw) : ''
      const ui = typeof props.tavernStorageUi === 'object' && props.tavernStorageUi ? props.tavernStorageUi : null
      const handle = React.useMemo(() => (ui && owner ? ui.selectFailure(owner) : null), [ui, owner])
      const snapshot = React.useSyncExternalStore(
        handle && typeof handle.subscribe === 'function' ? handle.subscribe : () => () => {},
        handle && typeof handle.getSnapshot === 'function' ? handle.getSnapshot : () => null,
        handle && typeof handle.getSnapshot === 'function' ? handle.getSnapshot : () => null)
      const current = React.useMemo(
        () => (ui && typeof ui.readFailureTarget === 'function' ? ui.readFailureTarget(handle) : null),
        [ui, handle, snapshot])
      const running = props.useSession ? Boolean(props.useSession(snap => snap && snap.running)) : false
      // activity 直接取作者同一选择里的字段（不猜、不另读）：结算 pending/running 期间禁止清理。
      const activity = snapshot && snapshot.view && snapshot.view.activity ? snapshot.view.activity : null
      const settlementActive = Boolean(activity) && activity.role === 'settlement'
        && (activity.phase === 'pending' || activity.phase === 'running')
      const blocked = running || settlementActive
      // 同组件内互斥用 ref（不触发额外 render，也不因 React strict 双挂载而漏防重入）。
      const inFlight = React.useRef(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const mounted = React.useRef(false)
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      if (!ui || !handle || !current) return null
      const onClick = async () => {
        if (inFlight.current || blocked || !ui.active) return
        inFlight.current = true
        setBusy(true)
        setError('')
        try {
          await ui.cleanFailure(owner, current.turn, current.target)
        } catch (failure) {
          if (mounted.current) setError(String(failure?.message || failure))
        } finally {
          inFlight.current = false
          if (mounted.current) setBusy(false)
        }
      }
      return h('div', { className: 'dsh-sqlite-save__failure-strip', role: 'status' },
        h('span', { className: 'dsh-sqlite-save__failure-text' },
          '当前失败轮：第 ' + current.turn + ' 轮未完成' + (current.reason ? '（' + current.reason + '）' : '')),
        h('button', {
          className: 'dsh-tavern-btn dsh-sqlite-save__button dsh-sqlite-save__failure-clean',
          type: 'button', disabled: busy || blocked,
          title: settlementActive ? '正文正在后台结算，稍后可清理'
            : (running ? '当前会话仍在运行，稍后可清理' : '干净清理这一轮失败（物理删除未完成尾部）'),
          onClick,
        },
        TrashIcon ? h('span', { className: 'dsh-sqlite-save__icon', 'aria-hidden': 'true' }, h(TrashIcon, { size: 16 })) : null,
        busy ? '清理中…' : '干净清理本轮'),
        error ? h('span', { className: 'dsh-sqlite-save__error', role: 'alert' }, error) : null)
    }

    return {
      inject: ['sessions', 'slots', 'tavernStorageView', 'tavernUi'],
      apply(ctx) {
        active = true
        tavernUiRef = (typeof ctx.get === 'function' ? ctx.get('tavernUi') : undefined) || ctx.tavernUi || null
        sessionsRef = ctx.sessions
        // 读作者自有 live view 的**唯一桥**（rollback-sync-author-transform 注入 tavernStorageView）：
        // 只转发 selectFailure/refresh，不建第二 view、不轮询、不另发 getSession。
        const bridge = () => {
          const view = typeof ctx.get === 'function' ? ctx.get('tavernStorageView') : undefined
          return view && view.apiVersion === 2 ? view : undefined
        }
        const ownerOf = id => sessionsRef?.subagentAddress?.(id)?.parentSessionId || id
        const ui = {
          active: true,
          renderSavePanel(props) {
            const id = props?.sessionId || ''
            const owner = ownerOf(id)
            return ui.active ? h(MigrationPanel, { sessionId: owner, key: owner }) : null
          },
          /**
           * 当前失败目标（canonical，唯一来源=作者 live view 的 failureTarget）。
           * 无目标即返回 null（正常态不占位、不造 DOM 行、不做软隐藏）。
           */
          selectFailure(sessionId) {
            // 原样转发作者 liveTavernView.select 的 **handle**（{getSnapshot,subscribe} 才是 useSyncExternalStore 需要的形状）；
            // 只额外挂一个只读 getTarget，绝不包/现造 getSnapshot。组件侧用 useMemo 保持稳定，不做全局缓存。
            const view = bridge()
            if (!view || typeof view.selectFailure !== 'function') return null
            const owner = ownerOf(sessionId)
            return owner ? ui.decorateFailureHandle(view.selectFailure(owner)) : null
          },
          /** 给作者 handle 挂一次 getTarget（幂等）；不包 getSnapshot，绝不现造 state 对象。 */
          decorateFailureHandle(handle) {
            if (!handle || typeof handle.getSnapshot !== 'function') return null
            if (typeof handle.getTarget === 'function') return handle
            handle.getTarget = () => {
              const snap = handle.getSnapshot()
              const live = snap && snap.view ? snap.view : null
              const target = (live && live.failureTarget) || null
              const turn = Number(target && target.turn)
              if (!Number.isSafeInteger(turn) || turn < 1) return null
              return { turn, reason: String((live && live.failureCleanupReason) || ''), target }
            }
            return handle
          },
          /** 从 stable handle 读当前 canonical 失败目标（无状态/无目标 ⇒ null，正常态不占位）。 */
          readFailureTarget(handle) {
            if (!handle || typeof handle.getSnapshot !== 'function') return null
            const snap = handle.getSnapshot()
            const live = snap && snap.view ? snap.view : null
            const target = (live && live.failureTarget) || null
            const turn = Number(target && target.turn)
            if (!Number.isSafeInteger(turn) || turn < 1) return null
            return { turn, reason: String((live && live.failureCleanupReason) || ''), target }
          },
          /** 兼容旧调用：订阅作者 live view 的同一选择（内部用 stable handle）。 */
          subscribeFailure(sessionId, notify) {
            const handle = ui.selectFailure(sessionId)
            return handle && typeof handle.subscribe === 'function' ? handle.subscribe(notify) : () => {}
          },
          /**
           * 失败清理的**唯一实现**（页头/dock/作者错误行都调它）：后端身份与同连接 wait、定向 refresh 全在此。
           * 步骤：取当前 canonical failureTarget → 校验请求目标身份（含 rollbackId 过期）→ 经桥 rpc("rollbackTurn")
           * → 回执核 cleanedFailureTarget 与请求 same 身份 → alreadyClean 只 refresh 不 wait → 否则等
           * sessions.waitForTavernRollbackSync(rb.sync) 后定向 refresh。不安装旧 view、不 global notify。
           * 返回后端回执原文（调用方据此判断）。抛错＝未清理/未确认，绝不静默成功。
           */
          async cleanFailure(sessionId, turn, failureTarget) {
            if (!active) throw new Error('存档插件已经卸载，停止后续操作')
            const owner = ownerOf(sessionId)
            if (!owner) throw new Error('拿不到当前会话 id')
            const view = bridge()
            if (!view) throw new Error('精简清理未接线：找不到 tavernStorageView 桥，拒绝清理')
            // 桥能力在 RPC 之前一次核清（缺任一即响亮失败，绝不 typeof 静默跳过）。
            if (typeof view.selectFailure !== 'function' || typeof view.request !== 'function' || typeof view.refresh !== 'function') {
              throw new Error('精简清理桥不完整：缺 selectFailure/request/refresh，拒绝清理')
            }
            const handle = ui.selectFailure(owner)
            if (!handle) throw new Error('精简清理未接线：拿不到失败目标读句柄，拒绝清理')
            const current = handle.getTarget()
            if (!current) throw new Error('当前视图没有可清理的失败目标，拒绝清理')
            if (!Number.isSafeInteger(Number(turn)) || Number(turn) < 1 || Number(turn) !== current.turn) {
              throw new Error('清理目标不是当前最新失败轮，拒绝清理')
            }
            const liveTarget = current.target
            // 无论是否同一引用都必须过一遍 targetCompare（形状/身份/新鲜度统一判定），再过 rollbackId。
            const ft = failureTarget || liveTarget
            const staleReason = targetCompare(ft, liveTarget)
            if (staleReason !== '') throw new Error('清理目标已过期（与当前视图不一致），拒绝清理：' + staleReason)
            if ((ft.rollbackId || null) !== (liveTarget.rollbackId || null)) throw new Error('清理目标已过期（重试身份不一致），拒绝清理')
            if (!sessionsRef || typeof sessionsRef.waitForTavernRollbackSync !== 'function') {
              throw new Error('回退同步尚未接线或尚未就绪，未执行清理')
            }
            const resp = await view.request('rollbackTurn', { expectedTurn: Number(turn), failureTarget: ft }, owner)
            const rb = resp && resp.view && resp.view.rolledBack
            if (!rb || !rb.cleanedFailureTarget) throw new Error('清理未确认目标失败轮，不更新本地状态')
            const targetMismatch = targetCompare(ft, rb.cleanedFailureTarget)
            if (targetMismatch !== '') throw new Error('清理回执目标与请求不一致，拒绝更新：' + targetMismatch)
            if (rb.alreadyClean !== true) await sessionsRef.waitForTavernRollbackSync(rb.sync)
            // 卸载后不得再触发新插件代的 refresh；回执仍照常返回给调用方判定。
            if (!active) return resp
            view.refresh(owner)
            return resp
          },
        }
        ctx.provide('tavernStorageUi', ui)
        // 页头直接可见入口：与作者同形的 slots.inject/register；slots 是硬要求（缺失/失败必须响亮抛错，不静默不贡献 UI）。
        ctx.effect(() => {
          const slots = ctx.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            throw new Error('缺少 slots 服务，无法注册页头「数据库存档」入口')
          }
          return slots.inject('conversation.session.header.utilities', () => slots.register({
            name: 'conversation.session.header.utilities',
            id: 'dsh-tavern-sqlite-v2:save',
            order: 70,
            label: translate('title'),
          }, HeaderSaveButton))
        }, 'dsh-tavern-sqlite-v2: 页头数据库存档入口')
        // 输入区 dock：作者真用的 slot 名就是 "conversation.input.dock"（冻结 42852b0 源 play-controls.js 中四处注册，
        // order -130/-120/-115/-110）。本入口 order 20 立在其后 ⇒ 位置=现工具栏之下、输入框之上；
        // 正常态无 failureTarget 时组件返回 null（不占位、不永久空位、不造 DOM 行）。
        ctx.effect(() => {
          const slots = ctx.slots
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
            throw new Error('缺少 slots 服务，无法注册输入区失败清理条')
          }
          return slots.inject('conversation.input.dock', () => slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-tavern-sqlite-v2:failure-clean',
            order: 20,
            label: '失败清理',
          }, props => h(FailureCleanupStrip, { ...props, tavernStorageUi: ui, key: props && props.sessionId ? String(props.sessionId) : '' })))
        }, 'dsh-tavern-sqlite-v2: 输入区失败清理条')
        ctx.effect(() => {
          ctx.emit(UI_EVENT)
          return () => { active = false; tavernUiRef = null; ui.active = false; attempts.clear(); ctx.emit(UI_EVENT) }
        }, 'dsh-tavern-sqlite-v2: 存档区服务桥')
      },
    }
  },
})
