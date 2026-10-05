// 仅纯Helper wrapper断言；不启服务、不读档卡、不联网，lodash借本地既有冻结核心依赖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createTavernHelperExtensions } from '../lib/tavern-helper-api.js'
const require = createRequire(import.meta.url)
const lodash = require('../../../tools/mvu-server-core/node_modules/lodash/lodash.js')
const copy = value => structuredClone(value)
function fixture(extra = {}) {
  let open = true, activeScript = 'script-A'
  const current = {sessionId:'pure-helper-fixture',chat:{messages:[{},{}]}}
  const scopes = {global:{global:1,order:'global'},character:{character:1,order:'character'},chat:{chat:1,order:'chat'},
    'script:script-A':{script:1,order:'script'},'script:script-B':{script:2}, 'message:0':{order:'first',first:1},'message:1':{order:'last',last:1}}
  const records = []
  const assertOpen = captured => { if (!open || captured !== current) throw new Error('读写窗口已关闭') }
  const readOpen = () => { assertOpen(current); return current }
  const key = option => option.type === 'script' ? 'script:'+option.script_id : option.type === 'message' ? 'message:'+(option.message_id ?? 1) : option.type
  const api = createTavernHelperExtensions({
    getVariables:option => copy(scopes[key(option)] || {}),
    replaceVariables:async (value,option) => { records.push({value:copy(value),option:copy(option)});scopes[key(option)]=copy(value);return {updated:true} },
    readOpen,requireOpen:readOpen,assertOpen,lodash,currentScriptId:()=>activeScript,Mvu:{events:{ENDED:'ended'}},...extra,
  })
  return {api,records,scopes,current,close:()=>{open=false},activate:id=>{activeScript=id}}
}

test('变量merge、数组替换、插入优先级和返回Promise树与作者contract一致',async()=>{
  const browser = readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/client.js',import.meta.url),'utf8')
  const source = browser.slice(browser.indexOf('\t\t\twindow.insertOrAssignVariables = function'),browser.indexOf('\t\t\twindow.setChatMessages = async'))
  assert.ok(source.includes('window._.mergeWith'))
  const f=fixture(); f.scopes.chat={nested:{keep:1,over:2},array:[1,2,3]}
  const state={chat:copy(f.scopes.chat)}, window={_:lodash}
  window.replaceVariables=async value=>{state.chat=copy(value)}
  new Function('window','optionOf','getVariables','copy','call','localReplace',source)(window,option=>option||{type:'chat'},()=>copy(state.chat),copy,
    async (_name,{variables})=>{state.chat=copy(variables);return {updated:true}},next=>{state.chat=copy(next)})
  for (const [method,input] of [['insertOrAssignVariables',{nested:{over:8,new:3},array:[9]}],['insertVariables',{nested:{over:100,missing:4},array:[99]}]]) {
    const actual=f.api[method](input,{type:'chat'});assert.equal(typeof actual.then,'function')
    assert.deepEqual(await actual,await window[method](input,{type:'chat'}))
  }
  assert.deepEqual(f.scopes.chat.array,[9]);assert.equal(f.scopes.chat.nested.over,8)
  const updated=await f.api.updateVariablesWith(async draft=>({...draft,count:10}),{type:'chat'})
  assert.equal(updated.count,10)
  await f.api.updateVariablesWith(draft=>{draft.count=500},{type:'chat'})
  assert.equal(f.scopes.chat.count,10,'作者undefined返回保原current而非mutated draft')
  const deleted=await f.api.deleteVariable('nested.over',{type:'chat'})
  assert.equal(deleted.delete_occurred,true)
  assert.equal(Object.hasOwn(deleted.variables.nested,'over'),false)
})

test('默认script id随当前来源切换，getAllVariables同步正确合并且缺scope不伪空',()=>{
  const f=fixture()
  assert.equal(f.api.getVariables({type:'script'}).script,1)
  f.activate('script-B');assert.equal(f.api.getVariables({type:'script'}).script,2)
  f.activate('script-A')
  const all=f.api.getAllVariables();assert.equal(all.order,'chat');assert.equal(all.global,1);assert.equal(all.character,1);assert.equal(all.script,1)
  // 作者client:6957–6959：不遍历聊天消息，故 first/last 不得掺入。
  assert.equal(all.first,undefined);assert.equal(all.last,undefined);assert.equal(all.then,undefined)
  f.activate('');assert.throws(()=>f.api.getVariables({type:'script'}),/当前脚本身份/)
  const blocked=fixture({getVariables:option=>{if(option.type==='character')throw new Error('character unsupported');return {}}})
  assert.throws(()=>blocked.api.getAllVariables(),/character unsupported/)
  const promise=fixture({getVariables:()=>Promise.resolve({})})
  assert.throws(()=>promise.api.getVariables(),/同步读口不能返回Promise/)
})

