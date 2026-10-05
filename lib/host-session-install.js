// dsh-tavern-sqlite-v2 · 宿主会话补丁的**唯一**安装入口（共享句柄）
//
// 为什么需要它：这份补丁有两个调用方 ——
//   ① 我们的 entry `host-patch.js`（原型级接管 + 原档只读 guard）；
//   ② 作者树 `tavern-plugin/lib/index.js`（getSessionPatchStatus / bodyEditor / 回退等都要它）。
// 两边必须"一份实现、一个句柄"：
//   · 谁先到谁真正安装（同步 claim 抢位，见 claimHostSessionPatch 的长注释）；
//   · 后到者 await 同一个 promise，拿到**同一个真实句柄** —— 而不是 claim 占位对象，
//     否则作者侧的 `sessionPatch.view()/serverReady/clientSource` 会退化成 pending 状态。
//
// ⚠ 作者树原先自带一份官方 `installHostSessionPatch`。它会把官方 stat/open/… 盖回我们的
// 存储接缝上：2026-09-30 在洁净实例实测，症状是补丁装完后 `persistence.stat` 变成官方
// 实现（对显式绑定的原档返回 undefined）⇒ 原档 workspace 登记失败 ⇒ 整棵插件树 failed
// to load、酒馆起不来。部署缝（deploy/apply-legacy-view-seams.mjs）已把作者树那处调用
// 改成调用本模块，具体见 deploy/host-session-patch.seam.md。
import { claimHostSessionPatch } from './domain/host-session-patch.js'

/** 安装 promise 在占位句柄/真实句柄上的落点；后到者据此等待同一份安装。 */
const READY = Symbol.for('dsh-tavern.host-session-patch.ready')

export async function installSharedHostSessionPatch({ ctx, config = {}, claim } = {}) {
  const persistence = ctx?.get?.('sessionPersistence') ?? ctx?.sessionPersistence
  const query = ctx?.get?.('sessionQuery') ?? ctx?.sessionQuery
  if (!persistence || !query) throw new Error('宿主会话补丁缺少 sessionPersistence / sessionQuery')
  const taken = claim ?? claimHostSessionPatch(persistence)
  if (!taken.ok) {
    const existing = taken.existing
    const pending = existing?.[READY]
    if (pending) return await pending
    // 已由别处（含部署前的作者树实现）安装：如实返回它，不重复安装、不谎报状态。
    return existing
  }
  const promise = (async () => {
    const mod = await import('./domain/host-session-patch.js')
    return await mod.installHostSessionPatch({ persistence, query, ...config })
  })()
  try { Object.defineProperty(taken.claim, READY, { value: promise, configurable: true }) } catch { /* 忽略 */ }
  const handle = await promise
  try { Object.defineProperty(handle, READY, { value: promise, configurable: true }) } catch { /* 忽略 */ }
  return handle
}
