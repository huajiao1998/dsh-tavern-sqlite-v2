// 自有 RPC 宿主侧（标准插件半边）：把浏览器 callHost 的 7 个动作委托给**同一**保存服务 tavernSaveActions。
// 保留原通道语义：固定白名单、16KB、JSON 对象、非空 sessionId、执行前 active 门、envelope、同服务实例。
// 不做同动作去重（旧路由没有该行为，不得擅造 registry）。
// 不重试、不另造取消/分叉；错误码随 envelope 回传（业务码原样保留）。
const MAX_REQUEST_BYTES = 16 * 1024
const HANDLER_PREFIX = 'dsh-tavern-sqlite-v2/'
/** 上游 HANDLER_NAME 只接受小写字母/数字与 . _ : / - ⇒ 旧驼峰方法名统一转 kebab（两侧必须同式）。 */
export function handlerName(method) { return HANDLER_PREFIX + String(method).replace(/[A-Z]/g, character => '-' + character.toLowerCase()) }
export const SAVE_HANDLERS = Object.freeze({
  sqliteSaveStatus: 'status', sqliteSavePrepare: 'prepare', sqliteSaveClaim: 'claim',
  sqliteSaveComplete: 'complete', sqliteSaveRecover: 'recover', sqliteSaveRelease: 'release',
  sqliteVariablesQuery: 'variables',
})

export function registerSaveHandlers(ctx) {
  const tavern = (typeof ctx.get === 'function' ? ctx.get('tavern') : undefined) || ctx.tavern
  const actions = (typeof ctx.get === 'function' ? ctx.get('tavernSaveActions') : undefined) || ctx.tavernSaveActions
  if (!tavern || typeof tavern.handle !== 'function') throw new Error('存档处理器缺少tavern服务（需 inject: [\'tavern\']）')
  if (!actions) throw new Error('存档处理器缺少tavernSaveActions服务')
  for (const target of Object.values(SAVE_HANDLERS)) {
    if (typeof actions[target] !== 'function') throw new Error('存档处理器缺少保存服务方法：' + target)
  }
  let active = true
  const disposers = []
  try {
  for (const [method, target] of Object.entries(SAVE_HANDLERS)) {
    const handler = args => {
      if (!active) return { ok: false, error: '存档插件已经卸载，停止后续操作', errorCode: 'DSH_TAVERN_SAVE_UNAVAILABLE' }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: '存档接口参数必须是对象', errorCode: 'DSH_TAVERN_BAD_ARGS' }
      if (typeof args.sessionId !== 'string' || !args.sessionId) return { ok: false, error: '存档接口缺少会话身份', errorCode: 'DSH_TAVERN_SESSION_REQUIRED' }
      if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_REQUEST_BYTES) return { ok: false, error: '存档接口请求超过16KB限制', errorCode: 'DSH_TAVERN_REQUEST_TOO_LARGE' }
      const run = (async () => {
        try {
          if (!active) return { ok: false, error: '存档插件已经卸载，未执行操作', errorCode: 'DSH_TAVERN_SAVE_UNAVAILABLE' }
          const result = await actions[target](args)                 // 捕获同一服务实例；不重试、不另造分叉
          return Object.assign({ ok: true }, result, { runtimeGeneration: actions.runtimeGeneration })
        } catch (error) {
          return { ok: false, error: String(error?.message || error), errorCode: typeof error?.code === 'string' ? error.code : 'DSH_TAVERN_SAVE_FAILED' }
        }
      })()
      return run
    }
    disposers.push(tavern.handle(handlerName(method), handler))
  }
  } catch (error) {
    // partial 回滚：注册中途失败（如重名）不得留下任何已生效 handler
    for (const dispose of disposers) { try { if (typeof dispose === 'function') dispose() } catch { /* 忽略 */ } }
    throw error
  }
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers) { try { if (typeof dispose === 'function') dispose() } catch { /* 已随 fiber 释放 */ } }
  }
}

export function apply(ctx) { ctx.effect(() => registerSaveHandlers(ctx), 'dsh-tavern-sqlite-v2: 自有存档RPC处理器') }
