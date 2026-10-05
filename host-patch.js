// dsh-tavern-sqlite-v2 · 宿主会话内存补丁入口
//
// 把「原型级接管 + 租约中性化」装上（SurfaceManager / Session / 持久化 / 查询），
// 官方包文件零改动 —— 补丁在内存里编译成 data: 模块后换原型。
//
// 为什么由我们的包拥有它：官方与作者的包都会被上游更新覆盖，而这份补丁是我们的核心资产
// （见 AGENTS §六），必须由我们自己拥有与安装。补丁自带版本门禁（0.1.5-rc.2）、
// 8 个官方文件的 SHA-256 钉扎与幂等守卫（persistence[INSTALLED]）——不一致时如实报错，不静默。
// ⚠ 静态导入：占位必须是 apply 的**同步前缀**（第一个 await 之前），见下方注释与
//   lib/domain/host-session-patch.js 的 claimHostSessionPatch()。
import assert from 'node:assert/strict'
import { claimHostSessionPatch } from './lib/domain/host-session-patch.js'
import { installSharedHostSessionPatch } from './lib/host-session-install.js'
import { installRollbackSync } from './lib/rollback-sync.js'
import { isLegacySession, UNMIGRATED_MESSAGE } from './lib/tavern-chat-state.js'

export const inject = ['sessionController', 'sessionPersistence', 'sessionQuery']

/** 原档只读：浏览器订阅只保留冷观察，不把它自动 promotion 成可玩 Agent。 */
export function installNativeReadonlyGuard(ctx) {
  const controller = ctx.get('sessionController')
  const agents = controller?.agents
  assert.equal(typeof controller?.history?.promote, 'function', 'SessionController.history.promote 契约不符')
  assert.equal(typeof agents?.resolve, 'function', 'SessionController.agents.resolve 契约不符')
  // rc.2 的 resolveAgent / resolveObservedAgent 动态转 resolve；create/adopt 则另走 ensureSession。
  const directResumes = ['ensureSession', 'resume', 'resumeObserved', 'createOrAdopt']
  for (const name of directResumes) assert.equal(typeof agents[name], 'function', 'SessionController.agents.' + name + ' 契约不符')
  const denied = (sessionId, observation) => isLegacySession(sessionId) || (observation?.header?.id !== undefined && isLegacySession(observation.header.id))
  const readonlyError = () => Object.assign(new Error(UNMIGRATED_MESSAGE), { code: 'DSH_TAVERN_LEGACY_READ_ONLY' })
  const restore = []
  const dispose = () => { for (let i = restore.length - 1; i >= 0; i--) restore[i]() }
  const replace = (owner, name, wrap) => {
    const original = owner[name]
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    const wrapped = wrap(original)
    Object.defineProperty(owner, name, descriptor
      ? { ...descriptor, value: wrapped }
      : { configurable: true, writable: true, value: wrapped })
    restore.push(() => {
      if (owner[name] !== wrapped) return
      if (descriptor) Object.defineProperty(owner, name, descriptor)
      else delete owner[name]
    })
  }
  ctx.effect(() => {
    try {
      replace(controller.history, 'promote', original => function (...args) {
        const [observation] = args
        if (!isLegacySession(observation.header.id)) return original.apply(this, args)
        // history 的调用方已经 retain()；这里拥有该 lease，跳过 promotion 也必须释放。
        observation[Symbol.dispose]()
      })
      replace(agents, 'resolve', original => function (...args) {
        // resolve 收到的是借用的 observation，仍由调用方释放；只拒绝，不抢 ownership。
        if (denied(args[0], args[1])) return Promise.resolve({ error: readonlyError() })
        return original.apply(this, args)
      })
      for (const name of directResumes) replace(agents, name, original => function (...args) {
        if (denied(args[0], args[1])) return Promise.reject(readonlyError())
        return original.apply(this, args)
      })
    } catch (error) {
      dispose()
      throw error
    }
    return dispose
  }, 'dsh-tavern-sqlite-v2: native 原档只读 guard')
  // 不替换 history.observe / query.observeSession / commands.fork：显式分叉仍冷读原档。
}

