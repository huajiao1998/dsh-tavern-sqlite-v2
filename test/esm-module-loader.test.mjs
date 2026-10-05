// 原生ESM最小图断言：只用本地模拟fetch与合成源码，无真实远程/卡/存档。
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtempSync, readdirSync, rmSync, rmdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createEsmModuleLoader } from '../lib/mvu/esm-module-loader.js'
const lookupImpl = async () => [{address:'93.184.216.34',family:4}]
const quietContext=() => vm.createContext({})
if(typeof vm.SourceTextModule!=='function') {
  assert.throws(()=>createEsmModuleLoader({context:quietContext()}),error=>error.code==='ESM_VM_MODULES_UNAVAILABLE')
  console.log('esm-module-loader: 无flag明确拒绝原生ESM，不做伪转译')
} else {
  const sources = new Map([
    ['https://modules.example.com/loader-test/a.js', `import { readA } from './b.js'; export let a=3; export function setA(v){a=v}; export function fromB(){return readA()}`],
    ['https://modules.example.com/loader-test/b.js', `import {a} from './a.js'; export function readA(){return a}`],
    ['https://modules.example.com/loader-test/dynamic.js', `export const value=await Promise.resolve(42)`],
    ['https://modules.example.com/loader-test/dom.js', `document.querySelector('#x'); export const ui=true`],
    ['https://modules.example.com/loader-test/bad.js', `export const =`],
    ['https://modules.example.com/loader-test/after-redirect/entry.js', `import {n} from './relative.js'; export {n}`],
    ['https://modules.example.com/loader-test/after-redirect/relative.js', `export const n=19`],
  ])
  const requested=[], markers=[]
  const fetchImpl=async url=>{
    requested.push(url)
    if(url.endsWith('/redirect.js'))return new Response(null,{status:302,headers:{location:'./after-redirect/entry.js'}})
    if(url.endsWith('/private-redirect.js'))return new Response(null,{status:302,headers:{location:'https://127.0.0.1/secret'}})
    if(url.endsWith('/too-large.js'))return new Response('x',{headers:{'content-type':'application/javascript','content-length':String(6*1024*1024)}})
    if(!sources.has(url))return new Response('not found',{status:404,headers:{'content-type':'text/plain'}})
    return new Response(sources.get(url),{headers:{'content-type':'application/javascript'}})
  }
  const loader=createEsmModuleLoader({context:quietContext(),hostApi:{getVariables:()=>({hp:8}),eventOn:()=>{}},fetchImpl,lookupImpl,
    classify:code=>code.includes('document.querySelector')?'browser-ui':'esm',onBrowserModule:url=>markers.push(url)})
  try {
    const graph=await loader.load({name:'main',code:`import {a,setA,fromB} from 'https://modules.example.com/loader-test/a.js';import {getVariables} from 'tavern-helper';setA(9);export const answer=await Promise.resolve(a+fromB()+getVariables().hp)`})
    assert.equal(graph.namespace.answer,26,'原生循环依赖/live binding/TLA与Helper facade')
    const dynamic=await loader.load({name:'dynamic-main',code:`const m=await import('https://modules.example.com/loader-test/dynamic.js');export const value=m.value`})
    assert.equal(dynamic.namespace.value,42)
    await loader.waitForImports()
    const redirected=await loader.load({name:'redirect-main',code:`export {n} from 'https://modules.example.com/loader-test/redirect.js'`})
    assert.equal(redirected.namespace.n,19,'重定向相对import基准必须最终URL')
    await assert.rejects(loader.load({name:'graph-dom',code:`import 'https://modules.example.com/loader-test/dom.js'`}),error=>error.code==='card-script-dom')
    assert.deepEqual(markers,['https://modules.example.com/loader-test/dom.js'])
    for(const spec of ['node:fs','file:///tmp/a.js','data:text/javascript,export default 1','https://127.0.0.1/a.js','https://10.0.0.1/a.js','https://[::1]/a.js','https://user:secret@modules.example.com/a.js','lodash']) {
      await assert.rejects(loader.load({name:spec,code:`import ${JSON.stringify(spec)}`}),error=>/ESM_(URL|SPECIFIER)_DENIED/.test(error.code))
    }
    await assert.rejects(loader.load({name:'private-redirect',code:`import 'https://modules.example.com/loader-test/private-redirect.js'`}),error=>error.code==='ESM_URL_DENIED')
    await assert.rejects(loader.load({name:'oversized',code:`import 'https://modules.example.com/loader-test/too-large.js'`}),error=>error.code==='ESM_SOURCE_LIMIT')
    await assert.rejects(loader.load({name:'bad-syntax',code:`import 'https://modules.example.com/loader-test/bad.js'`}),error=>error.name==='SyntaxError')
  } finally {loader.dispose()}
  // 请求URL与最终URL并行入图仍只执行一次，循环重定向别名不能互等promise。
  for (const prefix of ['redirect-alias-first','redirect-final-first']) {
    const aliasRoot='https://modules.example.com/loader-test/'+prefix+'/'
    const urls=[aliasRoot+'alias.js',aliasRoot+'final.js',aliasRoot+'second-alias.js']
    if(prefix.endsWith('final-first'))[urls[0],urls[1]]=[urls[1],urls[0]]
    const same=createEsmModuleLoader({context:vm.createContext({executions:0}),lookupImpl,fetchImpl:async url=>{
      if(url.endsWith('alias.js'))return new Response(null,{status:302,headers:{location:'./final.js'}})
      return new Response(`globalThis.executions++;export const instance={};export const count=globalThis.executions`,{headers:{'content-type':'application/javascript'}})
    }})
    try {
      const result=await same.load({name:prefix,code:`import * as a from '${urls[0]}';import * as b from '${urls[1]}';import * as c from '${urls[2]}';export const same=a.instance===b.instance&&b.instance===c.instance;export const count=c.count`})
      assert.equal(result.namespace.same,true,'重定向别名必须共享最终模块实例')
      assert.equal(result.namespace.count,1,'并发别名只有一次模块顶层执行')
    } finally {same.dispose()}
  }
  // 成功源码可共享有界缓存，模块实例必须仍按context隔离；失败源码不入缓存。
  let badFetched=0
  const second=createEsmModuleLoader({context:quietContext(),fetchImpl:async url=>{if(url.endsWith('/bad.js')){badFetched++;return fetchImpl(url)}throw new Error('缓存命中不应再fetch')},lookupImpl})
  try {
    const cached=await second.load({name:'cached',code:`import {a} from 'https://modules.example.com/loader-test/a.js';export {a}`})
    assert.equal(cached.namespace.a,3,'源码共享不共享第一个context的live state9')
    await assert.rejects(second.load({name:'bad-not-cached',code:`import 'https://modules.example.com/loader-test/bad.js'`}),error=>error.name==='SyntaxError')
    assert.equal(badFetched,1)
  } finally {second.dispose()}
  const stalled=createEsmModuleLoader({context:quietContext(),lookupImpl,fetchImpl,loadTimeoutMs:20})
  await assert.rejects(stalled.load({name:'tla-never',code:'await new Promise(()=>{});export const x=1'}),error=>error.code==='ESM_LOAD_TIMEOUT')
  stalled.dispose()
  const cancelled=createEsmModuleLoader({context:quietContext(),lookupImpl,fetchImpl,loadTimeoutMs:1000})
  const waiting=cancelled.load({name:'tla-cancel',code:'await new Promise(()=>{});export const x=1'})
  cancelled.dispose()
  await assert.rejects(waiting,error=>error.code==='CARD_RUNTIME_DISPOSED')
  await assert.rejects(cancelled.load({name:'late',code:'export const x=1'}),error=>error.code==='CARD_RUNTIME_DISPOSED')
  // SQLite源码缓存与限制，只打开本测试刚建的独占临时目录，不接触任何业务档。
  const cacheDir=mkdtempSync(path.join(os.tmpdir(),'tavern-esm-loader-own-'))
  const persistentUrl='https://modules.example.com/loader-test/persistent.js'
  let dbLoader
  try {
    dbLoader=createEsmModuleLoader({context:quietContext(),cacheDir,lookupImpl,fetchImpl:async()=>new Response('export const persisted=17',{headers:{'content-type':'application/javascript'}})})
    assert.equal((await dbLoader.load({name:'persist',code:`export {persisted} from '${persistentUrl}'`})).namespace.persisted,17)
    dbLoader.dispose()
    dbLoader=createEsmModuleLoader({context:quietContext(),cacheDir,lookupImpl,fetchImpl:async()=>{throw new Error('不应访问网络')}})
    assert.equal((await dbLoader.load({name:'persist-reopen',code:`export {persisted} from '${persistentUrl}'`})).namespace.persisted,17)
    dbLoader.dispose()
    const streamed=createEsmModuleLoader({context:quietContext(),lookupImpl,fetchImpl:async()=>new Response(new Uint8Array(5*1024*1024+1),{headers:{'content-type':'application/javascript'}})})
    await assert.rejects(streamed.load({name:'streamed-limit',code:`import 'https://modules.example.com/loader-test/stream-large.js'`}),error=>error.code==='ESM_SOURCE_LIMIT')
    streamed.dispose()
    const dnsDenied=createEsmModuleLoader({context:quietContext(),lookupImpl:async()=>[{address:'10.1.1.1'}],fetchImpl:async()=>{throw new Error('私网DNS不能发请求')}})
    await assert.rejects(dnsDenied.load({name:'private-dns',code:`import 'https://private.example.com/a.js'`}),error=>error.code==='ESM_URL_DENIED')
    dnsDenied.dispose()
    let aborted=false
    const inflight=createEsmModuleLoader({context:quietContext(),lookupImpl,fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'))},{once:true})
    })})
    const pending=inflight.load({name:'fetch-cancel',code:`import 'https://modules.example.com/loader-test/cancel-fetch.js'`})
    await new Promise(resolve=>setImmediate(resolve))
    inflight.dispose()
    await assert.rejects(pending,error=>error.code==='CARD_RUNTIME_DISPOSED')
    assert.equal(aborted,true,'释放需abort进行中的fetch')
    const dynamicFailure=createEsmModuleLoader({context:quietContext(),lookupImpl,fetchImpl})
    const script=new vm.Script(`import('https://modules.example.com/loader-test/missing-dynamic.js').catch(()=>{})`,{filename:'dsh:script/dynamic-failure',importModuleDynamically:dynamicFailure.importModuleDynamically})
    script.runInContext(quietContext())
    await new Promise(resolve=>setImmediate(resolve))
    await assert.rejects(dynamicFailure.waitForImports(),error=>error.code==='ESM_FETCH_FAILED','脚本catch也不能把缺失模块当成成功钩子')
    dynamicFailure.dispose()
    // allowedHosts 配置错误必须明确拒绝：错误配置不能静默取消白名单（缺省 undefined 才是“不启用白名单”）。
    for (const badHosts of ['modules.example.com',['modules.example.com',7],[''],['  padded.example.com'],null,new Set(['modules.example.com']),{}]) {
      assert.throws(()=>createEsmModuleLoader({context:quietContext(),allowedHosts:badHosts}),error=>error.code==='ESM_ALLOWLIST_INVALID','allowedHosts配置错误必须拒绝：'+JSON.stringify(badHosts))
    }
    // 合法白名单仍按域名字面生效：名单内可加载，名单外必须拒绝。
    const allowListed=createEsmModuleLoader({context:quietContext(),lookupImpl,fetchImpl,allowedHosts:['modules.example.com']})
    try {
      assert.equal((await allowListed.load({name:'allow-hit',code:`import {a} from 'https://modules.example.com/loader-test/a.js';export {a}`})).namespace.a,3,'白名单内域名仍可加载')
      await assert.rejects(allowListed.load({name:'allow-miss',code:`import 'https://other.example.com/x.js'`}),error=>error.code==='ESM_URL_DENIED','白名单外域名必须拒绝')
    } finally {allowListed.dispose()}
    // 缓存TTL：夹具把 saved_at 回拨一年，重开loader必须判过期并重新取网络（不硬编码TTL常量）。
    const ttlDb=new DatabaseSync(path.join(cacheDir,'esm-source-cache.db'))
    try {
      ttlDb.prepare('UPDATE module_sources SET saved_at=? WHERE url=?').run(Date.now()-365*24*60*60*1000,persistentUrl)
      assert.equal(Number(ttlDb.prepare('SELECT COUNT(*) AS n FROM module_sources WHERE url=?').get(persistentUrl).n),1,'待回拨夹具行必须存在')
    } finally {ttlDb.close()}
    let ttlFetched=0
    const expired=createEsmModuleLoader({context:quietContext(),cacheDir,lookupImpl,fetchImpl:async()=>{ttlFetched++;return new Response('export const persisted=99',{headers:{'content-type':'application/javascript'}})}})
    try {
      assert.equal((await expired.load({name:'persist-expired',code:`export {persisted} from '${persistentUrl}'`})).namespace.persisted,99,'过期源码必须重新下载')
      assert.equal(ttlFetched,1,'过期源码不得命中缓存')
    } finally {expired.dispose()}
    // 缓存条目有界：夹具塞入129行且 used_at 严格递增（避开同毫秒并列），再存1条触发淘汰。
    const evictDir=mkdtempSync(path.join(os.tmpdir(),'tavern-esm-loader-evict-own-'))
    let checkDb
    try {
      createEsmModuleLoader({context:quietContext(),cacheDir:evictDir,lookupImpl,fetchImpl}).dispose()
      const base=Date.now()-60000
      const evictUrl=index=>'https://modules.example.com/loader-test/evict/'+String(index).padStart(3,'0')+'.js'
      const evictDb=new DatabaseSync(path.join(evictDir,'esm-source-cache.db'))
      try {
        const insert=evictDb.prepare('INSERT INTO module_sources (url, source, bytes, saved_at, used_at) VALUES (?, ?, ?, ?, ?)')
        for(let index=0;index<129;index++)insert.run(evictUrl(index),'export const v=0',15,base,base+index)
        assert.equal(Number(evictDb.prepare('SELECT COUNT(*) AS n FROM module_sources').get().n),129,'夹具必须写入129行')
      } finally {evictDb.close()}
      const freshUrl='https://modules.example.com/loader-test/evict-fresh.js'
      const evictLoader=createEsmModuleLoader({context:quietContext(),cacheDir:evictDir,lookupImpl,fetchImpl:async()=>new Response('export const fresh=1',{headers:{'content-type':'application/javascript'}})})
      try {
        assert.equal((await evictLoader.load({name:'evict-trigger',code:`export {fresh} from '${freshUrl}'`})).namespace.fresh,1)
      } finally {evictLoader.dispose()}
      checkDb=new DatabaseSync(path.join(evictDir,'esm-source-cache.db'))
      const count=Number(checkDb.prepare('SELECT COUNT(*) AS n FROM module_sources').get().n)
      const rows=url=>Number(checkDb.prepare('SELECT COUNT(*) AS n FROM module_sources WHERE url=?').get(url).n)
      assert.ok(count<=128,'SQLite源码缓存条目必须有界，实际 '+count)
      assert.equal(rows(evictUrl(0)),0,'最久未用条目必须被淘汰')
      assert.equal(rows(evictUrl(128)),1,'最新夹具条目必须保留')
      assert.equal(rows(freshUrl),1,'刚写入条目必须保留')
    } finally {
      // 先关夹具句柄再删文件，否则 Windows 上 rmSync 会 EPERM 并顶掉真正的断言信息。
      try {checkDb?.close()} catch {}
      try {
        for(const item of readdirSync(evictDir,{withFileTypes:true})){assert.equal(item.isFile(),true);rmSync(path.join(evictDir,item.name),{force:true,maxRetries:5,retryDelay:50})}
        rmdirSync(evictDir)
      } catch (cleanupError) {
        if(cleanupError?.name==='AssertionError') throw cleanupError
        console.log('esm-module-loader: 淘汰夹具清理未完成（不影响以上断言）：'+cleanupError.message)
      }
    }
  } finally {
    dbLoader?.dispose()
    for(const item of readdirSync(cacheDir,{withFileTypes:true})){assert.equal(item.isFile(),true);rmSync(path.join(cacheDir,item.name))}
    rmdirSync(cacheDir)
  }
  console.log('esm-module-loader: 原生循环/live binding/TLA/动态import/Helper/graphDOM/URL限额/源码缓存隔离/超时dispose通过')
}
