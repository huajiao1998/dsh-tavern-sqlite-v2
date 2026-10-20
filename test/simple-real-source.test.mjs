// 只验证新直接计划/写入路径，有限源码夹具，不加载作者/业务、不连现场。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {parseSeamSource} from '../deploy/comment-seam-blocks.mjs'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
import {prepareStandardSeams,writePreparedStandardSeams,checkStandardSeams,maintenanceTargets} from '../deploy/standard-seams.mjs'

test('直接接缝：真实作者有限源码一次计划写入语法完整并卸回现场，不需隔离预演',()=>{
 const fixture=fileURLToPath(new URL('../../../tmp/upstream-a2008-review-20261010/author-tree/dsh-tavern-a2008bf932031616fd80ec265cbdba5d0b559312/',import.meta.url))
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'simple-real-seams-')),before=new Map()
 try{
  for(const rel of [...maintenanceTargets,'tavern-plugin/package.json']){
   const input=path.join(fixture,rel);if(!fs.existsSync(input))continue
   let text=fs.readFileSync(input,'utf8')
   if(rel.endsWith('/tavern-script-dispatch.js'))text=text.replace('= 30000','= 180000')
   if(rel.endsWith('/server-template-runtime.js'))text=text.replace('timeoutMs = 120000','timeoutMs = 900000')
   const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,'utf8');before.set(rel,text)
  }
  const budgetRel='tavern-plugin/lib/domain/tavern-script-dispatch.js',budgetFile=path.join(root,budgetRel),budget=fs.readFileSync(budgetFile,'utf8')
  fs.writeFileSync(budgetFile,budget.replace('TAVERN_SCRIPT_CLAIM_TIMEOUT_MS','REMOVED_REQUIRED_ANCHOR'),'utf8')
  assert.throws(()=>prepareStandardSeams({appDir:root,operation:'install'}),/dispatch|timeout|超时|预算|声明|锚点/)
  assert.equal(fs.existsSync(path.join(root,'.tavern-comment-seams.json')),false,'缺必需锚点源码零写')
  for(const [rel,text]of before)if(rel!==budgetRel)assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),text,'缺必需锚点不得写其它源码')
  fs.writeFileSync(budgetFile,budget,'utf8')
  const start=performance.now(),plan=prepareStandardSeams({appDir:root,operation:'install'})
  assert.ok(plan.changes.length>20,'实际全部接缝调用真实buildCore')
  const business=buildCore(root,new Map([...before].filter(([rel])=>maintenanceTargets.includes(rel))))
  // 只在本次开发叶检查区块组合是否保留真实业务变换结果；不是产品安装资格检查。
  for(const {rel,after}of plan.changes){
   if(after===null||!before.has(rel))continue
   const blocks=parseSeamSource(after,{rel,ast:false}).blocks
   let active=after
   for(const block of [...blocks].reverse())active=active.slice(0,block.start)+after.slice(block.regions.active.beginEnd,block.regions.active.endStart)+active.slice(block.end)
   const expected=business.get(rel)
   if(active!==expected){let at=0;while(active[at]===expected[at]&&at<active.length&&at<expected.length)at++;console.log(JSON.stringify({rel,firstDifference:at,actual:active.slice(Math.max(0,at-120),at+240),expected:expected.slice(Math.max(0,at-120),at+240),lengths:[active.length,expected.length]}))}
   assert.ok(active===expected||active===expected+'\n',rel+'区块ACTIVE组合必须等于实际业务变换，不能丢/重复声明或吞块外')
  }
  const result=writePreparedStandardSeams(plan)
  const indexFile=path.join(root,'tavern-plugin/lib/index.js'),installedIndex=fs.readFileSync(indexFile,'utf8')
  fs.writeFileSync(indexFile,installedIndex+'\n// 用户块外说明\n','utf8')
  const quickStart=performance.now();assert.equal(checkStandardSeams({appDir:root}).ready,true)
  const quickMs=Math.round(performance.now()-quickStart)
  assert.equal(prepareStandardSeams({appDir:root,operation:'install'}).changes.length,0,'现装重接不重包区块/丢块外说明')
  fs.writeFileSync(indexFile,installedIndex,'utf8')
  for(const rel of maintenanceTargets){const file=path.join(root,rel);if(fs.existsSync(file))try{parse(fs.readFileSync(file,'utf8'),{ecmaVersion:'latest',sourceType:'module',allowHashBang:true})}catch(error){fs.mkdirSync('tmp/simple-seams-failure',{recursive:true});fs.writeFileSync('tmp/simple-seams-failure/failed-source.js',fs.readFileSync(file,'utf8'),'utf8');error.message=rel+'：'+error.message;throw error}}
  const installedMs=Math.round(performance.now()-start)
  const index=fs.readFileSync(path.join(root,'tavern-plugin/lib/index.js'),'utf8')
  assert.ok(index.includes("from './domain/storage-failure-state.js'"));assert.ok(!index.includes("from '@deepseek-ai/dsh-session'"),'作者不再需现场解析补链')
  const originalCount=(index.match(/\[dsh-tavern-seam:ORIGINAL_BEGIN\]/g)||[]).length
  assert.ok(originalCount>5,'多段区块不吞整文件')
  const unplan=prepareStandardSeams({appDir:root,operation:'uninstall'});writePreparedStandardSeams(unplan)
  for(const [rel,text]of before)assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),text,rel+'卸回现场原文')
  for(const rel of maintenanceTargets)if(!before.has(rel))assert.equal(fs.existsSync(path.join(root,rel)),false,'卸除插件桥：'+rel)
  assert.equal(fs.existsSync(path.join(root,'.tavern-comment-seams.json')),false)
  console.log(JSON.stringify({phase:'simple-real-source',installedMs,quickMs,totalMs:Math.round(performance.now()-start),changed:result.written.length,indexBlocks:originalCount}))
 }finally{assert.ok(path.basename(root).startsWith('simple-real-seams-'));fs.rmSync(root,{recursive:true,force:true})}
})
