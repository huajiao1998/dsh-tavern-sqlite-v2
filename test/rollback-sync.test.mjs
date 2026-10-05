// 定向实码闸：rc.2客户端/网关，现有control帧codec，无服务、真实档、模型。
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import path from 'node:path'
import {applyRollbackSyncHandshakeTransform} from '../deploy/rollback-sync-install-transform.mjs'
import {applyRollbackSyncClientTransform} from '../deploy/rollback-sync-client-transform.mjs'
import {installRollbackSync,ROLLBACK_SYNC_KEY} from '../lib/rollback-sync.js'
const raw=readFileSync(new URL('../../../tmp/diag-original-open-20261002/api-session-client.js',import.meta.url),'utf8')
const gatewayRaw=readFileSync(new URL('../../../tmp/restore-original-20261002/current-api-gateway-client.js',import.meta.url),'utf8')
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const connection={generation:{getSnapshot:()=>1}}
function load(source,deps,extra='',runtime={}){
 let result
 const window={__ModuleLoader__:{load:({factory})=>{result=factory(name=>{if(!(name in deps))throw Error('夹具依赖未声明：'+name);return deps[name]})}}}
 vm.runInNewContext(source.replace('return module.exports;',extra+'\nreturn module.exports;'),{window,console,AbortController,AbortSignal,queueMicrotask,setTimeout,clearTimeout,Symbol,structuredClone,crypto:globalThis.crypto,WebSocket:{OPEN:1},...runtime}, {timeout:1000})
 return result
}
const store={notifySubscribers:listeners=>{for(const fn of listeners)fn()}}
const gateway=load(gatewayRaw,{'@deepseek-ai/cordis':{Service:class{}}},'exports.Mux=RemoteStreamMuxClient;')
const source=applyRollbackSyncClientTransform(raw)
const api=load(source,{'@deepseek-ai/cordis':{Context:{filter:Symbol('filter')}},'@deepseek-ai/dsh-api-gateway/client':gateway,'@deepseek-ai/dsh-client-store':store},'exports.Manager=SessionManager;exports.Session=Session;exports.ProjectionStore=ProjectionValueStore;')
const receipt=(revision=7,id='rollback-7')=>({protocol:1,id,revision,chatId:'chat-fixture',sessionId:'main-fixture',sessions:[{sessionId:'main-fixture',asOfSeq:4,values:{turnBoundary:{lastTurn:2},same:'新相同seq值'},queues:[],jobs:[],running:false,blank:false},{sessionId:'background-fixture',asOfSeq:1,values:{turnBoundary:{lastTurn:0}},queues:[],jobs:[],running:false,blank:true,parentSessionId:'main-fixture'}]})
const settle=async()=>{for(let n=0;n<12;n++)await Promise.resolve()}

