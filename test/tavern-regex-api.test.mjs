// 正则纯契约闸：抽真实Bclient helper与保存consumer对比，不加载卡/档、不联网。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTavernRegexApi } from '../lib/tavern-regex-api.js'
const copy = value => value === undefined ? undefined : structuredClone(value)
const client = readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/client.js',import.meta.url),'utf8')
const adapter = readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8')
function between(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,'真实作者锚点必须存在：'+start);return source.slice(a,b)}
const helpers = between(client,'\t\t\tfunction regexGroups() {','\t\t\twindow.getScriptId =')
const get = between(client,'\t\t\twindow.getTavernRegexes = function (option) {','\t\t\twindow.getVariables =')
const writes = between(client,'\t\t\tlet regexSaveTimer = null;','\t\t\twindow.importRawTavernRegex =')
function authorApi(snapshot) {
  const state={regexScripts:copy(snapshot.regexScripts)}, window={SillyTavern:{extensionSettings:copy(snapshot.extensionSettings),saveSettingsDebounced:async()=>{}}}
  new Function('window','state','copy','clearTimeout',helpers+get+writes)(window,state,copy,()=>{})
  return window
}
const projected=(id,enabled=true)=>({id,name:'规则'+id,findRegex:'/foo/gi',replaceString:'bar',trimStrings:[' '],placement:[1,'2',3,5,6],enabled,markdownOnly:true,promptOnly:false,runOnEdit:true,minDepth:'2',maxDepth:null})
const source={extensionSettings:{regex:[{id:'g1',scriptName:'规则g1'}],other:{untouched:true}},regexScripts:{global:[projected('g1'),projected('g2',false)],character:[projected('c1')]}}
function harness(snapshot=copy(source), {fail=false,returnValue,guard=false,closeOnSave=false}={}) {
  const current={sessionId:'regex-fixture'}, calls=[], mirror={open:true}, data={snapshot}, persisted={settings:copy(snapshot.extensionSettings)}
  function assertOpen(binding){assert.equal(binding,current);if(!mirror.open)throw new Error('窗口已关闭')}
  const api=createTavernRegexApi({readSnapshot:()=>data.snapshot,readOpen:()=>{assertOpen(current);return current},requireOpen:()=>{assertOpen(current);return current},assertOpen,
    saveExtensionSettings:async(sessionId,next,expected)=>{
      if(guard)throw new Error('结算中禁止跨资源写')
      assert.equal(sessionId,current.sessionId);calls.push({next:copy(next),expected:copy(expected)})
      if(fail)throw new Error('CAS冲突')
      if(closeOnSave)mirror.open=false
      if(JSON.stringify(expected)!==JSON.stringify(persisted.settings))throw new Error('CAS冲突')
      persisted.settings=copy(next)
      return returnValue === undefined ? {updated:true,extensionSettings:copy(next)} : returnValue
    }})
  return {api,current,calls,mirror,data,persisted}
}
// 同步get两套选项不能合并成假格式：type不附scope，且忽略enable_state。
for(const option of [undefined,{}, {type:'global'}, {type:'character',enable_state:'disabled'}, {scope:'all'}, {scope:'global',enable_state:'enabled'}, {scope:'character',enable_state:'disabled'}, {scope:'all',enable_state:'disabled'}]){
  const h=harness(), author=authorApi(source)
  assert.deepEqual(h.api.getTavernRegexes(option),author.getTavernRegexes(option))
  assert.equal(h.api.getTavernRegexes(option) instanceof Promise,false)
}
for(const option of [{type:'bogus'},{scope:'bogus'},{enable_state:'bogus'}])assert.throws(()=>harness().api.getTavernRegexes(option),/正则/)
const detached=harness();detached.api.getTavernRegexes()[0].trim_strings.push('污染');assert.equal(detached.api.getTavernRegexes()[0].trim_strings.length,1)
const missing=harness();missing.data.snapshot={extensionSettings:{}};assert.throws(()=>missing.api.getTavernRegexes(),/快照未加载/)
missing.data.snapshot=Promise.resolve(source);assert.throws(()=>missing.api.getTavernRegexes(),/同步预取/)
// replace返回undefined、整份settings CAS、原人物组必须精确不变。
const h=harness(), author=authorApi(source), items=h.api.getTavernRegexes()
items[0].enabled=false;items[0].replace_string='换';items[0].source.reasoning=false
assert.equal(await h.api.replaceTavernRegexes(items),undefined)
await author.replaceTavernRegexes(items)
assert.deepEqual(h.persisted.settings,author.SillyTavern.extensionSettings)
assert.deepEqual(h.calls[0].expected,source.extensionSettings)
assert.deepEqual(h.api.getTavernRegexes(),author.getTavernRegexes())
assert.deepEqual(source.extensionSettings.other,{untouched:true})
const same=copy(items);same.find(x=>x.scope==='character').script_name='卡修改'
await assert.rejects(h.api.replaceTavernRegexes(same),/人物卡内置正则/)
await assert.rejects(h.api.replaceTavernRegexes([], {scope:'character'}),/只允许/)
await assert.rejects(h.api.replaceTavernRegexes([], {type:'character'}),/只允许/)
await assert.rejects(h.api.replaceTavernRegexes([], {scope:'all'}),/人物卡内置/)
const originalCalls=h.calls.length
await assert.rejects(h.api.updateTavernRegexesWith(null),/必须是函数/)
assert.equal(h.calls.length,originalCalls)
// updater支持await、返回undefined时采用draft，结果与作者一致且下一轮CAS使用上一保存回执。
const update=draft=>{draft[0].replace_string='第二次';draft[0].destination.prompt=true}
assert.deepEqual(await h.api.updateTavernRegexesWith(update,{type:'global'}),await author.updateTavernRegexesWith(update,{type:'global'}))
assert.deepEqual(h.persisted.settings,author.SillyTavern.extensionSettings)
assert.deepEqual(h.calls[1].expected,h.calls[0].next)
const next=[{id:'raw',scriptName:'原格式',findRegex:'/x/',disabled:true,placement:[2],markdownOnly:false,promptOnly:true,runOnEdit:true,minDepth:0,maxDepth:5}]
assert.deepEqual(await h.api.updateTavernRegexesWith(async()=>copy(next),{type:'global'}),await author.updateTavernRegexesWith(async()=>copy(next),{type:'global'}))
assert.deepEqual(h.persisted.settings,author.SillyTavern.extensionSettings)
// scope:global仍要求item.scope=global，不能私加全局默认（作者会过滤无scope项）。
await h.api.replaceTavernRegexes(next,{scope:'global'});await author.replaceTavernRegexes(next,{scope:'global'})
assert.deepEqual(h.api.getTavernRegexes(),author.getTavernRegexes())
// CAS/父adapter guard/迟到写/不完整回执都响亮，失败不污染成功读镜像。
const failed=harness(undefined,{fail:true}), before=failed.api.getTavernRegexes()
await assert.rejects(failed.api.replaceTavernRegexes([],{type:'global'}),/CAS冲突/)
assert.deepEqual(failed.api.getTavernRegexes(),before)
const guarded=harness(undefined,{guard:true});await assert.rejects(guarded.api.replaceTavernRegexes([],{type:'global'}),/禁止跨资源写/);assert.equal(guarded.calls.length,0)
const late=harness();await assert.rejects(late.api.updateTavernRegexesWith(async draft=>{late.mirror.open=false;return draft}),/窗口已关闭/);assert.equal(late.calls.length,0)
// 入口已关窗（requireOpen）与保存回执后关窗（提交后 assertOpen）都必须响亮，且不得把未确认的写留进读镜像。
const closed=harness();closed.mirror.open=false;await assert.rejects(closed.api.replaceTavernRegexes([],{type:'global'}),/窗口已关闭/);assert.equal(closed.calls.length,0)
const afterSave=harness(undefined,{closeOnSave:true}),keep=afterSave.api.getTavernRegexes()
await assert.rejects(afterSave.api.replaceTavernRegexes([],{type:'global'}),/窗口已关闭/);assert.equal(afterSave.calls.length,1)
afterSave.mirror.open=true;assert.deepEqual(afterSave.api.getTavernRegexes(),keep)
const receipt=harness(undefined,{returnValue:{updated:true}});await assert.rejects(receipt.api.replaceTavernRegexes([],{type:'global'}),/未确认保存/)
assert.throws(()=>h.api.importRawTavernRegex('file','{}'),error=>error.code==='DSH_TAVERN_SERVER_UNSUPPORTED_API')
// 快照刷新替换镜像，不继续读旧缓存；缺作者投影绝不猜raw格式。
h.data.snapshot=copy(source);assert.deepEqual(h.api.getTavernRegexes(),authorApi(source).getTavernRegexes())
// 抽作者真实saveExtensionSettings方法，证明整份expected交给真实资源save，不是自造RPC。
const saveBody=between(adapter,'  async function saveExtensionSettings(sessionId, settings, expectedSettings) {','  async function context(')
const calls=[]
const save=new Function('assertScriptEnabled','resourcePermissionChat','options','observeResourceSave','resourceSaveSummary','str',saveBody+'\nreturn saveExtensionSettings')(
  async()=>{},async()=>({}),{extensionSettings:{save:async(next,expected)=>{calls.push({next,expected});return next}},extensionSettingsChanged:async()=>{}},async(_summary,action)=>action(),()=>({}),value=>String(value||''))
const actual=harness();const api=createTavernRegexApi({readSnapshot:()=>source,readOpen:()=>actual.current,requireOpen:()=>actual.current,assertOpen:()=>{},saveExtensionSettings:save})
await api.replaceTavernRegexes([], {type:'global'})
assert.deepEqual(calls[0].expected,source.extensionSettings);assert.deepEqual(calls[0].next,{...source.extensionSettings,regex:[]})
console.log('tavern-regex-api: 作者get/type/scope/过滤/投影/replace/update/CAS/人物不变/窗口关闭/缺快照/unsupported定向断言全部通过')
