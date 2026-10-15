// 一次定位当前接缝，直接注入现场区块；不复制预演，不认证作者原件，不重算验收计划。
import fs from 'node:fs'
import path from 'node:path'
import { buildCore } from './standard-seam-transforms.mjs'
import { parseSeamSource } from './comment-seam-blocks.mjs'
import { planSeamInstall, planSeamUninstall } from './comment-seam-plan.mjs'
import { describeSeamChanges } from './comment-seam-descriptors.mjs'
import { COMMENT_SEAMS_RECORD, wrapOwnedFile } from './comment-seam-files.mjs'
const OWNER='dsh-tavern-sqlite-v2', DOMAIN='tavern-plugin/lib/domain/'
export const maintenanceReadSources=Object.freeze(['tavern-plugin/lib/domain/scene-slots.js'])
const HOST=['index.js','plugin-api.js','client.js','background-agent-task.js','background-agent-sessions.js','http/routes.js','hooks/turn-lifecycle.js','hooks/request.js']
const SOURCE=['main.js','features/play-controls.js','features/turn-history.js','turn-error-controls.js','ui/error-center.js','helper-resources.js','runtime/helper-bootstrap.js','runtime/helper-script-runtime.js','modules/host-session-patch.js','modules/session-view-sync.js','modules/live-tavern-view.js','modules/tavern-coordination.js']
const DOMAINS=['chat-sqlite-store.js','tavern-conversation-registry.js','conversation-initialization.js','session-view-reader.js','legacy-view-seams.js','round-history.js','story-timeline.js','model-error-presentation.js','tavern-script-host-adapter.js','tavern-script-dispatch.js','server-template-runtime.js','conversation-fork-point.js','chat-history-rescue.js','opening-preparation.js','server-script-executor.js','server-script-worker.js','helper-generation-tasks.js','storage-upstream-compute.js','storage-native-data.js','storage-fork-history.js','storage-rollback.js','storage-budgets.js','storage-package.js','storage-db-save.js','storage-current-variables.js','storage-compaction-warning.js','read-variables.js','storage-rollback-business.js','storage-failure-state.js','round-anchor.js','turn-orchestration.js','settlement-jobs.js','foreground-handoff.js','server-template-sync.js','candidate-worldbook-preparation.js','auto-compaction.js','chat-session-state.js','card-summary-cache.js','worldbook-library.js','file-resources.js','session-resource-access.js','background-session-retirement.js','game-footprint.js','background-task-coordinator.js']
// 仅用于识别并撤除现场完整owned-file区块；这些旧桥永不生成，也无旧执行协议。
const RETIRED_OWNED=['storage-opening-runtime.js','storage-server-execution.js','storage-helper-readonly.js']
export const maintenanceTargets=Object.freeze([...HOST.map(s=>'tavern-plugin/lib/'+s),...SOURCE.map(s=>'tavern-plugin/src/client/'+s),...DOMAINS.map(s=>DOMAIN+s),...RETIRED_OWNED.map(s=>DOMAIN+s)])
const OLD_RECORDS=['.tavern-standard-seams.json','.tavern-seams.json','.tavern-legacy-view-seams.json','.tavern-save-ui-seam.json']
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})
function safeFile(root,rel){
 if(!maintenanceTargets.includes(rel)&&!maintenanceReadSources.includes(rel)&&!['tavern-plugin/package.json',COMMENT_SEAMS_RECORD,...OLD_RECORDS].includes(rel))throw Error('源码路径不属于接缝清单：'+rel)
 const file=path.resolve(root,rel)
 for(let p=file;;p=path.dirname(p)){let st;try{st=fs.lstatSync(p)}catch(e){if(e.code!=='ENOENT')throw e}if(st?.isSymbolicLink())throw Error('接缝目标不能是外部链接：'+rel);if(p===path.dirname(p))break}
 return file
}
function read(root,rel){try{return utf8.decode(fs.readFileSync(safeFile(root,rel)))}catch(e){if(e.code==='ENOENT')return null;throw e}}
function context(appDir){
 if(typeof appDir!=='string'||!path.isAbsolute(appDir))throw Error('须定位酒馆绝对目录')
 const root=path.resolve(appDir),pkg=JSON.parse(read(root,'tavern-plugin/package.json'))
 if(pkg.name!=='dsh-tavern-plugin')throw Error('目标不是酒馆目录')
 for(const rel of OLD_RECORDS)if(fs.existsSync(safeFile(root,rel)))throw Error('旧机制接缝须先用所属旧入口卸载：'+rel)
 const current=new Map(),original=new Map(),owned=new Map(),readOnly=new Map()
 for(const rel of maintenanceTargets){
  const source=read(root,rel);if(source===null)continue
  current.set(rel,source)
  if(source.includes('[dsh-tavern-v1-storage-host:v1]'))throw Error('目标仍有V1接管，请先用V1入口卸载')
  const parsed=parseSeamSource(source,{rel,ast:false}),bridge=parsed.blocks.find(b=>b.metadata.owner===OWNER&&b.metadata.id==='owned-file')
  if(bridge){owned.set(rel,bridge);continue}
  original.set(rel,planSeamUninstall(source,{rel,owner:OWNER,parsed}).source)
 }
 for(const rel of maintenanceReadSources){const source=read(root,rel);if(source!==null)readOnly.set(rel,source)}
  return {root,pkg,current,original,owned,readOnly}
}
export function prepareStandardSeams({appDir,operation='install'}={}){
 if(!['install','uninstall'].includes(operation))throw Error('接缝动作不合法')
 const ctx=context(appDir),after=new Map(ctx.current),records={},ownedRecords={}
 if(operation==='install'){
  // 所有必需锚点在内存中命中完成后才写盘，缺失/歧义不产生半装。
  const writes=buildCore(ctx.root,new Map([...ctx.original,...ctx.readOnly]))
  for(const [rel,body]of writes){
   if(!maintenanceTargets.includes(rel))throw Error('接缝工厂目标未声明：'+rel)
   const bridge=ctx.owned.get(rel),current=ctx.current.get(rel)??null
   if(bridge||!ctx.original.has(rel)){
    if(current!==null&&!bridge)throw Error('同名文件不属于插件，不能覆盖：'+rel)
    const wrapped=wrapOwnedFile(body,{rel,owner:OWNER})
    after.set(rel,bridge?current.slice(0,bridge.start)+wrapped+current.slice(bridge.end):wrapped)
    ownedRecords[rel]={format:1,owner:OWNER,rel,mode:'owned-new'}
   }else{
    const base=ctx.original.get(rel),descriptors=describeSeamChanges(base,body,{rel,owner:OWNER})
    if(!descriptors.length){after.set(rel,base);continue}
    let result
    try{result=planSeamInstall(base,{rel,owner:OWNER,descriptors})}catch(error){error.message=rel+'：'+error.message;throw error}
    after.set(rel,result.source);records[rel]=result.record
   }
  }
  // 已退役的插件桥与旧自有块按现场撤除，不恢复任何官方原文。
  for(const [rel,source]of ctx.current)if(!writes.has(rel)){
   const next=ctx.original.has(rel)?ctx.original.get(rel):planSeamUninstall(source,{rel,owner:OWNER}).source
   if(ctx.owned.has(rel)&&next==='')after.delete(rel);else after.set(rel,next)
  }
 }else for(const [rel,source]of ctx.current){
  const next=ctx.original.has(rel)?ctx.original.get(rel):planSeamUninstall(source,{rel,owner:OWNER}).source
  if(ctx.owned.has(rel)&&next==='')after.delete(rel);else after.set(rel,next)
 }
 const changes=maintenanceTargets.filter(rel=>(ctx.current.get(rel)??null)!==(after.get(rel)??null)).map(rel=>({rel,before:ctx.current.get(rel)??null,after:after.get(rel)??null}))
 const record=operation==='install'?{format:1,owner:OWNER,files:records,owned:ownedRecords}:null
 return {root:ctx.root,operation,authorVersion:ctx.pkg.version,changes,record,recordBefore:read(ctx.root,COMMENT_SEAMS_RECORD)}
}
export function writePreparedStandardSeams(prepared){
 const written=[],recordFile=safeFile(prepared.root,COMMENT_SEAMS_RECORD)
 try{
  for(const item of prepared.changes){
   const file=safeFile(prepared.root,item.rel);written.push(item)
   if(item.after===null){if(fs.existsSync(file))fs.unlinkSync(file)}
   else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,item.after,'utf8')}
  }
  if(prepared.record)fs.writeFileSync(recordFile,JSON.stringify(prepared.record,null,2)+'\n','utf8')
  else if(fs.existsSync(recordFile))fs.unlinkSync(recordFile)
 }catch(error){
  // 仅本次实际写集用于失败恢复，不作准入/卸载文件一致性检查。
  for(const item of written.reverse()){
   const file=safeFile(prepared.root,item.rel)
   if(item.before===null){if(fs.existsSync(file))fs.unlinkSync(file)}else fs.writeFileSync(file,item.before,'utf8')
  }
  if(prepared.recordBefore===null){if(fs.existsSync(recordFile))fs.unlinkSync(recordFile)}else fs.writeFileSync(recordFile,prepared.recordBefore,'utf8')
  throw error
 }
 return {changed:prepared.changes.length>0 || prepared.recordBefore !== (prepared.record ? JSON.stringify(prepared.record,null,2)+'\n' : null),ready:true,coverage:'comment-blocks',written:prepared.changes.map(x=>x.rel),authorVersion:prepared.authorVersion,...(prepared.operation==='uninstall'?{legacySeamsRemain:false}:{})}
}
export function restorePreparedStandardSeams(prepared){
 for(const item of [...prepared.changes].reverse()){
  const file=safeFile(prepared.root,item.rel)
  if(item.before===null){if(fs.existsSync(file))fs.unlinkSync(file)}else fs.writeFileSync(file,item.before,'utf8')
 }
 const file=safeFile(prepared.root,COMMENT_SEAMS_RECORD)
 if(prepared.recordBefore===null){if(fs.existsSync(file))fs.unlinkSync(file)}else fs.writeFileSync(file,prepared.recordBefore,'utf8')
}
export function checkStandardSeams({appDir}={}){
 // 正常启动只看持久自有区块，不重新变换作者代码/做整文件等价比较。
 const root=path.resolve(appDir),text=read(root,COMMENT_SEAMS_RECORD)
 if(text===null)return {ready:false,needsReapply:true,coverage:'comment-blocks'}
 let record;try{record=JSON.parse(text)}catch{return {ready:false,needsReapply:true,coverage:'comment-blocks'}}
 if(record.owner!==OWNER||!record.files||!record.owned||!record.files['tavern-plugin/lib/index.js']?.blocks?.length)return {ready:false,needsReapply:true,coverage:'comment-blocks'}
 const pending=[]
 for(const [rel,info]of Object.entries({...record.files,...record.owned})){
  const source=read(root,rel)
  if(source===null){pending.push(rel);continue}
  const blocks=parseSeamSource(source,{rel,ast:false}).blocks.filter(b=>b.metadata.owner===OWNER)
  if(info.mode==='owned-new'? !blocks.some(b=>b.metadata.id==='owned-file') : !(info.blocks??[]).every(want=>blocks.some(b=>b.metadata.id===want.id)))pending.push(rel)
 }
 return {ready:pending.length===0,needsReapply:pending.length>0,pending,coverage:'comment-blocks'}
}
export function inspectStandardSeamsPlan(options={}){
 try{const prepared=prepareStandardSeams({...options,operation:'install'});return {ready:prepared.changes.length===0,needsReapply:prepared.changes.length>0,preflight:'passed',compatible:{ok:true,mode:'comment-blocks',failures:[]},authorVersion:prepared.authorVersion}}
 catch(e){return {ready:false,preflight:'failed',reason:e.message,compatible:{ok:false,failures:[e.message]}}}
}
export function applyStandardSeams({assertStopped,authorUnloaded=false,...options}={}){
 if(assertStopped?assertStopped()!==true:!authorUnloaded)throw Error('施缝时作者须已停止或尚未加载')
 return writePreparedStandardSeams(prepareStandardSeams({...options,operation:'install'}))
}
export function uninstallStandardSeams({assertStopped,authorUnloaded=false,...options}={}){
 if(assertStopped?assertStopped()!==true:!authorUnloaded)throw Error('撤缝时作者须已停止或尚未加载')
 return {...writePreparedStandardSeams(prepareStandardSeams({...options,operation:'uninstall'})),restored:'onsite-comment-prefix',recordKept:false}
}
