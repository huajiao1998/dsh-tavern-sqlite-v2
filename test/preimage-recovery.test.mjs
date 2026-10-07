// 真实有限作者接缝+原创driver：不联网、不SSH、不启服务、不访问任何真实存档。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {applyAllSeams} from '../deploy/apply-seams.mjs'
import {maintenanceAdapter as adapter} from '../deploy/maintenance.mjs'
import {sourceAccess,rehearseSource,STANDARD_RECORD} from '../deploy/maintenance/source.mjs'
import {maintenanceBudget} from '../deploy/maintenance/budget.mjs'
import {executeMaintenance} from '../deploy/maintenance/runner.mjs'

const workspace=fileURLToPath(new URL('../../../',import.meta.url))
const authorSha='5d2ffacf4231c9f45dc641b9db9e0286c4fa5f60'
const authorArchive=path.join(workspace,'tmp/upstream25-author-fixture','dsh-tavern-'+authorSha+'.tar.gz')
const index='tavern-plugin/lib/index.js'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-preimage-proof-')),app=path.join(root,'app')
 t.after(()=>{assert.ok(path.basename(root).startsWith('v2-preimage-proof-'));fs.rmSync(root,{recursive:true,force:true})})
 let author=process.env.TAVERN_LATEST_AUTHOR_ROOT
 if(!author){
  assert.ok(fs.existsSync(authorArchive),'缺固定作者2.5.0归档，不SKIP或冒称通过')
  const unpack=path.join(root,'unpack');fs.mkdirSync(unpack)
  assert.equal(spawnSync('tar',['-xzf',authorArchive,'-C',unpack],{stdio:'inherit'}).status,0)
  author=path.join(unpack,'dsh-tavern-'+authorSha)
 }
 assert.equal(JSON.parse(fs.readFileSync(path.join(author,'tavern-plugin/package.json'),'utf8')).version,'2.5.0','不伪造fixture版本')
 for(const rel of [...adapter.targets,'tavern-plugin/package.json']){
  const src=path.join(author,rel);if(!fs.existsSync(src))continue
  const dst=path.join(app,rel);fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst)
 }
 const access=sourceAccess(app,adapter.targets);access.protect()
 const original=access.capture(),history=path.join(root,'maintenance',adapter.packageName)
 let serial=0
 const evidence=()=>{const dir=path.join(history,new Date(1791240000000+serial++*1000).toISOString().replace(/[:.]/g,'-')+'-'+randomUUID());fs.mkdirSync(dir,{recursive:true});return dir}
 const events=[]
 const driver={noop:false,preflight:async action=>{const {withdrawnCleanState}=await import('../deploy/maintenance/source.mjs');const clean=withdrawnCleanState(access);return {wasRunning:false,assemblyPresent:true,noop:driver.noop&&!clean,withdrawnClean:clean}},assertIdentity:async()=>events.push('identity'),assertStopped:async()=>events.push('stopped'),stop:async()=>events.push('stop'),start:async()=>{throw Error('停止态不得启动')},manage:async action=>events.push('manage:'+action),manageResidual:async action=>events.push('manageResidual:'+action),verify:async()=>({basicHealthVerified:true}),beginRecovery(){},stoppedAfterError:async()=>false,restorePackage:async()=>events.push('restorePackage')}
 const run=(action,dir=evidence())=>executeMaintenance({action,adapter,driver,source:access,evidenceDir:dir,budget:maintenanceBudget({milliseconds:240000})})
 return {root,app,access,original,history,evidence,driver,events,run}
}
function pollute(f){
 const file=f.access.file(STANDARD_RECORD),record=JSON.parse(fs.readFileSync(file,'utf8')),current=fs.readFileSync(f.access.file(index))
 record.before[index]=current.toString('base64')
 // 合成旧现场：污染备份与其旧代after原本就是配对的；产品恢复不允许改after。
 const backup=Object.keys(record.after).find(rel=>rel.startsWith(index+'.pre-seams-'))
 assert.ok(backup,'真实首装必须有主入口备份')
 fs.writeFileSync(f.access.file(backup),current);record.after[backup]=hash(current)
 fs.writeFileSync(file,JSON.stringify(record)+'\n','utf8')
 return record
}

