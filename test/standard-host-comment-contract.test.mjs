// 仅验证真实运行时控制器的停态传参/顺序；Loader外壳沿既有rc2契约，不冒称真实宿主装配。
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AUTHOR_VERSION, ORIGINAL_ROW_ID, ORIGINAL_ROW_NAME, RUNTIME_PACKAGE_NAME, RUNTIME_VERSION, BOOT_PACKAGE_NAME, BOOT_VERSION, createStandardHostApply } from '../lib/standard-host.js'

test('块Runtime1 作者卸载后施缝与disposer撤缝的停止合同', async () => {
  const appDir=path.resolve('runtime-comment-contract'), entryPath=path.join(appDir,'tavern-plugin/lib/index.js')
  const order=[], store={};let ready=false, applied=null, removed=null
  const row={options:{id:ORIGINAL_ROW_ID,name:ORIGINAL_ROW_NAME,disabled:true},disabled:true,parent:{tree:{ctx:{baseUrl:pathToFileURL(appDir+path.sep).href}}}}
  const loader={store,entries:()=>[row],async create(options){order.push('create');store[options.id]={options,fiber:{state:2}};return options.id},async remove(id){order.push('remove');delete store[id]}}
  const seams={
    checkStandardSeams(){order.push('check');return {ready}},
    applyStandardSeams(args){order.push('apply');applied=args;assert.equal(Object.keys(store).length,0,'施缝前作者尚未加载');ready=true;return {ready:true,changed:true}},
    uninstallStandardSeams(args){order.push('uninstall');removed=args;assert.equal(Object.keys(store).length,0,'撤缝前必须已移除作者行');return {changed:true}},
  }
  const run=createStandardHostApply({loadSeams:async()=>seams,overrides:{
    resolveAuthor:async()=>({url:pathToFileURL(entryPath).href,entryPath,packageDir:path.dirname(path.dirname(entryPath)),packageJson:{name:ORIGINAL_ROW_NAME,version:AUTHOR_VERSION},version:AUTHOR_VERSION,appDir,source:'test',attempts:[]}),
    resolveRuntime:async()=>({dsh:{name:RUNTIME_PACKAGE_NAME,version:RUNTIME_VERSION},boot:{name:BOOT_PACKAGE_NAME,version:BOOT_VERSION},loader:{version:'1.0.3'},cordis:{version:'4.0.2'},anchors:[],attempts:[]}),
    preflight:()=>order.push('preflight'),
  }})
  const dispose=await run({get:name=>name==='loader'?loader:undefined,logger:{info(){},warn(){}}},{appDir})
  assert.equal(applied.authorUnloaded,true)
  assert.ok(order.indexOf('apply')<order.indexOf('create'),'先施缝再加载作者行')
  await dispose()
  assert.equal(removed.authorUnloaded,true)
  assert.equal(removed.reason,'dispose')
  assert.ok(order.indexOf('remove')<order.indexOf('uninstall'),'先移除作者行再撤缝')
})
