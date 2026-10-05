// wait:false不能从registry丢失仍在运行的任务；延迟交接任务可等待，不后台继续软清。
function once(source, old, next) {
  if (source.split(old).length !== 2) throw new Error('回退静止接缝锚点未命中/不唯一：'+old.slice(0,80))
  return source.replace(old,next)
}
export function applySettlementQuiescenceTransform(source) {
  const marker='// [dsh-tavern-settlement-quiescence:v1]'
  if (source.includes(marker)) {
    if (!source.includes('if (wait) await job.promise.catch(() => {})') || source.includes('if (!wait) jobs.delete(chatId)')) throw new Error('结算静止消费者不完整')
    return source
  }
  let next=marker+'\n'+once(source,'    if (!wait) jobs.delete(chatId)\n    else await job.promise.catch(() => {})','    if (wait) await job.promise.catch(() => {})')
  next=once(next,'      if (jobs.get(chatId) === job) jobs.delete(chatId)\n      // Cancellation/deletion', '      // Cancellation/deletion')
  next=once(next,'      if (!disposed && !signal.aborted) await onSettled(chatId, signal)', '      try { if (!disposed && !signal.aborted) await onSettled(chatId, signal) }\n      finally { if (jobs.get(chatId) === job) jobs.delete(chatId) }')
  return next
}
export function applyForegroundQuiescenceTransform(source) {
  const marker='// [dsh-tavern-foreground-quiescence:v1]'
  if (source.includes(marker)) {
    if (!source.includes('async function whenIdle(sessionId)') || !source.includes('pending.set(task, sessionId)')) throw new Error('前台延迟任务静止消费者不完整')
    return source
  }
  const old=`  function later(work, label) {
    defer(function () {
      Promise.resolve().then(work).catch(function (error) {
        logger.error('dsh-tavern: ' + label + '失败', error && error.message || error)
      })
    })
  }`
  const next=`  const pending = new Map()
  function later(work, label, sessionId) {
    let settle
    const task = new Promise(resolve => { settle = resolve })
    pending.set(task, sessionId)
    defer(function () {
      Promise.resolve().then(work).catch(function (error) {
        logger.error('dsh-tavern: ' + label + '失败', error && error.message || error)
      }).finally(function () { pending.delete(task); settle() })
    })
  }
  async function whenIdle(sessionId) {
    while (true) {
      const active = [...pending].filter(([, id]) => id === sessionId).map(([task]) => task)
      if (!active.length) return
      await Promise.all(active)
    }
  }`
  let out=marker+'\n'+once(source,old,next)
  out=once(out,"      }, '启动后台结算')", "      }, '启动后台结算', input.sessionId)")
  out=once(out,"    }, '清理未完成前台回合')", "    }, '清理未完成前台回合', input.sessionId)")
  out=once(out,'      if (cleanupFailedTurn !== null) await cleanupFailedTurn(target)', '      // 失败尾部保留至用户统一物理回退；禁止追加空tombstone冒充删除。')
  out=once(out,'  return Object.freeze({ prepare, finalize, end, recover })','  return Object.freeze({ prepare, finalize, end, recover, whenIdle })')
  return out
}