test('首装→幂等启动→disposer撤标准代→再启动→整包卸载：最早保护前像保真',async t=>{
 const f=fixture(t),decoy=path.join(f.root,'data/chats/synthetic.db')
 fs.mkdirSync(path.dirname(decoy),{recursive:true});fs.writeFileSync(decoy,'原创业务诱饵','utf8')
 await f.run('install')
 const record=JSON.parse(fs.readFileSync(f.access.file(STANDARD_RECORD),'utf8'))
 assert.equal(record.before[index],f.original[index])
 assert.equal(adapter.applyStandardSeams({appDir:f.app}).changed,false)
 assert.equal(adapter.applyStandardSeams({appDir:f.app}).changed,false)
 adapter.uninstallStandardSeams({appDir:f.app})
 adapter.applyStandardSeams({appDir:f.app})
 assert.equal(JSON.parse(fs.readFileSync(f.access.file(STANDARD_RECORD),'utf8')).before[index],f.original[index])
 const unrelated=index+'.pre-seams-unrelated.bak';fs.writeFileSync(f.access.file(unrelated),'另一项维护的材料','utf8')
 await f.run('uninstall');f.access.assertImage(f.original)
 assert.equal(fs.readFileSync(f.access.file(unrelated),'utf8'),'另一项维护的材料','普通卸载不得删除记录外材料')
 assert.equal(fs.readFileSync(decoy,'utf8'),'原创业务诱饵')
 assert.ok(!f.events.includes('stop'))
})

test('历史坏前像：check不改目标→同版install自动修元数据且after不变→uninstall成功',async t=>{
 const f=fixture(t),installedEvidence=f.evidence()
 await f.run('install',installedEvidence)
 const polluted=pollute(f),baseline=f.access.capture()
 assert.throws(()=>adapter.uninstallStandardSeams({appDir:f.app}),/前像污染/)
 assert.deepEqual(f.access.capture(),baseline,'低层卸载写前拒绝')
 const inspected=rehearseSource('uninstall',f.access,adapter,f.evidence())
 assert.equal(inspected.result.repairAvailable,true)
 assert.ok(inspected.recovery.provenance.verifiedActiveFiles>30)
 assert.deepEqual(f.access.capture(),baseline,'check仅写自己的副本证据')
 assert.deepEqual(inspected.recovery.record.after,polluted.after)
 f.driver.noop=true;f.events.length=0
 const repaired=await f.run('install')
 assert.equal(repaired.changed,true);assert.equal(repaired.sourceMetadataRepaired,true)
 assert.ok(!f.events.some(value=>/^(?:stop|manage:)/.test(value)),'幂等修复不改装配或服务状态')
 const corrected=JSON.parse(fs.readFileSync(f.access.file(STANDARD_RECORD),'utf8'))
 assert.equal(corrected.before[index],f.original[index]);assert.deepEqual(corrected.after,polluted.after)
 assert.equal(Object.hasOwn(corrected.before,STANDARD_RECORD),false,'恢复记录不得捕获自身，否则restore提前删自身')
 for(const rel of adapter.targets.filter(value=>value.endsWith('.js')))assert.equal(f.access.capture()[rel],baseline[rel],'活动源码保持逐字节：'+rel)
 f.driver.noop=false
 await f.run('uninstall');f.access.assertImage(f.original)
})

test('受管备份污染：不能删除旧备份再复制当前缝合态重建',async t=>{
 const f=fixture(t);await f.run('install');pollute(f)
 const shim=f.access.file('tavern-plugin/lib/domain/chat-sqlite-store.js');fs.unlinkSync(shim)
 const baseline=f.access.capture()
 assert.throws(()=>applyAllSeams({appDir:f.app}),/前像污染/)
 assert.deepEqual(f.access.capture(),baseline,'备份及源码全部保留，不把删脏重建冒充修复')
})

test('一键uninstall直接恢复旧坏记录，无需用户先手工改记录或哈希',async t=>{
 const f=fixture(t);await f.run('install');const record=pollute(f)
 const unrelated=index+'.pre-seams-unrelated.bak';fs.writeFileSync(f.access.file(unrelated),'另一项维护的材料','utf8')
 const dir=f.evidence(),removed=await f.run('uninstall',dir)
 assert.equal(fs.readFileSync(f.access.file(unrelated),'utf8'),'另一项维护的材料','自动恢复不删除未认领材料')
 assert.equal(removed.fallback,true)
 const journal=JSON.parse(fs.readFileSync(path.join(dir,'residual-source-before.json'),'utf8'))
 assert.deepEqual(JSON.parse(Buffer.from(journal[STANDARD_RECORD],'base64').toString('utf8')).after,record.after,'有限归档保留原after，不改哈希冒充一致')
 f.access.assertImage(f.original)
 assert.ok(Object.keys(record.after).length>30)
})