test('真实作者握手安装到既有sessions：驻留/新Session、control/列表/事件同步且卸载还原',async()=>{
 const live=load(raw,{'@deepseek-ai/cordis':{Context:{filter:Symbol('filter')}},'@deepseek-ai/dsh-api-gateway/client':gateway,'@deepseek-ai/dsh-client-store':store},'exports.Manager=SessionManager;')
 const manager=new live.Manager({}),resident=manager.get('main-fixture'),oldResync=resident.resync,oldControl=manager.handleControlFrame
 const events=[],dispose=[],confirms=[]
 const sessions={manager,rootCtx:{emit:(...args)=>events.push(args)}}
 const handshake=applyRollbackSyncHandshakeTransform(readFileSync(new URL('../../../tmp/sql-test-kit/author-Jhnday/dsh-tavern-5173c8d593d1a4edc704cbb3da736ce1226e791b/tavern-plugin/src/client/modules/host-session-patch.js',import.meta.url),'utf8'))
 const deps={'@deepseek-ai/dsh-api-session-controller/client':live,'@deepseek-ai/cordis':{Context:{filter:Symbol('filter')}},'@deepseek-ai/dsh-api-gateway/client':gateway,'@deepseek-ai/dsh-client-store':store}
 const sandbox={window:{__ModuleLoader__:{}},console,AbortSignal,AbortController,setTimeout,clearTimeout,queueMicrotask,Symbol,structuredClone,crypto:globalThis.crypto,WebSocket:{OPEN:1},require:name=>deps[name],ctx:{sessions,effect:fn=>dispose.push(fn())},rpc:async name=>name==='getSessionPatchStatus'?{patch:{serverReady:true,status:'ready'}}:name==='getSessionPatchClient'?{source}:(confirms.push(name),{})}
 vm.runInNewContext(handshake+'\ninstallTavernSessionHistoryPatch(require,rpc,ctx);',sandbox,{timeout:1000});await settle()
 assert.deepEqual(confirms,['confirmSessionPatch']);assert.equal(typeof sessions.waitForTavernRollbackSync,'function');assert.notEqual(resident.resync,oldResync)
 const future=manager.get('future-fixture');assert.equal(resident.resync,future.resync,'后续new Session也安装逻辑resync')
 manager.projectionStore('main-fixture').apply('old','旧高水位',90);manager.summaries=[{sessionId:'main-fixture',running:true,blank:false}]
 const r=receipt();r.sessions[0].blank=true;const wait=sessions.waitForTavernRollbackSync(r)
 manager.handleControlFrame({type:'projection',key:ROLLBACK_SYNC_KEY,sessionId:r.sessionId,seq:4,value:r})
 assert.equal(await wait,true);assert.equal(manager.projectionStore('main-fixture').get('old'),undefined);assert.equal(manager.summaries[0].blank,true);assert.equal(events.length,1)
 for(const fn of dispose.reverse())fn();assert.equal(manager.handleControlFrame,oldControl);assert.equal(resident.resync,oldResync);assert.equal(sessions.waitForTavernRollbackSync,undefined)
})
test('实码control：低/相同seq、缺键清空、两页/后台、RPC先到/push去重，不动无关状态',async()=>{
 const pages=[new api.Manager({},'unrelated'),new api.Manager({},'main-fixture')],gates=[]
 for(const page of pages){
  for(const id of ['main-fixture','background-fixture','unrelated']){page.projectionStore(id).apply('old','旧尾',90);page.queues.set(id,[{id:'old'}]);page.jobsBySession.set(id,[{id:'old'}])}
  page.projectionStore('main-fixture').apply('same','旧相同seq值',4)
  for(const id of ['main-fixture','background-fixture']){const gate=deferred();gates.push(gate);let count=0;page.sessions.set(id,{replaceControl:()=>{},handleRunning:()=>{},handleBlank:()=>{},resync:()=>{count++;return gate.promise},count:()=>count})}
 }
 const r=receipt(),waiting=pages[0].waitForTavernRollbackSync(r)
 for(const page of pages)page.handleControlFrame({type:'projection',sessionId:r.sessionId,key:ROLLBACK_SYNC_KEY,seq:4,value:r})
 for(const page of pages){
  assert.equal(page.projectionStore('main-fixture').get('old'),undefined)
  assert.equal(page.projectionStore('main-fixture').get('same'),'新相同seq值')
  assert.equal(page.projectionStore('background-fixture').get('turnBoundary').lastTurn,0)
  assert.equal(page.projectionStore('main-fixture').get(ROLLBACK_SYNC_KEY),undefined,'通知不存为普通投影')
  assert.equal(page.projectionStore('unrelated').get('old'),'旧尾');assert.equal(page.queues.get('unrelated').length,1);assert.equal(page.jobsBySession.get('unrelated').length,1)
  assert.equal(page.jobsBySession.has('main-fixture'),false)
  page.handleControlFrame({type:'projection',sessionId:r.sessionId,key:ROLLBACK_SYNC_KEY,seq:4,value:r})
  assert.equal(page.sessions.get('main-fixture').count(),1);assert.equal(page.sessions.get('background-fixture').count(),1)
 }
 for(const g of gates)g.resolve()
 assert.equal(await waiting,true);assert.equal(await pages[1].waitForTavernRollbackSync(r),true)
 assert.equal(pages[0].selected,'unrelated')
 assert.equal(await pages[0].applyTavernRollbackSync(receipt(6,'old')),false)
 assert.throws(()=>pages[0].applyTavernRollbackSync(receipt(7,'conflict')),/冲突/)
 pages[0].handleControlFrame({type:'projection',sessionId:'main-fixture',key:'same',seq:5,value:'复用seq后的新事件'})
 assert.equal(pages[0].projectionStore('main-fixture').get('same'),'复用seq后的新事件')
})