export async function apply(ctx, config = {}) {
  const controller = ctx.get('sessionController')
  const persistence = ctx.get('sessionPersistence')
  const query = ctx.get('sessionQuery')
  // console.warn：一定会进 DSH 的 stderr / tavern.log（ctx.logger 不一定进去），
  // 用于回答"这条 entry 到底跑了没 / 补丁装上了没"（2026-09-30 排查 worker 副本时踩过：日志里查不到）
  const say = message => { try { console.warn('[TAVERN-HOST-PATCH] ' + message) } catch { /* 忽略 */ } }
  say('apply 开始 controller=' + (controller ? '有' : '无') + ' persistence=' + (persistence ? '有' : '无') + ' query=' + (query ? '有' : '无'))
  if (!controller || !persistence || !query) {
    try { ctx.logger?.warn?.('[dsh-tavern-sqlite-v2] 缺少 sessionController / sessionPersistence / sessionQuery，跳过宿主会话补丁') } catch { /* 忽略 */ }
    return
  }
  // ⚠ 同步占位，且必须是本函数**第一件事**（在任何 await 之前）：
  //   cordis 并发 apply 各条 entry（Promise.allSettled），作者那条 entry
  //   （dsh-tavern-plugin）也调 installHostSessionPatch —— 两边的幂等守卫在各自
  //   函数**末尾**才 defineProperty，于是双方都会通过守卫，后到者撞上不可配置属性：
  //     TypeError: Cannot redefine property: Symbol(dsh-tavern.host-session-patch.v1)
  //   ⇒ 整棵插件树 failed to load、酒馆起不来（2026-09-30 在 188 洁净实例实测）。
  //   只有"任何 await 之前的同步前缀"能保证抢在对手的守卫检查之前落位。
  const claim = claimHostSessionPatch(persistence)
  // guard 由本 entry 独立拥有；即使内存补丁已由别处安装，原档也不能被自动激活。
  installNativeReadonlyGuard(ctx)
  installRollbackSync(ctx)
  // 安装走共享入口：作者树那条 entry 也调它（部署缝改造后），两边拿到**同一个真实句柄**，
  // 谁先到谁安装、后到者 await 同一 promise；claim 不 ok 时如实复用既有句柄。
  const handle = await installSharedHostSessionPatch({ ctx, config, claim })
  say('安装结果 status=' + handle.status + (handle.reason ? ' reason=' + handle.reason : ''))
  try {
    ctx.logger?.info?.('[dsh-tavern-sqlite-v2] 宿主会话补丁：' + handle.status + (handle.reason ? '（' + handle.reason + '）' : ''))
  } catch { /* 忽略 */ }
  ctx.effect(() => () => { try { handle.dispose?.() } catch { /* 安装器已自行还原所改 */ } },
    'dsh-tavern-sqlite-v2: dispose host session patch')

  // ⚠ 绝不 `return handle` —— cordis 把插件 `apply` 的**返回值当 effect 解释**
  //   （@deepseek-ai/cordis `fiber.ts` `_execute()`）：函数=disposer；Promise=resolve 后
  //   再走同一套判定；可迭代/异步可迭代=逐个 collect；nullish=合法空。
  //   而 `apply` 是 async ⇒ `return <对象>` 先变成 Promise，resolve 后既非函数、
  //   又非 nullish、也没有 then/iterator ⇒ `TypeError('Invalid effect')`
  //   ⇒ 该 entry 装配失败 ⇒ **整棵插件树 failed to load，酒馆起不来**。
  //   2026-09-30 在 188 的并行洁净实例上实测踩中（entry `dsh-tavern-storage-host-patch-v2`）。
  //   句柄靠上面的 ctx.effect 闭包保活，不需要也不允许返回。
}