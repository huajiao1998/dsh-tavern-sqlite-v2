// 三项修复定向契约；只读作者源码，不读取任何存档，不运行模型请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { applyRowHistoryTransform, applyRowTimelineTransform } from '../deploy/row-rollback-transform.mjs'
import { applyClipboardTransform } from '../deploy/clipboard-transform.mjs'
import { applyModelErrorTransform } from '../deploy/model-error-transform.mjs'
const root = new URL('../../../', import.meta.url)
const author = new URL('tmp/plg-threefix-1001/story-timeline.js', root)
const client = new URL('tmp/cards-api-audit-145/author-client-3091.js', root)

test('回退入口不再读取历史revision；未知源码拒绝施缝', () => {
 const s = `    const beforeChat = await readChatRevision(chat.id, target.beforeRevision)
    if (beforeChat === undefined) throw new Error('找不到剧情 checkpoint 对应的历史 Chat revision: ' + target.beforeRevision)
    return Object.assign({}, intent, { beforeChat })`
 const out=applyRowHistoryTransform(s)
 assert.ok(!out.includes('await readChatRevision'))
 assert.equal(applyRowHistoryTransform(out),out)
 assert.throws(()=>applyRowHistoryTransform('未知作者修订'))
})

test('作者真实时间线：捕获业务头，正文只用当前行前缀，旧checkpoint拒绝伪造', { skip: !fs.existsSync(author) }, () => {
 const src=fs.readFileSync(author,'utf8');const out=applyRowTimelineTransform(src)
 assert.equal(applyRowTimelineTransform(out),out)
 assert.ok(out.includes('rowBefore: rollbackHead(chat)'))
 assert.ok(out.includes('rowBefore: operation.rowBefore'))
 assert.ok(!out.includes('messages: clone(chat.messages)'))
 const pure = out.replace(/^import .*\n/gm,'').replace(/^export /gm,'') + '\nglobalThis.factory=createStoryTimeline;'
 const ctx=vm.createContext({ structuredClone });vm.runInContext(pure,ctx)
 const timeline=ctx.factory({now:()=>1, makeId:(prefix)=>prefix+'-id'})
 let chat={id:'fake-chat',messages:[{role:'assistant',text:'旧正文',turn:1,greeting:true}],posture:'旧姿态',macroState:{x:1},tavernHelperScriptVariables:{x:1},variables:{hp:3},_storageRevision:14}
 const started=timeline.apply({chat,intent:{kind:'body.begin',turn:2,userText:'输入'}});chat=started.chat
 const operation=Object.values(chat.timeline.operations)[0]
 const completed=timeline.complete({chat,operationId:operation.id,basedOn:operation.basedOn,outcome:{status:'success'},apply(draft){draft.posture='新姿态';draft.variables={hp:9};draft.macroState={x:9};draft.tavernHelperScriptVariables={x:9};draft.messages.push({role:'user',text:'输入'},{role:'assistant',turn:2,text:'新正文'})}})
 chat=completed.chat
 const checkpoint=chat.timeline.checkpoints.at(-1)
 assert.ok(!Object.hasOwn(checkpoint.rowBefore,'messages'))
 const rolled=timeline.apply({chat,intent:{kind:'turn.rollback',turn:2,rowCheckpointId:checkpoint.id}})
 assert.equal(rolled.chat.messages.length,1)
 assert.equal(rolled.chat.posture,'旧姿态')
 assert.equal(rolled.chat.variables.hp,3)
 assert.equal(rolled.chat.macroState.x,1)
 assert.equal(rolled.chat.tavernHelperScriptVariables.x,1)
 const old=structuredClone(chat);delete old.timeline.checkpoints.at(-1).rowBefore
 assert.throws(()=>timeline.apply({chat:old,intent:{kind:'turn.rollback',turn:2,rowCheckpointId:checkpoint.id}}),/缺少行级回退基准/)
 assert.equal(old.messages.length,3)
})

test('实际错误弹窗：HTTP环境DOM复制成功才提示，不盲报已复制', {skip:!fs.existsSync(client)}, async()=>{
 const out=applyClipboardTransform(fs.readFileSync(client,'utf8'))
 assert.equal(applyClipboardTransform(out),out)
 const fn=out.slice(out.indexOf('async function copyErrorText'),out.indexOf('// Native alert/confirm')).trim()
 let value='',removed=0
 const button={textContent:'复制',isConnected:true}
 const doc={activeElement:{focus(){}},body:{appendChild(){}},createElement(){return {style:{},setAttribute(){},focus(){},select(){},setSelectionRange(){},remove(){removed++},set value(v){value=v}}},execCommand(action){assert.equal(action,'copy');return true}}
 const ctx=vm.createContext({document:doc,navigator:{},setTimeout(){},console})
 vm.runInContext(fn+'\nglobalThis.copy=copyErrorText;',ctx)
 assert.equal(await ctx.copy('错误文本',button),true)
 assert.equal(value,'错误文本');assert.equal(button.textContent,'已复制');assert.equal(removed,1)
 ctx.navigator.clipboard={writeText:()=>Promise.reject(new Error('权限拒绝'))}
 assert.equal(await ctx.copy('权限文本',button),true)
})

test('未注册网关明确解释动态路由，不误导用户开发专用适配器', () => {
 const fixture="export function presentModelError(error) {\n  const message = String(error?.message ?? error ?? '')\n  return error\n}"
 const out=applyModelErrorTransform(fixture)
 assert.equal(applyModelErrorTransform(out),out)
 const ctx=vm.createContext({});vm.runInContext(out.replace('export ','')+';globalThis.present=presentModelError',ctx)
 const error=ctx.present({code:'NO_ADAPTER',message:'no adapter registered for provider "gcli2api"'})
 assert.equal(error.code,'NO_ADAPTER')
 assert.match(error.message,/网关名称不需要单独开发适配器/)
 assert.match(error.message,/gcli2api/)
})