test('实码list旧RPC晚到不会复活高水位；无关list状态正常安装',async()=>{
 const gate=deferred(),page=new api.Manager({session:{list:()=>gate.promise}})
 page.projectionStore('main-fixture').apply('old','旧',90)
 const inflight=page.refreshList();await page.applyTavernRollbackSync(receipt())
 gate.resolve({ok:true,value:{items:[{sessionId:'main-fixture',running:true,blank:false,updatedAt:1,projections:{asOfSeq:90,values:{same:'迟到旧值',old:'迟到旧尾'}}},{sessionId:'unrelated',running:false,blank:false,updatedAt:1,projections:{asOfSeq:90,values:{title:'正常'}}}]}})
 await inflight
 assert.equal(page.projectionStore('main-fixture').get('old'),undefined);assert.equal(page.projectionStore('main-fixture').get('same'),'新相同seq值')
 assert.equal(page.summaries.find(row=>row.sessionId==='main-fixture').running,false)
 assert.equal(page.projectionStore('unrelated').get('title'),'正常')
})

test('实码resync和网关mux：只cancel/open逻辑流、物理close=0，旧follow帧丢弃',async()=>{
 const mux=new gateway.Mux(),sent=[];let physicalClose=0
 const socket={readyState:1,send:payload=>sent.push(JSON.parse(payload)),close:()=>physicalClose++};mux.socket=socket;mux.running=true
 let lastSeq=8,opens=0
 const follow=(request,signal)=>{
  const inner=mux.open('session.follow',request,signal)
  return {async *[Symbol.asyncIterator](){const promise=inner.next();await settle();const open=sent.filter(frame=>frame.type==='open').at(-1);opens++;const event={seq:lastSeq,type:'session/end-seed',time:1,data:{}};mux.streams.get(open.streamId).push({type:'item',value:{type:'snapshot',cursor:lastSeq,records:[{event}],hasMore:false,projections:{asOfSeq:lastSeq,values:{same:'当下'}},assistantStream:{revision:0}}});yield (await promise).value;for await(const frame of inner)yield frame}}
 }
 const remote={$stream:options=>new gateway.RemoteStream(connection,options),session:{follow}}
 const session=new api.Session('main-fixture',remote);await session.open();assert.equal(opens,1)
 const old=session.events;lastSeq=4;await session.resync()
 assert.equal(opens,2);assert.equal(physicalClose,0);assert.equal(mux.socket,socket)
 assert.equal(sent.filter(frame=>frame.type==='cancel').length,1)
 assert.equal(session.baseSeq,4);assert.equal(session.openState,'open')
 old.options.publish({type:'append',entry:{event:{seq:9,type:'session/end-seed',time:1,data:{}}}})
 assert.equal(session.eventSource.getSnapshot().entries.at(-1).event.seq,4)
 await session.events.dispose()
})

