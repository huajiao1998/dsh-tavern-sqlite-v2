// 标准插件宿主半边：作者 data/plugins 扫描加载的普通 apply 入口。
// 命令注册仍交 host-actions（同一 ctx），自有存档 RPC 处理器由 save-handlers 注册。
import * as hostActions from './host-actions.js'
import { registerSaveHandlers } from './save-handlers.js'
// Cordis ownerOf 取 fiber.name；模块显式命名，不能继承 root/作者 fiber 的名字。
export const name = 'dsh-tavern-sqlite-v2'
export const inject = ['tavern', 'tavernSaveActions', 'commands']
export function apply(ctx) {
  hostActions.apply(ctx)
  ctx.effect(() => registerSaveHandlers(ctx), 'dsh-tavern-sqlite-v2: 自有存档RPC处理器')
}
