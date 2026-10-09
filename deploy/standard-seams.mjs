// 源码接缝按现场区块装卸；记录仅是可选摘要，不携带或核验作者历史片段。
import fs from 'node:fs'
import path from 'node:path'
import { buildCore } from './standard-seam-transforms.mjs'
import { parse } from '../lib/vendor/acorn/acorn.mjs'
import { parseSeamSource } from './comment-seam-blocks.mjs'
import { planSeamInstall, planSeamUninstall } from './comment-seam-plan.mjs'
import { describeSeamChanges, sameSeamProgram } from './comment-seam-descriptors.mjs'
import { applyCommentSeams, COMMENT_SEAMS_RECORD, ownedFileBlock, wrapOwnedFile } from './comment-seam-files.mjs'
const OWNER='dsh-tavern-sqlite-v2', DOMAIN='tavern-plugin/lib/domain/'
const HOST=['index.js','client.js','background-agent-task.js','background-agent-sessions.js','http/routes.js','hooks/turn-lifecycle.js']
const SOURCE=['main.js','features/play-controls.js','features/turn-history.js','turn-error-controls.js','ui/error-center.js','helper-resources.js','runtime/helper-bootstrap.js','runtime/helper-script-runtime.js','modules/host-session-patch.js','modules/session-view-sync.js','modules/live-tavern-view.js','modules/tavern-coordination.js']
const DOMAINS=['chat-sqlite-store.js','tavern-conversation-registry.js','conversation-initialization.js','session-view-reader.js','legacy-view-seams.js','round-history.js','story-timeline.js','model-error-presentation.js','tavern-script-host-adapter.js','tavern-script-dispatch.js','server-template-runtime.js','conversation-fork-point.js','chat-history-rescue.js','opening-preparation.js','storage-opening-runtime.js','storage-native-data.js','storage-fork-history.js','storage-server-execution.js','storage-rollback.js','storage-budgets.js','storage-package.js','storage-db-save.js','storage-current-variables.js','storage-compaction-warning.js','read-variables.js','storage-rollback-business.js','turn-orchestration.js','settlement-jobs.js','foreground-handoff.js','server-template-sync.js','candidate-worldbook-preparation.js','auto-compaction.js','chat-session-state.js','card-summary-cache.js','worldbook-library.js','file-resources.js','session-resource-access.js','background-session-retirement.js','game-footprint.js','background-task-coordinator.js']
export const maintenanceTargets=Object.freeze([...HOST.map(s=>'tavern-plugin/lib/'+s),...SOURCE.map(s=>'tavern-plugin/src/client/'+s),...DOMAINS.map(s=>DOMAIN+s)])
const OLD_RECORDS=['.tavern-standard-seams.json','.tavern-seams.json','.tavern-legacy-view-seams.json','.tavern-save-ui-seam.json']
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true})
function safeFile(root,rel){
  if(!maintenanceTargets.includes(rel)&&!['tavern-plugin/package.json',COMMENT_SEAMS_RECORD,...OLD_RECORDS].includes(rel))throw Error('标准目标越过有限清单：'+rel)
  const file=path.resolve(root,rel)
  for(let p=file;;p=path.dirname(p)){let st;try{st=fs.lstatSync(p)}catch(e){if(e.code!=='ENOENT')throw e}if(st?.isSymbolicLink())throw Error('标准源码不接受链接：'+rel);if(p===path.dirname(p))break}
  return file
}
function read(root,rel){const file=safeFile(root,rel);try{return utf8.decode(fs.readFileSync(file))}catch(e){if(e.code==='ENOENT')return null;throw e}}
function context(appDir){
  if(typeof appDir!=='string'||!path.isAbsolute(appDir))throw Error('标准接入须指定绝对应用路径')
  const root=path.resolve(appDir),pkg=JSON.parse(read(root,'tavern-plugin/package.json'))
  if(pkg.name!=='dsh-tavern-plugin'||typeof pkg.version!=='string')throw Error('作者包身份不符')
  for(const rel of OLD_RECORDS){const file=safeFile(root,rel);try{fs.lstatSync(file);throw Error('检测到旧机制记录，请先使用旧版插件维护CLI卸载：'+rel)}catch(e){if(e.code!=='ENOENT')throw e}}
  const current=new Map(),original=new Map(),bridges=new Map(),blocks=new Set()
  for(const rel of maintenanceTargets){
    const source=read(root,rel);if(source===null)continue
    current.set(rel,source)
    const parsed=parseSeamSource(source,{rel})
    if(parsed.blocks.some(b=>b.metadata.owner===OWNER))blocks.add(rel)
    const bridge=ownedFileBlock(source,{rel,owner:OWNER})
    if(bridge){bridges.set(rel,bridge);continue}
    const projection=planSeamUninstall(source,{rel,owner:OWNER}).source
    // 只识别撤缝投影里的真实旧注释；ACTIVE 兼容标签、字符串伪标记不是旧机制。
    const comments=[]
    parse(projection,{ecmaVersion:'latest',sourceType:'module',allowHashBang:true,onComment:comments})
    if(comments.some(c=>c.type==='Line'&&(/\[dsh-tavern-(?:core-host|standard-owned|legacy-view-seams|save-ui-seam):v\d/.test(c.value)||/^\s*\[dsh-tavern-sqlite-v2\]/.test(c.value))))throw Error('旧接缝残留，请用旧版CLI卸载：'+rel)
    original.set(rel,projection)
  }
  return {root,pkg,current,original,bridges,blocks}
}
function targetsFor(ctx){
  const writes=buildCore(ctx.root,ctx.original),targets=[]
  for(const [rel,body]of writes){
    if(!maintenanceTargets.includes(rel))throw Error('接线工厂目标未声明：'+rel)
    parseSeamSource(body,{rel})
    if(!ctx.original.has(rel)){targets.push({rel,descriptors:[],ownedBody:body});continue}
    const before=ctx.original.get(rel),descriptors=describeSeamChanges(before,body,{rel,owner:OWNER})
    if(!descriptors.length)continue
    const fresh=planSeamInstall(before,{rel,owner:OWNER,descriptors})
    if(!sameSeamProgram(fresh.source,body,rel))throw Error('局部区块计划丢失或扩大业务修改：'+rel)
    targets.push({rel,descriptors})
  }
  // 新代不再需要的旧区块也撤掉；不以历史目标集合阻止升级。
  for(const rel of ctx.blocks)if(!targets.some(t=>t.rel===rel))targets.push({rel,descriptors:[]})
  return targets
}
function plan(ctx,targets,operation){
  const files=new Map(ctx.current)
  for(const t of targets){
    const source=ctx.current.get(t.rel)??null,bridge=ctx.bridges.get(t.rel)
    if(operation==='install'&&t.ownedBody!==undefined){
      const body=wrapOwnedFile(t.ownedBody,{rel:t.rel,owner:OWNER})
      if(source!==null&&!bridge)throw Error('已有同名文件不能冒认新建桥：'+t.rel)
      files.set(t.rel,bridge?source.slice(0,bridge.start)+body+source.slice(bridge.end):body)
    }else if(source!==null){
      const next=operation==='install'&&t.descriptors.length?planSeamInstall(source,{rel:t.rel,owner:OWNER,descriptors:t.descriptors}).source:planSeamUninstall(source,{rel:t.rel,owner:OWNER}).source
      if(bridge&&next==='')files.delete(t.rel);else files.set(t.rel,next)
    }
  }
  return files
}
const sameFiles=(a,b)=>a.size===b.size&&[...a].every(([rel,text])=>b.get(rel)===text)
function installation(ctx){const targets=targetsFor(ctx),expected=plan(ctx,targets,'install');return {targets,expected,ready:sameFiles(ctx.current,expected)}}
export function checkStandardSeams({appDir}={}){
  const ctx=context(appDir),next=installation(ctx)
  return {ready:next.ready,coverage:'comment-blocks',needsReapply:!next.ready,pending:next.ready?[]:next.targets.map(t=>t.rel),drifted:[],files:next.targets.map(t=>t.rel)}
}
export function inspectStandardSeamsPlan({appDir}={}){
  try{const ctx=context(appDir),next=installation(ctx);return {ready:next.ready,needsReapply:!next.ready,preflight:'passed',compatible:{ok:true,mode:'comment-blocks',failures:[]},pending:next.ready?[]:next.targets.map(t=>t.rel),authorVersion:ctx.pkg.version}}
  catch(e){return {ready:false,needsReapply:false,preflight:'failed',reason:e.message,compatible:{ok:false,mode:'comment-blocks',failures:[e.message]}}}
}
export function applyStandardSeams({appDir,assertStopped,authorUnloaded=false}={}){
  const ctx=context(appDir),next=installation(ctx)
  // 全部有限目标一起计划，既清旧区块/摘要又接新代；无缝消失不回历史原文。
  const byRel=new Map(next.targets.map(t=>[t.rel,t]))
  const targets=maintenanceTargets.map(rel=>byRel.get(rel)??{rel,descriptors:[]})
  const result=applyCommentSeams({appDir:ctx.root,owner:OWNER,targets,assertStopped:assertStopped??(authorUnloaded===true?()=>true:undefined),checkReady:({files})=>sameFiles(files,next.expected)})
  return {...result,ready:true,coverage:'comment-blocks',authorVersion:ctx.pkg.version}
}
export function uninstallStandardSeams({appDir,assertStopped,authorUnloaded=false}={}){
  const ctx=context(appDir),targets=maintenanceTargets.map(rel=>({rel,descriptors:[]})),expected=plan(ctx,targets,'uninstall')
  const result=applyCommentSeams({appDir:ctx.root,owner:OWNER,targets,operation:'uninstall',assertStopped:assertStopped??(authorUnloaded===true?()=>true:undefined),checkReady:({files})=>sameFiles(files,expected)})
  return {...result,requiresRestart:result.changed,restored:'onsite-comment-prefix',recordKept:false,legacySeamsRemain:false}
}
