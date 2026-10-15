// D02/D04/D05/D06：真实作者源码→标准writer→生成桥与装卸，不写作者树。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {fileURLToPath, pathToFileURL} from 'node:url'
import path from 'node:path'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {maintenanceTargets,applyStandardSeams,uninstallStandardSeams,checkStandardSeams} from '../deploy/standard-seams.mjs'
import os from 'node:os'
import {parse} from '../lib/vendor/acorn/acorn.mjs'
// 作者源码根：默认取本机桌面酒馆当前上游树（只读），可用环境变量覆盖；不用旧版本快照冒充现役锚点。
const authorRoot = path.resolve(process.env.DSH_TAVERN_COMPUTE_AUTHOR || 'D:/Program Files (x86)/DSH-Tavern/data/harness/apps/dsh-tavern')
const ROOT = pathToFileURL(authorRoot + path.sep)
const text = rel => fs.readFileSync(new URL(rel,ROOT),'utf8')
const moduleOf = source => import('data:text/javascript;base64,'+Buffer.from(source,'utf8').toString('base64'))
// 上游计算接入后的维护目标：executor/worker/策略/Helper任务 seam + 已退役计算桥（仅用于识别现场 owned 区块）。
const UPSTREAM_TARGETS=['tavern-plugin/lib/domain/opening-preparation.js','tavern-plugin/lib/domain/server-script-executor.js','tavern-plugin/lib/domain/server-script-worker.js','tavern-plugin/lib/domain/helper-generation-tasks.js','tavern-plugin/lib/domain/storage-upstream-compute.js']
const RETIRED_BRIDGES=['storage-server-execution.js','storage-helper-readonly.js','storage-opening-runtime.js']

test('作者纯内核：标准writer生成桥真实导出且全部维护目标内可解析',async()=>{
  const sources=new Map(maintenanceTargets.filter(rel=>fs.existsSync(new URL(rel,ROOT))).map(rel=>[rel,text(rel)]))
  const writes=buildCore(fileURLToPath(ROOT),sources)
  for(const rel of UPSTREAM_TARGETS.concat(['tavern-plugin/lib/index.js','tavern-plugin/lib/domain/story-timeline.js','tavern-plugin/lib/domain/background-task-coordinator.js','tavern-plugin/lib/domain/storage-native-data.js'])) {
    assert.ok(maintenanceTargets.includes(rel),rel);parse(writes.get(rel),{ecmaVersion:'latest',sourceType:'module'})
  }
  // 自有计算桥不再生成：计算唯一由上游服务端运行时执行。
  for(const name of RETIRED_BRIDGES) assert.ok(!writes.has('tavern-plugin/lib/domain/'+name),name)
  const nativeSource=writes.get('tavern-plugin/lib/domain/storage-native-data.js')
  const assembler=await moduleOf(nativeSource.slice(nativeSource.indexOf('export async function assembleTavernView')))
  assert.equal(typeof assembler.assembleTavernView,'function')
  assert.ok(writes.get('tavern-plugin/lib/index.js').includes('get assembleTavernView() { return assembleTavernView }'))
  assert.ok(writes.get('tavern-plugin/lib/domain/storage-upstream-compute.js').includes('upstream-compute'))
})

test('作者组装桥：真实有限源码安装/ready/现场代码保留卸载，新增桥回收无残留',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tavern-author-kernel-install-'))
  const relatives=[...maintenanceTargets,'tavern-plugin/package.json']
  const originals=new Map(relatives.filter(rel=>fs.existsSync(new URL(rel,ROOT))).map(rel=>[rel,text(rel)]))
  try {
    for(const [rel,source]of originals){const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source,'utf8')}
    // 明确用户现场注释；装卸不能拿官方原文覆盖现场。
    const rel='tavern-plugin/lib/index.js'
    const custom=originals.get(rel)+'\n// 用户现场自有注释\n'
    originals.set(rel,custom);fs.writeFileSync(path.join(root,rel),custom,'utf8')
    const install=applyStandardSeams({appDir:root,authorUnloaded:true})
    assert.equal(install.ready,true);assert.equal(checkStandardSeams({appDir:root}).ready,true)
    for(const rel of maintenanceTargets){const file=path.join(root,rel);if(fs.existsSync(file))parse(fs.readFileSync(file,'utf8'),{ecmaVersion:'latest',sourceType:'module'})}
    uninstallStandardSeams({appDir:root,authorUnloaded:true})
    for(const [rel,original]of originals)assert.equal(fs.readFileSync(path.join(root,rel),'utf8'),original,rel)
    for(const rel of maintenanceTargets.filter(rel=>!originals.has(rel)))assert.equal(fs.existsSync(path.join(root,rel)),false,rel)
  }finally{assert.ok(path.basename(root).startsWith('tavern-author-kernel-install-'));fs.rmSync(root,{recursive:true,force:true})}
})

test('状态组装警告：真实标准writer生成模块执行无需Host闭包',async()=>{
  const sources=new Map(maintenanceTargets.filter(rel=>fs.existsSync(new URL(rel,ROOT))).map(rel=>[rel,text(rel)]))
  const writes=buildCore(fileURLToPath(ROOT),sources)
  const entry=[...writes].find(([,value])=>typeof value==='string' && value.includes('export async function assembleTavernView'))
  assert.ok(entry,'标准 writer 必须产出装配器模块')
  const source=entry[1].slice(entry[1].indexOf('export async function assembleTavernView'))
  // 独立组装模块不得携带 Host 闭包符号（游离引用才是现场 ReferenceError 的来源）
  assert.equal(/\bprojectCompactionWarning\b/.test(source),false,'生成模块不得引用 projectCompactionWarning')
  assert.equal(/\bctx\.llm\b/.test(source),false,'生成模块不得引用 ctx.llm 表达式')
  assert.match(source,/contextCompaction/,'生成模块必须以注入值承载 contextCompaction')
  const assembler=await moduleOf(source)
  const handler={get:(_,key)=>key==='then'?undefined:(key===Symbol.toPrimitive?()=>''
    :(key==='toString'||key==='valueOf'?()=>''
    :stub)),apply:()=>stub,has:()=>true}
  const stub=new Proxy(function(){},handler)
  const compaction={warning:{turn:52,message:'压缩提醒'}}
  const values=new Proxy({contextCompaction:compaction,debugTurns:['最新','次新'],chat:stub,card:stub,str:value=>String(value),deferResources:stub,resourceRevision:0,activePresetSnapshot:null,cardUpdate:null,late:stub},{get:(target,key)=>key in target?target[key]:stub,has:()=>true})
  const view=await assembler.assembleTavernView(values)
  assert.equal(view.contextCompaction,compaction,'contextCompaction 必须直接来自 values 注入（同一对象）')
  assert.deepEqual(view.debugTurns,['最新','次新'],'debugTurns 必须保持最新优先且不额外 reverse')
})
