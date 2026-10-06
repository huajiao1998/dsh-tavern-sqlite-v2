// 两条版本线共享的有限作者启动保护；不读取会话或数据库。
export const AUTHOR_SAFETY_MARKER='// [tavern-uninstall-author-no-auto-migration:20261002]'
export const STARTUP_MIGRATION="  if (sessionPatch.view().hostVersion === '0.1.5-rc.2') {\n    const open = (persistence?.tracker?.openHandles?.size || 0) + (persistence?.tracker?.writers?.size || 0)\n    if (open) console.warn('dsh-tavern: 会话已经打开，旧档留到下次启动再迁移')\n    else await migrateInstalledLegacySessions(resolveTavernDataRoot(), sessionPatch.loadSessionCatalog)\n  }"
const pairs=[
 [STARTUP_MIGRATION,`${AUTHOR_SAFETY_MARKER}\n  // 卸载后的作者原版也不能全量读写旧Session；用户授权保留这一独立护栏。`],
 ["migrateLegacy: process.env.DSH_TAVERN_COMPATIBLE_STORAGE === '1'",'migrateLegacy: false'],
 ['    const recoveredIndex = await initializeRuntimeState()',`    // 独立保护：启动期资源迁移/历史恢复会遍历原件，卸包测试不执行这些读写或自动结算。\n    const recoveredIndex = { chats: [] }`],
 ["    setImmediate(function () {\n      recoverRuntimeHistory(recoveredIndex).catch(function (error) {\n        console.error('dsh-tavern: 后台恢复历史对话失败', error && error.message || error)\n      })\n    })",'    // 历史恢复仅不自动启动；用户正常明确操作仍沿作者原接口。'],
]
function replaceOnce(source,before,after){if(source.split(before).length!==2)throw new Error('原件保护锚点缺失或不唯一：'+before.slice(0,70));return source.replace(before,after)}
export function assertProtectedAuthor(source){
 for(const [raw,safe]of pairs){if(source.split(safe).length!==2||source.includes(raw))throw new Error('独立原件保护内容漂移/不完整，拒绝根据marker猜测')}
 if(/migrateInstalledLegacySessions\s*\(/.test(source))throw new Error('独立原件保护仍有Session迁移调用')
 return true
}
export function protectAuthorStartup(source){
 if(source.includes(AUTHOR_SAFETY_MARKER)){assertProtectedAuthor(source);return source}
 if(!source.includes(STARTUP_MIGRATION)&&/\[dsh-tavern-|from ['"]\.\/domain\/(?:storage-[\w-]+|legacy-view-seams)\.js['"]/.test(source))throw new Error('前像污染：作者入口仍含插件接缝但缺原件保护原文；拒绝从缝合态猜恢复')
 let next=source;for(const [raw,safe]of pairs)next=replaceOnce(next,raw,safe)
 assertProtectedAuthor(next);return next
}
// 仅纯转换内存中恢复legacy转换需要的两处锚点；安全启动历史块仍保留。
// 产物由legacy转换立即替换成插件自己的禁止迁移入口，不在运行树写回危险作者块。
export function prepareProtectedLegacySource(source){
 if(!source.includes(AUTHOR_SAFETY_MARKER))return source
 assertProtectedAuthor(source)
 let next=source;for(const [raw,safe]of pairs.slice(0,2))next=replaceOnce(next,safe,raw)
 return next
}
