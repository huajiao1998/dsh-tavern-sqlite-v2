// 回退清理的运行态辅助层（L1.5 / L1.6）—— 实现由本包拥有
//
// 为什么搬进本包：这些辅助层原先在 tavern 包的 lib/domain/rollback-cleanup.js 里，而那个位置
// 会被上游更新覆盖。搬到本包后，上游更新碰不到它们。
//
// L1.5/L1.6 仍在「库截断 + 内存重建 + 投影重折」之后调。
// 旧L1.7全局断开连接已退役；完整cleanRollback在SQL收尾后发布定向同连接通知。
//
// 日志前缀刻意保留 [rollback-cleanup]：线上排障与验收命令按它 grep（改了会打断既有核对）。
/**
 * L1.5 —— 回拨宿主运行时的轮次计数（phase.lastTurn）。
 * 回退后若不回拨，下一次发送会落成 turn+1（气泡错层，见 issues/bug-floor-turn-offset.md）。
 * 无 agentProvider / 无 projections / 无重建值 → 安静跳过（回退是主操作，辅助层不得推翻它）。
 * @param session - DSH 会话对象（读 header.id 打日志；projections.stateOf 的 key）
 * @param services - { agentProvider?: () => agent, projections?: { stateOf(session,'turnBoundary') } }
 * @returns 是否真的回拨了
 */
export function rewindRuntimeTurnCounter(session, services) {
  const agent = typeof services?.agentProvider === 'function' ? services.agentProvider() : undefined
  const phase = agent?.phase
  if (phase === undefined || phase === null || typeof phase !== 'object' || phase.kind === 'running') return false
  const rebuilt = Number(services?.projections?.stateOf?.(session, 'turnBoundary')?.lastTurn ?? NaN)
  if (!Number.isFinite(rebuilt)) return false
  if (Number(phase.lastTurn) === rebuilt) return false
  const from = Number(phase.lastTurn)
  phase.lastTurn = rebuilt
  console.log(`[rollback-cleanup] ${String(session?.header?.id ?? '')}: 运行时轮次计数回拨 phase.lastTurn ${from} → ${rebuilt}`)
  return true
}

// 与实际rc.2 RuntimeContextProjection构造语义一致：从保留surface恢复，不重建监听器。
export function rewindRuntimeAgentState(session, services) {
  const agent = typeof services?.agentProvider === 'function' ? services.agentProvider() : undefined
  if (!agent) return false // 未装载的agent随后由宿主从保留日志构造。
  if (agent.session !== undefined && agent.session !== session) throw new Error('回退清理：agent与Session对象不一致，拒绝重置其它会话')
  if (agent.phase?.kind === 'running') throw new Error('回退清理：运行中的agent不能重置上下文')
  if (agent.runtimeContext !== undefined) {
    const surface = new Set(session.surface.nodes)
    let retained
    for (const event of session.snapshotEvents().toReversed()) {
      const data = event.data
      if (event.type !== 'user/message' || data?.source?.kind !== 'plugin' || data.source.plugin !== '@deepseek-ai/dsh-system-prompt') continue
      retained ??= null
      if (!surface.has(event.seq)) continue
      const content = data.content
      retained = { seq: event.seq, text: content?.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined }
      break
    }
    agent.runtimeContext.retained = retained
  }
  // 下一次调用应重新形成请求系列，不能继承被删轮的发送水位。
  if ('requestHeaderLogged' in agent) agent.requestHeaderLogged = false
  if ('requestSurfaceGeneration' in agent) agent.requestSurfaceGeneration = session.surface.replaceGeneration
  return true
}

/**
 * L1.6 —— 作废 DSH token-meter 对该会话的内存折算状态（states 是 key=会话对象的 WeakMap）。
 * 不作废 ⇒ 游标停在旧时间线的 seq，之后压缩把新旧时间线混在一起，surface-fold 校验抛错，
 * 坏事件卡住重放 ⇒ 自动容量压缩永久失败（2026-09-29 生产实测：seq 1902 / 1879-1879 反复）。
 * @param session - DSH 会话对象（**必须与 states 的 key 同一引用**：都来自宿主会话注册表按 id 取实例）
 * @param services - { tokenMeterProvider?: () => tokenMeter }
 * @returns 是否真的作废了一份状态
 */
export function cleanupTokenMeterState(session, services) {
  let meter
  try {
    meter = typeof services?.tokenMeterProvider === 'function' ? services.tokenMeterProvider() : undefined
  } catch (error) {
    if (services?.requireAuxiliary === true) throw error
    console.warn(`[rollback-cleanup] ${String(session?.header?.id ?? '')}: token-meter 服务解析失败（跳过 L1.6）：${String(error?.message || error)}`)
    return false
  }
  if (meter === undefined || meter === null) {
    if (services?.requireAuxiliary === true) throw new Error('回退缺少token-meter服务，拒绝成功')
    return false
  }
  const states = meter.states
  if (!states || typeof states.delete !== 'function' || (services?.requireAuxiliary === true && typeof states.has !== 'function')) {
    if (services?.requireAuxiliary === true) throw new Error('回退token-meter结构未知，拒绝跳过')
    console.warn(`[rollback-cleanup] ${String(session?.header?.id ?? '')}: token-meter.states 结构不符合预期（宿主版本变化？），跳过 L1.6`)
    return false
  }
  const removed = states.delete(session)
  if (services?.requireAuxiliary === true && states.has(session)) throw new Error('回退token缓存后置核对失败')
  if (removed) {
    console.log(`[rollback-cleanup] ${String(session?.header?.id ?? '')}: token-meter 内存折算状态已作废（下次读取全量重放）`)
  }
  return removed
}

// L1.7已由lib/rollback-sync.js接替：同一control连接定向发布完整状态，旧全局踢线实现已删除。