test('缺本地旧前像可用官方材料兜底；未知新版/错误候选/不可证明漂移停前拒绝，不修after',async t=>{
 const f=fixture(t),installedEvidence=f.evidence();await f.run('install',installedEvidence)
 pollute(f);const baseline=f.access.capture(),file=path.join(installedEvidence,'source-before.json'),originalEvidence=fs.readFileSync(file)
 const recordPath=f.access.file(STANDARD_RECORD),recordBytes=fs.readFileSync(recordPath),missing=JSON.parse(recordBytes.toString('utf8'))
 missing.before[index]=null;fs.writeFileSync(recordPath,JSON.stringify(missing),'utf8');const invalid=f.access.capture(),entryBytes=fs.readFileSync(f.access.file(index))
 assert.throws(()=>adapter.uninstallStandardSeams({appDir:f.app}),error=>/^标准前像缺合法作者入口/.test(error.message))
 assert.deepEqual(f.access.capture(),invalid,'入口前像为空时也必须写前拒绝')
 assert.deepEqual(fs.readFileSync(f.access.file(index)),entryBytes,'null入口拒绝时目标入口字节不变，不留半恢复')
 assert.deepEqual(fs.readFileSync(recordPath),Buffer.from(JSON.stringify(missing),'utf8'),'null入口拒绝不改记录，不由拒绝路径重写前像')
 fs.writeFileSync(recordPath,recordBytes)
 fs.unlinkSync(file);f.events.length=0
 const rescued=await f.run('uninstall')
 assert.equal(rescued.fallback,true,'无本地历史前像时，可信官方材料仍可兜底，不形成装卸死锁')
 f.access.assertImage(f.original);assert.ok(!f.events.includes('stop'))
 // 拒绝条件必须是真正缺准确官方材料，而非缺可替代的本地旧证据。
 const unknown=fixture(t),unknownDir=unknown.evidence();await unknown.run('install',unknownDir);pollute(unknown)
 fs.writeFileSync(path.join(unknown.app,'.dsh-tavern-release.json'),JSON.stringify({commit:'f'.repeat(40)}),'utf8')
 const unknownFile=path.join(unknownDir,'source-before.json'),saved=fs.readFileSync(unknownFile),unproved=unknown.access.capture()
 fs.unlinkSync(unknownFile);unknown.events.length=0
 await assert.rejects(unknown.run('uninstall'),/需要当前酒馆准确官方源码/)
 assert.deepEqual(unknown.access.capture(),unproved);assert.ok(!unknown.events.some(value=>/^(?:stop|manageResidual:)/.test(value)))
 const wrong=JSON.parse(saved.toString('utf8'));wrong[index]=Buffer.from(Buffer.from(wrong[index],'base64').toString('utf8')+'\n// 不同作者代的额外代码\n').toString('base64')
 fs.writeFileSync(unknownFile,JSON.stringify(wrong),'utf8')
 await assert.rejects(unknown.run('uninstall'),/需要当前酒馆准确官方源码/)
 assert.deepEqual(unknown.access.capture(),unproved,'错误旧候选不能强盖未知新版')
 fs.writeFileSync(unknownFile,saved)
 fs.appendFileSync(unknown.access.file(index),'\n// 真实活動源码漂移\n','utf8');const drifted=unknown.access.capture()
 await assert.rejects(unknown.run('uninstall'),/需要当前酒馆准确官方源码/)
 assert.deepEqual(unknown.access.capture(),drifted,'未知新版漂移不得修改目标或after')
})

test('宿主退出已撤缝（包在/记录无/源码净）：uninstall仅卸装配不重放恢复，install重建接缝与记录',async t=>{
 const f=fixture(t)
 await f.run('install')
 // 模拟宿主正常退出：标准host disposer按官方卸缝API撤缝并删记录，装配保留。
 adapter.uninstallStandardSeams({appDir:f.app})
 assert.ok(!fs.existsSync(f.access.file(STANDARD_RECORD)),'退出撤缝后标准记录应不存在')
 const withdrawn=f.access.capture()
 // 退出撤缝态uninstall：无恢复材料可演，源码保持作者原像，仅走装配卸载。
 f.events.length=0
 const removed=await f.run('uninstall')
 assert.equal(removed.changed,true)
 assert.equal(removed.fallback,true,'退出撤缝态同样进入共用卸载')
 assert.equal(removed.changedFiles.length,0,'已净源码不重放或改写')
 assert.ok(f.events.includes('manageResidual:uninstall'),'装配卸载必须执行')
 assert.ok(!f.events.includes('restorePackage'),'无失败恢复')
 f.access.assertImage(withdrawn,'源码保持作者原像不动')
 // 退出撤缝态install：按首装重建接缝与标准记录。
 f.events.length=0
 const reinstalled=await f.run('install')
 assert.equal(reinstalled.changed,true)
 assert.ok(fs.existsSync(f.access.file(STANDARD_RECORD)),'install必须重建标准记录')
 assert.equal(adapter.checkStandardSeams({appDir:f.app}).ready,true)
 assert.equal(JSON.parse(fs.readFileSync(f.access.file(STANDARD_RECORD),'utf8')).before[index],f.original[index],'重建记录的前像必须是真实作者原像')
})
