// 有限源码维护：只准固定作者目标、接缝manifest与接缝自己的备份，绝不遍历业务数据。
import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync,unlinkSync,lstatSync,renameSync} from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {protectAuthorStartup} from './author-safety.mjs'
import {recoverSourcePreimage} from './preimage-recovery.mjs'
export const STANDARD_RECORD='.tavern-standard-seams.json'
const records=['.tavern-seams.json','.tavern-legacy-view-seams.json','.tavern-save-ui-seam.json']
const directories=['.','tavern-plugin/lib','tavern-plugin/lib/domain','tavern-plugin/lib/hooks','tavern-plugin/src/client','tavern-plugin/src/client/features','tavern-plugin/src/client/ui','tavern-plugin/src/client/runtime','tavern-plugin/src/client/modules']
const backup=/\.(?:pre-seams-[\w-]+\.bak|legacy-view-seams\.backup|save-ui[^/]*\.backup)$/
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
export function sourceAccess(appDir,targets){
 const root=path.resolve(appDir),fixed=new Set([...targets,STANDARD_RECORD,'tavern-plugin/package.json'])
 if(!fixed.has('tavern-plugin/lib/index.js')||!records.every(rel=>fixed.has(rel)))throw new Error('版本适配器有限目标清单不完整')
 if([...fixed].some(rel=>![...records,STANDARD_RECORD,'tavern-plugin/package.json'].includes(rel)&&(!rel.startsWith('tavern-plugin/lib/')&&!rel.startsWith('tavern-plugin/src/client/'))))throw new Error('版本目标不是有限作者源码')
 function file(rel){
  if(!fixed.has(rel)&&!(backup.test(rel)&&directories.includes(path.posix.dirname(rel))))throw new Error('不属于有限源码维护范围：'+rel)
  const resolved=path.resolve(root,rel);if(!resolved.startsWith(root+path.sep)||rel.includes('..'))throw new Error('源码路径越界：'+rel)
  if(existsSync(root)&&lstatSync(root).isSymbolicLink())throw new Error('源码根不接受符号链接')
  for(let p=resolved;p!==root;p=path.dirname(p))if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('源码目标不接受符号链接：'+p)
  return resolved
 }
 function capture(){
  const names=new Set(fixed)
  // 先拒绝源目录符号链接，不能先枚举后才发现跳到了业务目录。
  for(const anchor of ['tavern-plugin/lib/index.js','tavern-plugin/lib/domain/read-variables.js','tavern-plugin/src/client/main.js'])file(anchor)
  for(const rel of directories){const dir=path.resolve(root,rel)
   for(let p=dir;;p=path.dirname(p)){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw Error('备份目录不接受符号链接：'+p);if(p===root)break}
   if(!existsSync(dir))continue
   for(const e of readdirSync(dir,{withFileTypes:true}))if(e.isFile()&&backup.test(e.name))names.add(path.posix.join(rel==='.'?'':rel,e.name))
  }
  return Object.fromEntries([...names].sort().map(rel=>[rel,existsSync(file(rel))?readFileSync(file(rel)).toString('base64'):null]))
 }
 function restore(image){
  for(const rel of new Set([...Object.keys(capture()),...Object.keys(image)])){
   const target=file(rel),body=image[rel];if(body==null){if(existsSync(target))unlinkSync(target)}else{mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,Buffer.from(body,'base64'))}
  }
 }
 function assertImage(image,{installation=false}={}){for(const [rel,body]of Object.entries(image)){const target=file(rel);if(installation&&backup.test(rel))continue;if(body==null){if(existsSync(target))throw new Error('源码应不存在：'+rel)}else if(installation&&[...records,STANDARD_RECORD].includes(rel)){if(!existsSync(target))throw new Error('安装记录缺失：'+rel)}else if(!existsSync(target)||!readFileSync(target).equals(Buffer.from(body,'base64')))throw new Error('源码前像不匹配：'+rel)}}
 function protect(){const rel='tavern-plugin/lib/index.js',target=file(rel),raw=readFileSync(target,'utf8'),safe=protectAuthorStartup(raw);if(raw!==safe)writeFileSync(target,safe,'utf8')}
 function syntax(){const result=spawnSync(process.execPath,['--check',file('tavern-plugin/lib/index.js')],{stdio:'inherit',timeout:8000,windowsHide:true});if(result.error||result.status!==0)throw new Error('作者保护主入口语法/有界检查拒绝')}
 return {root,file,capture,restore,assertImage,protect,syntax}
}
export function assertPackageSource(access,adapter,{allowRebase=false}={}){
 const index=readFileSync(access.file('tavern-plugin/lib/index.js'),'utf8')
 if(index.includes(adapter.otherHostMarker))throw new Error('另一功能线接缝不能直接覆盖，请先标准卸载')
 if(existsSync(access.file(STANDARD_RECORD))){
  const record=JSON.parse(readFileSync(access.file(STANDARD_RECORD),'utf8'))
  if(record.version!==1||!record.before||!record.after)throw new Error('标准记录格式不匹配')
  if(typeof record.authorVersion!=='string'||!record.authorVersion.trim())throw new Error('标准记录作者版本字段不合法')
  const plan=allowRebase?adapter.inspectStandardSeamsPlan?.({appDir:access.root}):null
  const compatibleRefresh=plan?.needsReapply===true&&plan.compatible?.ok===true
  for(const rel of [...adapter.targets,'tavern-plugin/lib/index.js'])if(!Object.hasOwn(record.before,rel)){
   // 旧内联代不存在新增拆分模块，可以按自己的确切记录卸；有文件却无前像仍拒绝。
   const added=/\/hooks\/turn-lifecycle\.js$|\/features\/(?:play-controls|turn-history)\.js$|\/ui\/error-center\.js$|\/runtime\/helper-script-runtime\.js$|\/domain\/card-summary-cache\.js$/.test(rel)
   if(!added||existsSync(access.file(rel))||Object.hasOwn(record.after,rel))throw new Error('标准记录缺源码前像：'+rel)
  }
  for(const [rel,body]of Object.entries(record.before)){access.file(rel);if(body!==null&&(typeof body!=='string'||Buffer.from(body,'base64').toString('base64')!==body))throw new Error('标准前像不是规范base64：'+rel);if(records.includes(rel)&&body!==null)assertHistoryManifest(access,JSON.parse(Buffer.from(body,'base64').toString('utf8')))}
  for(const [rel,hash]of Object.entries(record.after)){const file=access.file(rel);if(!/^[a-f0-9]{64}$/.test(hash))throw Error('标准后像摘要非法：'+rel);if((!existsSync(file)||digest(readFileSync(file))!==hash)&&!compatibleRefresh)throw new Error('标准代源码漂移：'+rel)}
  if(!compatibleRefresh){const shim=readFileSync(access.file('tavern-plugin/lib/domain/storage-package.js'),'utf8');if(!shim.includes(adapter.packageName))throw new Error('标准代属于另一包，不允许跨版本线恢复')}
 }
 for(const name of records)if(existsSync(access.file(name))){const data=JSON.parse(readFileSync(access.file(name),'utf8'));assertHistoryManifest(access,data);if(data.package&&data.package!==adapter.packageName)throw new Error('历史接缝属于另一包：'+data.package)}
}
function assertHistoryManifest(access,data){
 if(data.version!==1||!Array.isArray(data.entries))throw new Error('历史manifest格式不符')
 for(const entry of data.entries){const rel=entry.rel||entry.relative;if(typeof rel!=='string'||!rel.startsWith('tavern-plugin/')||!rel.endsWith('.js')||backup.test(rel))throw new Error('历史manifest目标不是作者有限源码');access.file(rel);if(entry.backup){access.file(entry.backup);if(!backup.test(entry.backup))throw new Error('历史manifest备份不是所属接缝备份')}else if(!entry.created)throw new Error('历史manifest缺前像恢复材料')}
}
export function finishSourceUninstall(access,adapter,stopRecord,archiveDir){
 if(existsSync(access.file(STANDARD_RECORD)))adapter.uninstallStandardSeams({appDir:access.root})
 else if(stopRecord){for(const name of records)if(!Object.hasOwn(stopRecord.before,name))throw new Error('停前标准记录不完整');access.assertImage(stopRecord.before)}
 else throw new Error('缺停前标准记录，不猜整包已卸载')
 const backups=[]
 for(const name of records)if(existsSync(access.file(name))){const data=JSON.parse(readFileSync(access.file(name),'utf8'));assertHistoryManifest(access,data);for(const e of data.entries||[])if(e.backup){access.file(e.backup);backups.push(e.backup)}}
 const outcome=adapter.uninstallAllSeams({appDir:access.root})
 const archived=[];mkdirSync(archiveDir,{recursive:true})
 for(const rel of backups){const src=access.file(rel);if(!existsSync(src))continue
  const dst=path.resolve(archiveDir,path.basename(rel));if(!dst.startsWith(path.resolve(archiveDir)+path.sep)||existsSync(dst))throw new Error('源码归档目的越界或已存在')
  const hash=digest(readFileSync(src));renameSync(src,dst);if(digest(readFileSync(dst))!==hash)throw new Error('归档回读不一致');archived.push({relative:rel,sha256:hash})
 }
 access.protect();access.syntax()
 assertSourceUninstalled(access)
 return {outcome,archived,data:'用户数据未访问、未删除、未转换',protection:'独立原件保护保留'}
}
export function assertSourceUninstalled(access){
 for(const name of [...records,STANDARD_RECORD])if(existsSync(access.file(name)))throw new Error('卸载接缝记录仍在：'+name)
 for(const [rel,body]of Object.entries(access.capture()))if(body!==null&&/\.js$/.test(rel)){
  const code=Buffer.from(body,'base64').toString('utf8');if(/dsh-tavern-(?:storage-)?sqlite(?:-v[12])?/.test(code)||code.includes('[dsh-tavern-standard-owned:v1]'))throw new Error('活动源码仍接管：'+rel)
 }
}
// 宿主正常退出时标准host disposer会撤缝并删标准记录，profile装配完整保留——"退出撤缝态"。
// 源码此时即作者原像：install可按首装重建接缝与记录，uninstall只卸装配。仍要求
// assertSourceUninstalled全绿（无任何记录、活动源码零接管标记）；半撤/脏树不认，维持原拒绝。
export function withdrawnCleanState(access){
 if(existsSync(access.file(STANDARD_RECORD)))return false
 try{assertSourceUninstalled(access)}catch{return false}
 return true
}
// 修复只写已重放验证过的before；after及活动源码一字不改。
export function commitRecoveredPreimage(access,rehearsal){
 access.assertImage(rehearsal.before)
 const file=access.file(STANDARD_RECORD),old=readFileSync(file),record=rehearsal.recovery.record
 const previous=JSON.parse(old.toString('utf8'))
 if(JSON.stringify(record.after)!==JSON.stringify(previous.after))throw new Error('前像恢复不得修改after校验')
 writeFileSync(file,JSON.stringify(record,null,2)+'\n','utf8')
 return ()=>writeFileSync(file,old)
}
export function finishRecoveredSourceUninstall(access,adapter,stopRecord,rehearsal,archiveDir){
 if(existsSync(access.file(STANDARD_RECORD))){
  commitRecoveredPreimage(access,rehearsal)
  return {...finishSourceUninstall(access,adapter,stopRecord,archiveDir),preimageRecovery:rehearsal.recovery.provenance}
 }
 // 原宿主disposer已撤标准代时，只允许停前记录描述的确切恢复状态，拒绝其他漂移。
 access.assertImage(stopRecord.before)
 access.restore(rehearsal.expected);access.protect();access.syntax();assertSourceUninstalled(access)
 return {preimageRecovery:rehearsal.recovery.provenance,data:'用户数据未访问、未删除、未转换',protection:'独立原件保护保留'}
}
export function rehearseSource(action,access,adapter,evidenceDir,checkBudget=()=>{}){
 if(action==='uninstall')assertPackageSource(access,adapter)
 const before=access.capture(),app=path.join(evidenceDir,'rehearsal'),test=sourceAccess(app,adapter.targets);test.restore(before)
 const refresh=action==='install'?adapter.inspectStandardSeamsPlan?.({appDir:access.root}):null
  if(action==='install'&&records.some(name=>before[name]!==null)&&!(refresh?.needsReapply===true&&refresh.compatible?.ok===true))throw new Error('首装前历史记录仍在，先用所属包完整卸载；不复用危险历史前像')
 // 历史主manifest里app只是展示字段，卸载实际路径由调用的appDir限定。
 let result
 if(action==='install'){test.protect();test.syntax();result=adapter.applyStandardSeams({appDir:app,allowRebase:true});if(!adapter.checkStandardSeams({appDir:app}).ready)throw new Error('安装副本预检未ready')}
 else{
  const raw=before[STANDARD_RECORD];if(raw==null)throw new Error('卸载缺标准记录，先诊断不猜')
  try{result=finishSourceUninstall(test,adapter,JSON.parse(Buffer.from(raw,'base64')),path.join(evidenceDir,'rehearsal-archives'))}
  catch(error){
   let recovery
   try{recovery=recoverSourcePreimage({access,adapter,evidenceDir,before,checkBudget})}
   catch(recoveryError){throw new Error('卸载前像不可恢复；原错误：'+error.message+'；'+recoveryError.message,{cause:error})}
   writeFileSync(path.join(evidenceDir,'preimage-recovery.json'),JSON.stringify(recovery.provenance,null,2)+'\n','utf8')
   return {before,expected:recovery.expected,recovery,result:{preimageRecovery:recovery.provenance,repairAvailable:true,data:'用户数据未访问、未删除、未转换',protection:'独立原件保护保留'}}
  }
 }
 return {before,expected:test.capture(),result}
}