test('异步更新等待期间窗口关闭不允许迟到写，宿主stale拒绝',async()=>{
  const f=fixture()
  await assert.rejects(f.api.updateVariablesWith(async()=>{f.close();return {late:1}},{type:'chat'}),/窗口已关闭/)
  assert.equal(f.records.length,0)
  const stale=fixture({replaceVariables:async()=>({stale:true})})
  await assert.rejects(stale.api.insertOrAssignVariables({x:1}),/聊天已变化/)
  await assert.rejects(f.api.replaceVariables({x:1}),/窗口已关闭/)
})

test('Mvu同形别名及真实全局初始化校验：existing/延迟/超时/bootstrap/窗口失效',async()=>{
  const globals={Zod:{kind:'actual-schema'},_:lodash}
  const f=fixture({globals:()=>globals,globalWaitTimeoutMs:20})
  assert.equal((await f.api.waitGlobalInitialized('Zod')).kind,'actual-schema')
  assert.equal(await f.api.waitGlobalInitialized('Mvu'),f.api.Mvu)
  assert.deepEqual(f.api.Mvu.events,{ENDED:'ended'})
  const value={stat_data:{hp:5},schema:{}}
  assert.deepEqual(await f.api.Mvu.replaceMvuData(value,{type:'chat'}),value)
  assert.deepEqual(f.api.Mvu.getMvuData({type:'chat'}),value)
  await assert.rejects(f.api.Mvu.parseMessage(),/未开放/)
  let checks=0
  const delayed=fixture({globals:()=>++checks<2?{Module:{__dshBootstrap:true}}:{Module:{ready:true}},globalWaitTimeoutMs:20})
  assert.equal((await delayed.api.waitGlobalInitialized('Module')).ready,true)
  await assert.rejects(f.api.waitGlobalInitialized('missing'),/全局对象未初始化/)
  f.close();await assert.rejects(f.api.waitGlobalInitialized('Zod'),/窗口已关闭/)
})

test('世界书entries解包、先读expectedEntriesCAS、Promise<void>及作者跨存储guard保留',async()=>{
  let stored=[{uid:1,name:'原条目',strategy:{keys:['x']}}],nextUid=2
  const writes=[]
  const host={getWorldbook:async(session,name,template)=>{assert.equal(session,'pure-helper-fixture');assert.equal(template,false);return {worldbook:{name,entries:copy(stored)}}},
    replaceWorldbook:async(session,name,entries,expectedEntries,template)=>{
      assert.equal(template,false);assert.deepEqual(expectedEntries,stored);writes.push({entries:copy(entries),expected:copy(expectedEntries)})
      stored=entries.map(entry=>({...entry,uid:entry.uid??nextUid++}));return {updated:true,worldbook:{name,entries:copy(stored)}}
    }}
  const f=fixture({host})
  const entries=await f.api.getWorldbook('current');assert.deepEqual(entries,stored);entries[0].name='外部修改';assert.equal(stored[0].name,'原条目')
  assert.equal(await f.api.replaceWorldbook('current',[{uid:1,name:'替换',strategy:{keys:[/regex/i]}}]),undefined)
  assert.deepEqual(writes[0].entries[0].strategy.keys,['/regex/i'])
  const updated=await f.api.updateWorldbookWith('current',draft=>{draft[0].name='更新'})
  assert.equal(updated[0].name,'更新','世界书undefined返回保mutated draft')
  const created=await f.api.createWorldbookEntries('current',[{uid:999,name:'新增'}])
  assert.equal(created.new_entries.length,1);assert.equal(created.new_entries[0].uid,2)
  const deleted=await f.api.deleteWorldbookEntries('current',entry=>entry.uid===1)
  assert.equal(deleted.deleted_entries[0].uid,1);assert.equal(deleted.worldbook.length,1)
  assert.deepEqual(deleted.worldbook,stored)
  const guarded=fixture({host:{...host,replaceWorldbook:async()=>{throw new Error('MVU 结算事务不能修改跨存储的世界书')}}})
  await assert.rejects(guarded.api.replaceWorldbook('current',[]),/跨存储/)
  const broken=fixture({host:{getWorldbook:async()=>({})}})
  await assert.rejects(broken.api.getWorldbook('current'),/缺少worldbook.entries/)
  await assert.rejects(f.api.replaceWorldbook('current',{}),/必须是数组/)
})

test('世界书名称/整书CRUD/regex只有真host注入才forward，缺能力明确unsupported',()=>{
  const f=fixture()
  for(const name of ['getWorldbookNames','createWorldbook','deleteWorldbook','getTavernRegexes','replaceTavernRegexes','updateTavernRegexesWith','importRawTavernRegex']) {
    assert.throws(()=>f.api[name]('anything'),error=>error.code==='DSH_TAVERN_SERVER_UNSUPPORTED_API')
  }
  const calls=[]
  const forwarded=fixture({host:{getWorldbookNames(session){calls.push(session);return ['实际宿主名']}}})
  assert.deepEqual(forwarded.api.getWorldbookNames(),['实际宿主名']);assert.deepEqual(calls,['pure-helper-fixture'])
})
