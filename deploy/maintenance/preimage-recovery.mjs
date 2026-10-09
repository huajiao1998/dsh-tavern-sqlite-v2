// 仅以本包历史安装证据修复源码前像；不读存档、Git候选或日志，不改变after漂移校验。
import {existsSync,readFileSync,writeFileSync,readdirSync,lstatSync,mkdirSync} from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {sourceAccess,finishSourceUninstall,STANDARD_RECORD} from './source.mjs'

const historyRecords=['.tavern-seams.json','.tavern-legacy-view-seams.json','.tavern-save-ui-seam.json']
const indexRel='tavern-plugin/lib/index.js'
// 唯一被标准记录/捕获覆盖、却既不在 adapter.targets、冻结目录也无官方字节的固定协调器路径（source.mjs:16-17）。
// 只认这一条固定相对路径，不按目录或后缀枚举其他文件。
const coordinatorRel='tavern-plugin/lib/domain/background-task-coordinator.js'
const backupName=/\.(?:pre-seams-[\w-]+\.bak|legacy-view-seams\.backup|save-ui[^/]*\.backup)$/
const packageRel='tavern-plugin/package.json'
const operationName=/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const seamed=code=>/\[dsh-tavern-|from ['"]\.\/domain\/(?:chat-sqlite-store|legacy-view-seams|storage-[\w-]+)\.js['"]/.test(code)
const fail=reason=>{throw new Error('前像污染/恢复材料不可验证：'+reason+'；未修改目标。保留维护证据，不手工修改after哈希')}

function candidateImage(data,access,adapter,before,{coordinatorRequired=false}={}){
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('历史前像不是映射')
 for(const [rel,body]of Object.entries(data)){
  access.file(rel)
  if(body!==null&&(typeof body!=='string'||Buffer.from(body,'base64').toString('base64')!==body))throw Error('历史前像不是规范base64：'+rel)
 }
 const fixed=[...new Set([...adapter.targets,packageRel,STANDARD_RECORD])]
 // 当前协调器有真字节，或标准记录 before/after 覆盖该键时：候选**必须含该键**并与当前现场重放相等，
 // 绝不因候选缺键把它静默当 null（那等于把真实作者字节洗成"作者原本没有"）。
 if(coordinatorRequired)fixed.push(coordinatorRel)
 // 仅当证据自己带该键（含 null）时原样接收，null 保持 null；不从证据丢键、也不凭缺键补 null。
 else if(Object.hasOwn(data,coordinatorRel))fixed.push(coordinatorRel)
 for(const rel of fixed)if(!Object.hasOwn(data,rel))throw Error('历史前像不完整：'+rel)
 if(data[STANDARD_RECORD]!==null||historyRecords.some(rel=>data[rel]!==null))throw Error('历史候选不是首次洁净安装前像')
 if(!data[packageRel]||data[packageRel]!==before[packageRel])throw Error('作者包身份与当前不符')
 if(!data[indexRel]||seamed(Buffer.from(data[indexRel],'base64').toString('utf8')))throw Error('候选入口仍含接缝，不能当作者原文')
 // 历史孤儿备份不是作者源码，不能从证据中带进新副本并被后续施缝复用。
 return Object.fromEntries(fixed.map(rel=>[rel,data[rel]]))
}

export function recoverSourcePreimage({access,adapter,evidenceDir,before,checkBudget=()=>{}}){
 const root=path.resolve(path.dirname(evidenceDir))
 if(path.basename(root)!==adapter.packageName||path.basename(path.dirname(root))!=='maintenance')fail('不是本包维护证据目录')
 // 所有祖先都拒绝链接；不能由维护目录跳到业务树或另一个实例。
 for(let p=root;;p=path.dirname(p)){
  if(existsSync(p)&&lstatSync(p).isSymbolicLink())fail('维护证据路径是符号链接')
  if(p===path.dirname(p))break
 }
 const currentRecord=JSON.parse(Buffer.from(before[STANDARD_RECORD],'base64').toString('utf8'))
 // 协调器覆盖判定（只此一条固定路径）：当前仍有真字节，或标准记录 before/after 任一覆盖该键
 // ⇒ 候选必须带它并重放相等；三者皆不成立（真实缺席）才不要求，避免凭缺键造文件。
 const coordinatorRequired=typeof before[coordinatorRel]==='string'
  ||Object.hasOwn(currentRecord?.before||{},coordinatorRel)||Object.hasOwn(currentRecord?.after||{},coordinatorRel)
 const ownedBackups=new Set()
 for(const name of historyRecords)if(before[name])for(const item of JSON.parse(Buffer.from(before[name],'base64').toString('utf8')).entries||[])if(item.backup){access.file(item.backup);ownedBackups.add(item.backup)}
 const preserved=Object.fromEntries(Object.entries(before).filter(([rel,body])=>body!==null&&backupName.test(rel)&&!ownedBackups.has(rel)))
 const attempts=[],valid=[],seen=new Set();let readBytes=0
 const dirs=readdirSync(root,{withFileTypes:true}).filter(e=>operationName.test(e.name)&&path.resolve(root,e.name)!==path.resolve(evidenceDir)).sort((a,b)=>b.name.localeCompare(a.name)).slice(0,64)
 for(const [ordinal,entry]of dirs.entries()){
  checkBudget()
  const folder=path.join(root,entry.name),file=path.join(folder,'source-before.json')
  try{
   if(entry.isSymbolicLink()||!entry.isDirectory())throw Error('证据目录不是普通目录')
   if(!existsSync(file))continue
   const stat=lstatSync(file)
   if(stat.isSymbolicLink()||!stat.isFile()||stat.size>32*1024*1024)throw Error('证据不是有界普通文件')
   readBytes+=stat.size
   if(readBytes>128*1024*1024)fail('本次恢复材料超过128MiB读取上限')
   const bytes=readFileSync(file),image=candidateImage(JSON.parse(bytes.toString('utf8')),access,adapter,before,{coordinatorRequired})
   const key=digest(JSON.stringify(Object.entries(image).sort(([a],[b])=>a.localeCompare(b))))
   if(seen.has(key))continue
   seen.add(key)
   checkBudget()
   const replayRoot=path.join(evidenceDir,'preimage-candidate-'+ordinal,'app')
   if(existsSync(replayRoot))throw Error('恢复副本目的已存在，不覆盖旧证据')
   const replay=sourceAccess(replayRoot,adapter.targets)
   replay.restore(image);replay.protect();replay.syntax()
   const cleanBefore=replay.capture()
   // 标准记录不把自身或作者包清单列为可恢复目标；否则restore会提前删掉它自身。
   delete cleanBefore[STANDARD_RECORD];delete cleanBefore[packageRel]
   adapter.applyStandardSeams({appDir:replayRoot})
   if(!adapter.checkStandardSeams({appDir:replayRoot}).ready)throw Error('候选重放接缝未ready')
   const applied=replay.capture(),active=adapter.targets.filter(rel=>rel.endsWith('.js'))
   // 协调器被当前现场/记录覆盖时同样纳入逐字节重放比较（它不在 targets，但不能漏检）。
   if(coordinatorRequired)active.push(coordinatorRel)
   for(const rel of active)if(applied[rel]!==before[rel])throw Error('候选重放与当前活动源码不一致：'+rel)
   const replayRecord=JSON.parse(readFileSync(replay.file(STANDARD_RECORD),'utf8'))
   finishSourceUninstall(replay,adapter,replayRecord,path.join(evidenceDir,'preimage-candidate-'+ordinal,'archives'))
   const expected={...replay.capture(),...preserved}
   valid.push({expected,record:{...currentRecord,before:{...cleanBefore,...preserved}},provenance:{source:path.posix.join(entry.name,'source-before.json'),sha256:digest(bytes),verifiedActiveFiles:active.length,method:'clean-install-replay-byte-equality',afterUnchanged:true}})
  }catch(error){attempts.push({source:entry.name,reason:error.message})}
 }
 mkdirSync(evidenceDir,{recursive:true})
 // 只写本次诊断证据，不包含源码或业务数据。
 writeFileSync(path.join(evidenceDir,'preimage-attempts.json'),JSON.stringify(attempts,null,2)+'\n','utf8')
 checkBudget()
 if(readBytes>128*1024*1024)fail('恢复材料超过128MiB上限，未完成候选验证')
 if(!valid.length)fail('没有可重放证明当前源码的洁净安装前像（已检查'+dirs.length+'个本包操作目录）')
 const expectedKey=value=>JSON.stringify(Object.entries(value.expected).sort(([a],[b])=>a.localeCompare(b)))
 if(valid.some(value=>expectedKey(value)!==expectedKey(valid[0])))fail('多个候选产生不同卸载后像，拒绝猜测代际')
 return valid[0]
}
