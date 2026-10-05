// 自有 UI 仅通过作者的纯 React 服务桥渲染在「酒馆状态」存档区。
// 不贡献输入区按钮，不访问 DOM，不载第二份 React；变量查询/工具仍保留在 Host。
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
`
    let sessionsRef = null
    let active = false
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
      const response = await fetch('/api/dsh-tavern/' + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(args || {}), sessionId }), signal: AbortSignal.timeout(8000),
      })
      const result = await response.json()
      if (!response.ok || !result?.ok) throw new Error(result?.error || '存档接口失败（HTTP ' + response.status + '）')
      return result
    }
    const isDatabase = result => result?.migrated === true && result.legacy === false
      && result.readonly === false && /^sqlite:gen:\d+(?::empty)?$/.test(result.stamp || '')
    const isOriginal = result => result?.legacy === true && result.migrated === false
      && result.readonly === true && /^legacy:\d+:\d+$/.test(result.stamp || '')

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

      if (state.phase === 'ready' && isDatabase(result)) return null
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

    return {
      inject: ['sessions'],
      apply(ctx) {
        active = true
        sessionsRef = ctx.sessions
        const ui = {
          active: true,
          renderSavePanel(props) {
            const id = props?.sessionId || ''
            const owner = sessionsRef.subagentAddress?.(id)?.parentSessionId || id
            return ui.active ? h(MigrationPanel, { sessionId: owner, key: owner }) : null
          },
        }
        ctx.provide('tavernStorageUi', ui)
        ctx.effect(() => {
          ctx.emit(UI_EVENT)
          return () => { active = false; ui.active = false; attempts.clear(); ctx.emit(UI_EVENT) }
        }, 'dsh-tavern-sqlite-v2: 存档区服务桥')
      },
    }
  },
})
