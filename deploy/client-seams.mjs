// 客户端接缝按作者实际include归属施加；不替换整份旧产物，不改变读口/页面协议。
import {existsSync,readFileSync} from 'node:fs'
import path from 'node:path'
import {applyClientRollbackTransform} from './core-host-transform.mjs'
import {applyAuthorRollbackActionTransform,applyAuthorRollbackRuntimeTransform,applyAuthorCoordinationTransform} from './rollback-sync-author-transform.mjs'
import {applyClientHistoryAuthorityTransform} from './client-history-authority-transform.mjs'
import {applyRollbackSyncInstallTransform,applyRollbackSyncActionGuardTransform} from './rollback-sync-install-transform.mjs'
import {applyClipboardTransform} from './clipboard-transform.mjs'
import {applyBrowserUiLifetimeBootstrapTransform as uiBootstrap,applyBrowserUiLifetimeRuntimeTransform as uiRuntime} from './browser-ui-lifetime-transform.mjs'
import {applyCurrentResourceClientTransform as resourceClient} from './session-current-resource-transform.mjs'
// current 资源客户端语义（放宽revision/不落cache）与当前书守卫不依赖浏览器符号，故在两条通道上都施加：
// 整份bundle与拆分后的确切include目标。后台截断同连接同步（session-cut-sync）**不在此处**——
// 它挂在运行时 rollback-sync-client-transform.mjs 的同连接安装器上（见该文件 applySessionCutSyncClientTransform）。
export function clientCoreWrites(appDir,{browserWrite}={}){
 const source='tavern-plugin/src/client/',built='tavern-plugin/lib/client.js'
 const read=rel=>readFileSync(path.join(appDir,rel),'utf8'),writes=new Map(),main=read(source+'main.js')
 let bundle=applyRollbackSyncInstallTransform(applyClipboardTransform(applyClientRollbackTransform(read(built))))
 bundle=resourceClient(uiRuntime(uiBootstrap(bundle)))
 if(browserWrite)bundle=browserWrite(bundle)
 writes.set(built,bundle)
 if(main.includes('// @include features/play-controls.js')){
  for(const rel of ['features/play-controls.js','features/turn-history.js','ui/error-center.js','helper-resources.js','runtime/helper-bootstrap.js','runtime/helper-script-runtime.js','modules/tavern-coordination.js'])if(!existsSync(path.join(appDir,source+rel)))throw Error('拆分客户端缺确切include目标：'+rel)
  writes.set(source+'main.js',applyRollbackSyncInstallTransform(applyAuthorRollbackRuntimeTransform(main),{runtimeOnly:true}))
  writes.set(source+'modules/tavern-coordination.js',applyAuthorCoordinationTransform(read(source+'modules/tavern-coordination.js')))
  writes.set(source+'features/play-controls.js',applyRollbackSyncActionGuardTransform(applyAuthorRollbackActionTransform(read(source+'features/play-controls.js'))))
  writes.set(source+'features/turn-history.js',applyClientHistoryAuthorityTransform(read(source+'features/turn-history.js')))
  writes.set(source+'ui/error-center.js',applyClipboardTransform(read(source+'ui/error-center.js')))
  writes.set(source+'helper-resources.js',resourceClient(read(source+'helper-resources.js')))
  writes.set(source+'runtime/helper-bootstrap.js',uiBootstrap(read(source+'runtime/helper-bootstrap.js')))
  let ui=uiRuntime(read(source+'runtime/helper-script-runtime.js'))
  if(browserWrite)ui=browserWrite(ui)
  writes.set(source+'runtime/helper-script-runtime.js',ui)
 }else{
  let inline=applyRollbackSyncInstallTransform(applyClipboardTransform(applyClientRollbackTransform(main)))
  inline=resourceClient(uiRuntime(uiBootstrap(inline)))
  if(browserWrite)inline=browserWrite(inline)
  writes.set(source+'main.js',inline)
 }
 return writes
}