function nativeHarness({hold=new Set(),hasMore=false}={}){
 const mux=new gateway.Mux(),sent=[],pending=[];let physicalClose=0,seq=8,opens=0,pageGate
 const socket={readyState:1,send:payload=>sent.push(JSON.parse(payload)),close:()=>physicalClose++};mux.socket=socket;mux.running=true
 const remote={$stream:options=>new gateway.RemoteStream(connection,options),session:{page:()=>pageGate.promise,follow(request,signal){
  const inner=mux.open('session.follow',request,signal)
  return {async *[Symbol.asyncIterator](){const first=inner.next();await settle();const open=sent.filter(frame=>frame.type==='open').at(-1),index=++opens
   const publish=()=>mux.streams.get(open.streamId)?.push({type:'item',value:{type:'snapshot',cursor:seq,records:[{event:{seq,type:'session/end-seed',time:1,data:{}}}],hasMore,projections:{asOfSeq:seq,values:{same:'current'}},assistantStream:{revision:0}}})
   if(hold.has(index))pending.push(publish);else publish()
   yield (await first).value;for await(const frame of inner)yield frame
  }}
 }}}
 const session=new api.Session('main-fixture',remote)
 return {session,pending,sent,setSeq:value=>{seq=value},page:()=>{pageGate=deferred();return pageGate},closes:()=>physicalClose,opens:()=>opens}
}
test('真实pending open/连续两次resync串行收敛，不留下旧窗口或重开物理连接',async()=>{
 const h=nativeHarness({hold:new Set([1,3])}),initial=h.session.open();await settle()
 h.setSeq(4);await h.session.resync();await initial;assert.equal(h.session.baseSeq,4)
 const earlier=h.session.resync();for(let n=0;n<100 && h.opens()<3;n++)await Promise.resolve();assert.equal(h.opens(),3,'前次resync已进入被挂起的逻辑open');h.setSeq(1);const latest=h.session.resync()
 await Promise.all([earlier,latest]);for(const push of h.pending)push();await settle()
 assert.equal(h.session.baseSeq,1);assert.equal(h.session.openState,'open');assert.equal(h.opens(),4);assert.equal(h.closes(),0)
 await h.session.events.dispose()
})
test('真实Session的blank单调relay由回退完整基线重置，不清输入草稿',async()=>{
 const h=nativeHarness();await h.session.open();h.session.blankBit=false;h.session.promptAttempted=true;h.session.firstPromptPendingTurn=true
 const page=new api.Manager({});page.sessions.set('main-fixture',h.session);const r=receipt();r.sessions[0].blank=true
 await page.applyTavernRollbackSync(r);assert.equal(h.session.blankBit,true);assert.equal(h.session.promptAttempted,false);assert.equal(h.session.firstPromptPendingTurn,false);assert.equal(h.closes(),0)
 await h.session.events.dispose()
})
test('回退前分页RPC晚到不能prepend已删除的高seq历史',async()=>{
 const h=nativeHarness({hasMore:true});await h.session.open();const gate=h.page(),older=h.session.loadOlder();await settle()
 h.setSeq(4);await h.session.resync();gate.resolve({ok:true,value:{records:[{event:{seq:7,type:'session/end-seed',time:1,data:{}}}],hasMore:false}});await older
 assert.equal(h.session.eventSource.getSnapshot().entries.length,1);assert.equal(h.session.baseSeq,4);assert.equal(h.closes(),0)
 await h.session.events.dispose()
})
test('同步失败/8秒超时硬拒，通知错误不吞waiter；更晚回退不被早回执回写',async()=>{
 const page=new api.Manager({}),gate=deferred();page.sessions.set('main-fixture',{replaceControl:()=>{},handleRunning:()=>{},handleBlank:()=>{},resync:()=>gate.promise})
 const r=receipt(),waiting=page.waitForTavernRollbackSync(r),task=page.applyTavernRollbackSync(r);gate.reject(Error('history failed'))
 await assert.rejects(task,/history failed/);await assert.rejects(waiting,/history failed/)
 const notifications=new api.Manager({});notifications.tavernRollbackNotify=()=>{throw Error('consumer failed')}
 const eventWait=notifications.waitForTavernRollbackSync(r);await assert.rejects(notifications.applyTavernRollbackSync(r),/consumer failed/);await assert.rejects(eventWait,/consumer failed/)
 let timer,cleared=0;const timed=load(source,{'@deepseek-ai/cordis':{Context:{filter:Symbol('filter')}},'@deepseek-ai/dsh-api-gateway/client':gateway,'@deepseek-ai/dsh-client-store':store},'exports.Manager=SessionManager;', {setTimeout:(fn,delay)=>{assert.equal(delay,8000);timer=fn;return 1},clearTimeout:()=>cleared++})
 const timeoutPage=new timed.Manager({}),timeout=timeoutPage.waitForTavernRollbackSync(r);timer();await assert.rejects(timeout,/未到达/);assert.equal(timeoutPage.tavernRollbackWaiters.size,0);assert.equal(cleared,1)
 const stuck=new timed.Manager({});stuck.sessions.set('main-fixture',{replaceControl:()=>{},handleRunning:()=>{},handleBlank:()=>{},resync:()=>new Promise(()=>{})});stuck.applyTavernRollbackSync(r);const historyTimeout=stuck.waitForTavernRollbackSync(r);timer();await assert.rejects(historyTimeout,/未完成/)
 const fresh=new api.Manager({});await fresh.applyTavernRollbackSync(receipt(8,'rollback-8'));assert.equal(await fresh.waitForTavernRollbackSync(r),false)
})
test('旧后台catalog RPC晚到不复活高代目录，自动再读最新身份和状态',async()=>{
 const gate=deferred();let reads=0
 const fresh={entries:[{kind:'child',id:'background-fixture',activity:'inactive'}],parentAvailable:true}
 const page=new api.Manager({subagents:{list:()=>++reads===1?gate.promise:Promise.resolve({ok:true,value:fresh})}})
 const old=page.refreshSubagents('main-fixture');await page.applyTavernRollbackSync(receipt());gate.resolve({ok:true,value:{entries:[{kind:'corrupt',id:'background-fixture'}],parentAvailable:true}});await old;await settle()
 assert.equal(reads,2);assert.equal(page.catalogs.get('main-fixture').entries[0].kind,'child')
})

