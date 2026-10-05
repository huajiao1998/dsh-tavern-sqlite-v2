// 定向实码闸：原创临时SQL档＋核准作者2.4投影/懒读工具。只测本刀，不启动服务或访问真实档。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {DatabaseSync} from 'node:sqlite'
import path from 'node:path'
import os from 'node:os'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {createChatSqliteStore} from '../chat-sqlite-store.js'
const workspace=fileURLToPath(new URL('../../../',import.meta.url))
const author=path.resolve(process.env.TAVERN_PROJECTION_AUTHOR_ROOT || path.join(workspace,'tmp/sql-test-kit/author-Jhnday/dsh-tavern-5173c8d593d1a4edc704cbb3da736ce1226e791b/tavern-plugin/lib/domain'))
assert.ok(existsSync(path.join(author,'chat-session-state.js')),'需要本机核准作者源码，只读源码，不下载、不读存档')
const load=name=>import(pathToFileURL(path.join(author,name+'.js')).href)
const [json,copy,scoped,lazy]=await Promise.all(['json-mutation','copy-json-tree','scoped-messages','lazy-history-read'].map(load))
// 只执行本刀真实函数，避免导入无关surface-restoration→DOM(jsdom)依赖，不装新包。
const source=readFileSync(path.join(author,'chat-session-state.js'),'utf8')
for(const marker of ['pendingMvuSettlementState','settlementTurn','projectDisplayRuntimeState'])assert.ok(source.includes('export function '+marker),'作者锚点漂移：'+marker)
const exact=source.slice(source.indexOf('export function pendingMvuSettlementState'),source.indexOf('export function settlementTurn'))+'\n'+source.slice(source.indexOf('export function projectDisplayRuntimeState'))
const names=['projectChatSessionState','projectSessionMessage','projectDisplayRuntimeState','projectChatBackgroundConfig','projectSettlementCheckpoint','projectSceneImageState']
const projection=Function('copyJsonTree','copyLazyHistoryHeader',exact.replaceAll('export function ','function ')+';return {'+names.join(',')+'}')(copy.copyJsonTree,lazy.copyLazyHistoryHeader)
const calls={message:0,session:0,scene:0,copies:0,sql:[]}
const helpers={...projection,...json,...copy,...scoped,...lazy,
  projectSessionMessage:row=>{calls.message++;return projection.projectSessionMessage(row)},
  projectChatSessionState:(chat,options)=>{calls.session++;return projection.projectChatSessionState(chat,options)},
  projectSceneImageState:chat=>{calls.scene++;return projection.projectSceneImageState(chat)},
  copyJsonTree:value=>{calls.copies++;return copy.copyJsonTree(value)},
}
const reset=()=>{calls.message=0;calls.session=0;calls.scene=0;calls.copies=0;calls.sql=[]}
const root=mkdtempSync(path.join(os.tmpdir(),'tavern-projection-owned-'))
const stores=[]
const create=options=>{const store=createChatSqliteStore({dataRoot:root,helpers,...options});stores.push(store);return store}
const tree=index=>({stat_data:{index},schema:{type:'object'}})
const CHAT={id:'projection-fixture',sessionId:'projection-session',mode:'card',_storageRevision:1,
  updatedAt:123,cardContextRevision:3,backgroundConfigVersion:2,conversationFeaturesVersion:4,
  backgroundTasks:[{role:'背景'}],backgroundModelSelection:{model:'夹具'},sceneImagesEnabled:true,
  cardDefinitionSnapshot:{large:'无关头'.repeat(12000)},runtimeInputs:{2:{source:'输入'}},
  rollbackUndo:{ready:true,version:1,storageRevision:1,foreground:{afterCount:8},before:{payload:'回退正文'.repeat(10000)}},
  timeline:{schemaVersion:1,branchId:'branch-fixture',revision:1,participants:{background:{status:'active'}},operations:{op:{kind:'mvu',status:'prepared'}},checkpoints:[{payload:'历史头'.repeat(8000)}]},
  messages:Array.from({length:64},(_x,index)=>({role:index%2?'user':'assistant',turn:index+1,greeting:index===0,text:'正文'+index,swipes:['正文'+index,'替代'+index],swipeId:0,
    importSource:index===2?{}:null,mvu:index===6?{pending:true,pendingSubmission:{payload:'不要复制'},delivery:{prepared:{id:'准备'}}}:{},
    displayRuntime:{index,payload:'诊断'.repeat(4000)},variables:index%2?[]:[tree(index)],tavernPluginData:{body:'显示输入'+index}})),
}
let writer=create();const STORED=await writer.update(CHAT.id,()=>CHAT)
// 临时SQL探针只记录SELECT名称/返回行数，不打印聊天内容、不改变生产源码。
const prepare=DatabaseSync.prototype.prepare
DatabaseSync.prototype.prepare=function(sql){
  const statement=prepare.call(this,sql)
  return new Proxy(statement,{get(target,key){const member=Reflect.get(target,key);if(typeof member!=='function')return member;return (...args)=>{const result=member.apply(target,args);if(/^SELECT/i.test(sql))calls.sql.push({sql,rows:Array.isArray(result)?result.length:result==null?0:1});return result}}})
}
const noAssemble=()=>assert.equal(calls.sql.some(row=>/SELECT message_index, message_json FROM archive_messages ORDER/.test(row.sql)),false,'窄投影不得assemble全Chat')
const normalize=value=>copy.copyJsonTree(value)
try {
  test('scoped冷读：摘要等价、同版本不重复投影、访问才脱离，普通数组仍可克隆',async()=>{
    const store=create();const full=await writer.read(CHAT.id);reset()
    const state=await store.readSessionState(CHAT.id,{scoped:true})
    noAssemble();assert.equal(calls.message,64);assert.equal(calls.copies,0,'未读楼不调用楼层脱离')
    assert.equal(Array.isArray(state.messages),true);assert.equal(state.messages.length,64)
    assert.equal(state.pendingMvuSettlement.hasSubmission,true)
    const before=calls.copies;assert.deepEqual(state.messages[6],projection.projectSessionMessage(full.messages[6]));assert.equal(calls.copies,before+1)
    assert.equal(state.messages[6],state.messages[6],'同结果同楼稳定副本')
    const again=await store.readSessionState(CHAT.id,{scoped:true});assert.equal(calls.message,64,'同revision复用作者摘要结果')
    state.messages[6].mvu.pending=false;state.timeline.branchId='私有改动';assert.equal(again.messages[6].mvu.pending,true);assert.equal(again.timeline.branchId,CHAT.timeline.branchId)
    assert.throws(()=>state.messages.push({}),/membership/);assert.throws(()=>{delete state.messages[0]},/delete history/)
    assert.deepEqual(normalize(again),projection.projectChatSessionState(full))
    const plain=await store.readSessionState(CHAT.id);assert.deepEqual(structuredClone(plain),projection.projectChatSessionState(full))
    const count=calls.session;const plainAgain=await store.readSessionState(CHAT.id);assert.equal(calls.session,count,'默认普通数组投影同revision复用')
    plain.messages[0].role='私有';assert.equal(plainAgain.messages[0].role,'assistant')
  })
  test('冷窄读：背景不读消息、场景只读显示列、诊断只取目标载荷、checkpoint只取一楼',async()=>{
    const store=create();const full=await writer.read(CHAT.id);reset()
    assert.deepEqual(await store.readBackgroundConfig(CHAT.id),projection.projectChatBackgroundConfig(full));noAssemble()
    assert.equal(calls.sql.some(row=>row.sql.includes('archive_messages')),false,'背景配置不扫消息')
    assert.equal(calls.sql.some(row=>/SELECT key,.*archive_head_fields/.test(row.sql)),false,'窄头不读全头')
    reset();const scene=await store.readSceneImageState(CHAT.id);assert.deepEqual(scene,projection.projectSceneImageState(full));noAssemble()
    const previous=calls.scene;const sceneAgain=await store.readSceneImageState(CHAT.id);assert.equal(calls.scene,previous);scene.messages[0].text='私有';assert.notEqual(sceneAgain.messages[0].text,'私有')
    reset();assert.deepEqual(await store.readDisplayRuntimeState(CHAT.id,5),projection.projectDisplayRuntimeState(full,5));noAssemble()
    assert.equal(calls.sql.filter(row=>row.sql.includes("'$.displayRuntime'")).reduce((n,row)=>n+row.rows,0),1)
    reset();assert.deepEqual(await store.readSettlementCheckpoint(CHAT.id,4,'op'),projection.projectSettlementCheckpoint(STORED,4,'op'));noAssemble()
    assert.equal(calls.sql.filter(row=>row.sql.includes('message_json FROM archive_messages')).reduce((n,row)=>n+row.rows,0),1)
    assert.equal(await store.readSettlementCheckpoint(CHAT.id,-1,'op'),undefined)
  })
  test('增量：fields白名单、细粒度头/输入证据、懒脱离及dirty老楼变量不混版本',async()=>{
    const base=1
    await writer.patch(CHAT.id,base,[{op:'set',path:['_storageRevision'],value:2},{op:'set',path:['messages',4,'text'],value:'改楼'},
      {op:'set',path:['runtimeInputs','2','source'],value:'改输入'}])
    reset();const delta=await writer.readViewDelta(CHAT.id,base)
    assert.deepEqual(delta.indices,[4]);assert.equal(delta.layoutChanged,false);assert.equal(delta.layoutFrom,Infinity)
    assert.deepEqual(delta.changedHeaderFields,['_storageRevision','runtimeInputs']);assert.deepEqual(delta.runtimeInputChanges,[{key:'2',present:true,value:{source:'改输入'}}])
    assert.equal(calls.copies,2,'只脱离dirty老楼和变更runtime值，没有逐楼克隆')
    assert.throws(()=>delta.chat.messages.push({}),/membership/)
    assert.equal(Object.keys(delta.chat.messages).length,0,'构造时非dirty楼没有实体副本')
    const sliced=await writer.readChangedSlice(CHAT.id,base,['id','_storageRevision','timeline.branchId'])
    assert.deepEqual(Object.keys(sliced.chat).sort(),['_storageRevision','id','messages','timeline'].sort());assert.deepEqual(sliced.chat.timeline,{branchId:CHAT.timeline.branchId})
    assert.equal(sliced.chat.messages.length,1);assert.equal(sliced.messageCount,64);assert.equal(sliced.denseMessages,true)
    await writer.patch(CHAT.id,2,[{op:'set',path:['_storageRevision'],value:3},{op:'set',path:['messages',4,'variables'],value:[tree(999)]}])
    assert.deepEqual(delta.chat.messages[4].variables,[tree(4)],'dirty补数已钉住返回时SQL版本')
    assert.equal(delta.chat.messages[8].text,'正文8');assert.equal(Object.hasOwn(delta.chat.messages[8],'variables'),false)
    delta.chat.messages[8].text='私有';assert.notEqual((await writer.read(CHAT.id)).messages[8].text,'私有')
    assert.equal((await writer.readViewDelta(CHAT.id,1)).revision,3)
  })
  test('布局/输入删除/压缩帧证据与物理删尾：不伪造覆盖、旧scoped仍是旧版本',async()=>{
    const old=await writer.readSessionState(CHAT.id,{scoped:true})
    await writer.patch(CHAT.id,3,[{op:'set',path:['_storageRevision'],value:4},{op:'set',path:['messages',6,'role'],value:'user'},{op:'delete',path:['runtimeInputs','2']}])
    const changed=await writer.readViewDelta(CHAT.id,3);assert.equal(changed.layoutChanged,true);assert.equal(changed.layoutFrom,6)
    assert.deepEqual(changed.runtimeInputChanges,[{key:'2',present:false,value:undefined}])
    assert.equal(old.messages[6].role,'assistant');assert.equal((await writer.readSessionState(CHAT.id,{scoped:true})).messages[6].role,'user')
    await writer.patch(CHAT.id,4,[{op:'set',path:['_storageRevision'],value:5},{op:'splice',path:['messages'],index:60,deleteCount:4,items:[]}])
    assert.equal((await writer.readSessionState(CHAT.id,{scoped:true})).messages.length,60);assert.equal(old.messages.length,64)
    const tail=await writer.readViewDelta(CHAT.id,4);assert.equal(tail.layoutFrom,60);assert.deepEqual(tail.indices,[])
    assert.equal(await writer.readViewDelta(CHAT.id,5),undefined)
    for(let revision=5;revision<40;revision++)await writer.patch(CHAT.id,revision,[{op:'set',path:['_storageRevision'],value:revision+1},{op:'set',path:['runtimeInputs','k'+revision],value:{source:'值'}}])
    const merged=await writer.readViewDelta(CHAT.id,5);assert.equal(merged.layoutChanged,true,'压缩帧可能涵盖更早布局变动，只能保守多算不能假阴性');assert.ok(merged.runtimeInputChanges.length>=35)
    const cold=create();assert.equal(await cold.readViewDelta(CHAT.id,5),undefined,'丢失帧覆盖时消费者必须全读')
    const db=new DatabaseSync(path.join(root,'chats',CHAT.id,'archive.db'));try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM archive_messages WHERE message_index>=60').get().n,0)}finally{db.close()}
  })
  test('作者实际view reader＋Helper增量消费者：使用scoped不触发整档克隆，脏楼一处投影',async()=>{
    const id='projection-consumer';await writer.update(id,()=>({...CHAT,id}))
    const helperSource=readFileSync(path.join(author,'tavern-helper-context.js'),'utf8'),indexed=await load('indexed-array'),frozen=await load('freeze-json')
    // 正文模板写入分支不属本刀，保留真实Helper读取/增量段及真实索引依赖。
    const contextEnd=helperSource.indexOf('export function ',helperSource.indexOf('export function projectTavernHelperContext')+10)
    const helperBody=helperSource.slice(helperSource.indexOf('function tavernHelperRole'),contextEnd)
    const realHelper=Function('createIndexedArrayApi','createImmutableTurnFields','freezeJson',
      "const helperTurns=createImmutableTurnFields(),helperIndex=createIndexedArrayApi({valid:row=>Boolean(row && !row.stub)});"+helperSource.slice(helperSource.indexOf('function str('),helperSource.indexOf('function normalizeMessageId'))+'\n'+helperBody.replaceAll('export function ','function ')+'\n'+helperSource.slice(helperSource.indexOf('export function helperMessagesComplete')).replace('export function ','function ')+';return {projectTavernHelperContext,helperMessagesComplete}')(indexed.createIndexedArrayApi,frozen.createImmutableTurnFields,frozen.freezeJson)
    const readerSource=readFileSync(path.join(author,'session-view-reader.js'),'utf8')
    const factory=Function('helperMessagesComplete','completeTavernHelperContext','projectSceneImageState','projectChatBackgroundConfig',readerSource.replace(/^import .*$/gm,'').replaceAll('export function ','function ')+';return createSessionViewReader')(realHelper.helperMessagesComplete,realHelper.completeTavernHelperContext,projection.projectSceneImageState,projection.projectChatBackgroundConfig)
    const seen={full:0,dirty:0,cached:0},reader=factory({
      readState:()=>writer.readSessionState(id,{scoped:true}),readChat:()=>writer.read(id),readChanges:(_id,rev)=>writer.readChangedIndices(id,rev),readViewDelta:(_id,rev)=>writer.readViewDelta(id,rev),
      trace:{stage:(_key,run)=>run(),state:()=>{}},activity:()=>({busy:false}),foregroundRunning:()=>false,synchronize:()=>{},
      project:{
        full:chat=>{seen.full++;return {tavernHelper:realHelper.projectTavernHelperContext(chat,{indexed:true})}},
        cached:(_chat,view)=>{seen.cached++;return view},
        dirty:(chat,previous,indices,_activity,changes)=>{seen.dirty++;return {tavernHelper:realHelper.projectTavernHelperContext(chat,{previousMessages:previous.tavernHelper.messages,previousContext:previous.tavernHelper,indexed:true,dirtyIndices:indices,...changes})}},
      },
    })
    const first=await reader.read(CHAT.sessionId);assert.equal(first.tavernHelper.messages.length,64)
    reset();await reader.read(CHAT.sessionId);assert.deepEqual(seen,{full:1,dirty:0,cached:1});assert.equal(calls.copies,0,'视图缓存命中不脱离楼数组')
    await writer.patch(id,1,[{op:'set',path:['_storageRevision'],value:2},{op:'set',path:['messages',4,'text'],value:'消费者改写'},{op:'set',path:['messages',4,'swipes',0],value:'消费者改写'}])
    reset();const next=await reader.read(CHAT.sessionId);assert.deepEqual(seen,{full:1,dirty:1,cached:1});assert.equal(next.tavernHelper.messages[4].message,'消费者改写')
    assert.deepEqual(next.tavernHelper.messages[4].variables,tree(4));assert.equal(calls.copies,1,'实际Helper只访问dirty行，输入不遍历其余63楼')
    noAssemble()
  })
  test('缓存边界与变更保守证据：无缓存/跨连接/删除重建不出借旧结果',async()=>{
    const id='projection-cache-boundary';await writer.update(id,()=>({...CHAT,id,rollbackUndo:{},messages:CHAT.messages.slice(0,8)}))
    const noCache=create({cacheMaxBytes:0});reset();await noCache.readSessionState(id,{scoped:true});await noCache.readSessionState(id,{scoped:true});assert.equal(calls.message,16,'关闭缓存不积存派生结果')
    const store=create();const old=await store.readSessionState(id,{scoped:true})
    assert.deepEqual(await store.readDisplayRuntimeState(id,3),projection.projectDisplayRuntimeState({...CHAT,id,rollbackUndo:{},messages:CHAT.messages.slice(0,8)},3))
    await writer.patch(id,1,[{op:'set',path:['_storageRevision'],value:2},{op:'set',path:['runtimeInputs'],value:{3:{source:'整体替换'}}}])
    assert.equal((await writer.readViewDelta(id,1)).runtimeInputChanges,null,'整runtime替换不能伪造逐键证据')
    assert.equal((await store.readSessionState(id,{scoped:true}))._storageRevision,2,'别的连接提交不能命中旧revision缓存')
    const rebuiltId='projection-rebuilt',single=create();await single.update(rebuiltId,()=>({...CHAT,id:rebuiltId,messages:CHAT.messages.slice(0,8)}));const previous=await single.readSessionState(rebuiltId,{scoped:true})
    await single.remove(rebuiltId);await single.update(rebuiltId,()=>({...CHAT,id:rebuiltId,messages:[{role:'user',text:'重建',turn:1}]}))
    assert.equal((await single.readSessionState(rebuiltId,{scoped:true})).messages.length,1);assert.equal(previous.messages.length,8);assert.equal(old.messages.length,8)
    const shadow='projection-shadow';await writer.update(shadow,()=>({...CHAT,id:shadow,messages:[]}));writeFileSync(path.join(root,'chats',shadow+'.json'),JSON.stringify({...CHAT,id:shadow}),'utf8')
    reset();assert.equal((await writer.readSessionState(shadow,{scoped:true})).messages.length,64);assert.equal(calls.sql.length,0,'原件存在时同ID影子连接也不打开')
  })
  test('legacy原件优先、旧foreground完整路径、显式pending null和SQL字段边界',async()=>{
    const id='projection-legacy',legacy={...CHAT,id};const file=path.join(root,'chats',id+'.json');writeFileSync(file,JSON.stringify(legacy),'utf8');const before=readFileSync(file)
    assert.deepEqual(normalize(await writer.readSessionState(id,{scoped:true})),projection.projectChatSessionState(legacy));assert.deepEqual(readFileSync(file),before);assert.equal(existsSync(path.join(root,'chats',id,'archive.db')),false)
    const fullId='projection-old-body';const stored=await writer.update(fullId,()=>({...CHAT,id:fullId,pendingMvuSettlement:null,timeline:{...CHAT.timeline,operations:{body:{kind:'body',status:'foreground-completed'}}}}))
    assert.deepEqual(await writer.readSessionState(fullId,{scoped:true}),projection.projectChatSessionState(stored));assert.equal(await writer.readSettlementCheckpoint(fullId,4,'body'),undefined)
    const nullId='projection-null';await writer.update(nullId,()=>({...CHAT,id:nullId,pendingMvuSettlement:null}));assert.equal((await writer.readSessionState(nullId,{scoped:true})).pendingMvuSettlement,null)
    const page=await writer.readWindow(CHAT.id,{limit:1,fields:['id','timeline.branchId','.sessionId.','constructor.x','messages','backgroundTasks.0.role','_storageRevision.noSuchChild']});assert.equal(page.chat.sessionId,CHAT.sessionId);assert.equal(page.chat.backgroundTasks[0].role,'背景');assert.equal(Object.hasOwn(page.chat,'constructor'),false);assert.equal(Object.hasOwn(page.chat,'_storageRevision'),false)
  })
} finally {
  // node:test顶层test异步返回Promise；清理由after管理，避免尚在运行时拆SQL库。
  test.after(()=>{DatabaseSync.prototype.prepare=prepare;for(const store of stores)store.dispose();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));rmSync(root,{recursive:true,force:true})})
}
