// 客户端接缝按作者实际 include 归属施加；不替换整份旧产物，不改变读口/页面协议。
// 阶段③：本模块是**唯一 client 链**——不做 fs 写入、不带 manifest/备份；
// 旧 applyAllSeams 的「存档格式桥 UI」效果已由自有页头 slots 入口取代（本链不再插入作者树桥），布局判定与 UI 缝同用 include 键。
import {existsSync,readFileSync} from 'node:fs'
import path from 'node:path'
import {applyClientRollbackTransform} from './core-host-transform.mjs'
import {applyAuthorRollbackActionTransform,applyAuthorRollbackRuntimeTransform,applyAuthorCoordinationTransform} from './rollback-sync-author-transform.mjs'
import {applyClientHistoryAuthorityTransform} from './client-history-authority-transform.mjs'
import {applyRollbackSyncInstallTransform,applyRollbackSyncActionGuardTransform} from './rollback-sync-install-transform.mjs'
import {applyClipboardTransform} from './clipboard-transform.mjs'
import {applyBrowserUiLifetimeBootstrapTransform as uiBootstrap,applyBrowserUiLifetimeRuntimeTransform as uiRuntime} from './browser-ui-lifetime-transform.mjs'
import {applyCurrentResourceClientTransform as resourceClient} from './session-current-resource-transform.mjs'
import {applyErrorPurgeTurnControlsTransform,applyErrorPurgePlayControlsTransform} from './error-purge-transform.mjs'
// 存档区 UI 缝已退役（apply-save-ui-seam.mjs 不再是本链消费者）：改由自有页头 slots 入口＋完整面板承载。
// current 资源客户端语义（放宽revision/不落cache）与当前书守卫不依赖浏览器符号，故在两条通道上都施加：
// 整份bundle与拆分后的确切include目标。后台截断同连接同步（session-cut-sync）**不在此处**——
// 它挂在运行时 rollback-sync-client-transform.mjs 的同连接安装器上（见该文件 applySessionCutSyncClientTransform）。
export function clientCoreWrites(appDir,{browserWrite,sourceReader}={}){
 const source='tavern-plugin/src/client/',built='tavern-plugin/lib/client.js'
 const feature=source+'features/play-controls.js'
 // sourceReader 注入：主把 buildCore/uninstall 还原的 Map 直接当读源（不落盘 stage）；缺省走真实 fs。
 const fsread=rel=>readFileSync(path.join(appDir,rel),'utf8'),read=sourceReader??fsread,writes=new Map(),main=read(source+'main.js')
 // 布局判定只看 include 键本身（不调用 saveUiTargets：它读本地实际 record 源码，还原投影下会混入非还原字节）。
 const split=main.includes('// @include features/play-controls.js')
 // 链首先做运行时缝（存档区 UI 缝已退役，不再对作者树插入桥）。
 let bundle=read(built)
 bundle=applyRollbackSyncInstallTransform(applyClipboardTransform(applyClientRollbackTransform(bundle)),{runtimeOnly:true})
 bundle=applyErrorPurgePlayControlsTransform(applyErrorPurgeTurnControlsTransform(bundle))
 bundle=resourceClient(uiRuntime(uiBootstrap(bundle)))
 if(browserWrite)bundle=browserWrite(bundle)
 writes.set(built,bundle)
 if(split){
  for(const rel of ['turn-error-controls.js','features/play-controls.js','features/turn-history.js','ui/error-center.js','helper-resources.js','runtime/helper-bootstrap.js','runtime/helper-script-runtime.js','modules/tavern-coordination.js'])if(!existsSync(path.join(appDir,source+rel)))throw Error('拆分客户端缺确切include目标：'+rel)
  writes.set(source+'main.js',applyRollbackSyncInstallTransform(applyAuthorRollbackRuntimeTransform(main),{runtimeOnly:true}))
  writes.set(source+'modules/tavern-coordination.js',applyAuthorCoordinationTransform(read(source+'modules/tavern-coordination.js')))
  writes.set(feature,applyErrorPurgePlayControlsTransform(applyRollbackSyncActionGuardTransform(applyAuthorRollbackActionTransform(read(feature)))))
  writes.set(source+'turn-error-controls.js',applyErrorPurgeTurnControlsTransform(read(source+'turn-error-controls.js')))
  writes.set(source+'features/turn-history.js',applyClientHistoryAuthorityTransform(read(source+'features/turn-history.js')))
  writes.set(source+'ui/error-center.js',applyClipboardTransform(read(source+'ui/error-center.js')))
  writes.set(source+'helper-resources.js',resourceClient(read(source+'helper-resources.js')))
  writes.set(source+'runtime/helper-bootstrap.js',uiBootstrap(read(source+'runtime/helper-bootstrap.js')))
  let ui=uiRuntime(read(source+'runtime/helper-script-runtime.js'))
  if(browserWrite)ui=browserWrite(ui)
  writes.set(source+'runtime/helper-script-runtime.js',ui)
 }else{
  let inline=applyRollbackSyncInstallTransform(applyClipboardTransform(applyClientRollbackTransform(main)),{runtimeOnly:true})
  inline=applyErrorPurgePlayControlsTransform(applyErrorPurgeTurnControlsTransform(inline))
  inline=resourceClient(uiRuntime(uiBootstrap(inline)))
  if(browserWrite)inline=browserWrite(inline)
  writes.set(source+'main.js',inline)
 }
 return writes
}