test('Host生产发布是现有projection帧、完整目标状态、无普通事件持久化并清旧助手流',async()=>{
 const frames=[],streams=new Map([['main-fixture',{old:true}],['unrelated',{keep:true}]]);let service
 const projection={asOfSeq:4,values:{turnBoundary:{lastTurn:2}}}
 const controller={controlState:{ctx:{sessionProjections:{snapshot:()=>projection}},broadcast:frame=>frames.push(frame),jobsFor:()=>[]},history:{assistantStreams:streams}}
 installRollbackSync({get:()=>controller,provide:(_name,value)=>{service=value}})
 const session={header:{id:'main-fixture'},surface:{nodes:[1]},snapshotEvents:()=>[{seq:4}]},agent={session,phase:{kind:'idle'},inbox:{nextTurn:[],nextStep:[]}}
 const r=service.publish({chat:{id:'chat-fixture',sessionId:session.header.id,_storageRevision:7},rollbackId:'rollback-7',hiddenTurn:3,subjects:[{session,agent}]})
 assert.equal(frames.length,1);assert.equal(frames[0].type,'projection');assert.equal(frames[0].key,ROLLBACK_SYNC_KEY);assert.equal(r.sessions.length,1)
 projection.values.turnBoundary.lastTurn=99;assert.equal(frames[0].value.sessions[0].values.turnBoundary.lastTurn,2)
 assert.equal(streams.has('main-fixture'),false);assert.equal(streams.has('unrelated'),true)
 const codec=readFileSync(new URL('../../../tmp/restore-original-20261002/current-session-typert.js',import.meta.url),'utf8')
 const requireHost=createRequire(path.join(process.env.DSH_CHECKOUT || 'D:/Program Files (x86)/DSH Desktop/resources/app','package.json'))
 const actualCodec=await import('data:text/javascript;base64,'+Buffer.from(codec.replace("from 'zod'",'from '+JSON.stringify(pathToFileURL(requireHost.resolve('zod')).href))).toString('base64'))
 const schema=actualCodec.TYPERT.invocations.find(row=>row.namespace==='session' && row.method==='control').result.schema
 assert.deepEqual(schema.parse(frames[0]),frames[0],'实际rc.2严格codec无删字段、无协议改动')
 projection.values.inbox={'next-turn':[{id:'cold-queue',content:[{type:'text',text:'保留队列'}],source:{kind:'user',rpcId:'cold-rpc'}}],'next-step':[]}
 const cold=service.publish({chat:{id:'chat-fixture',sessionId:session.header.id,_storageRevision:8},rollbackId:'rollback-8',hiddenTurn:3,subjects:[{session}]})
 assert.equal(cold.sessions[0].queues[0].rpcId,'cold-rpc');assert.deepEqual(schema.parse(frames[1]),frames[1])
 assert.equal(applyRollbackSyncClientTransform(source),source)
 assert.throws(()=>applyRollbackSyncClientTransform(source.replace('const rollbackGenerations = new Map(','const bad = new Map(')),/不完整/)
})
