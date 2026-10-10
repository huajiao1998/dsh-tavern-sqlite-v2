// 正常启动的宿主补丁入口；实现仍只有父目录中的一份，不复制宿主模块。
import { apply as applyHostPatch, inject } from '../host-patch.js'
import { installSharedHostSessionPatch } from '../lib/host-session-install.js'
export { inject }
export async function apply(ctx, config) {
  await applyHostPatch(ctx, config)
  const handle = await installSharedHostSessionPatch({ ctx, config })
  if (handle?.serverReady !== true) throw new Error('宿主补丁未就绪，拒绝启动混合后端：' + (handle?.reason || handle?.status || 'unknown'))
  // 只表达该启动依赖已完成，防作者在补丁尚未就绪时加载；不是另一个存储或业务服务。
  ctx.provide('tavernStorageBootstrapReady', true)
}
