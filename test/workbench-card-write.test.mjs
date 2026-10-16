// 工作台改卡复审：执行真实施缝updateCard/restoreCurrentCard与原版file-resources，不调模型或现场。
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync,mkdirSync,readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import {prepareCommentAuthorTree,commentAuthorTreeSource} from './fixtures/comment-author-tree.mjs'
import {buildCore} from '../deploy/standard-seam-transforms.mjs'
import {applyRollbackWorldbookHostTransform} from '../deploy/rollback-worldbook-transform.mjs'
import {createRollbackCharacterVariables} from '../lib/rollback-character-variables.js'
import {createRollbackWorldbookResources} from '../lib/rollback-worldbook-resources.js'
import {createRollbackWorldbookBindings} from '../lib/rollback-worldbook-bindings.js'
const DOMAIN='tavern-plugin/lib/domain/'
const author=path.join(commentAuthorTreeSource(),DOMAIN)
const {createCardPreparation}=await import(pathToFileURL(path.join(author,'card-preparation.js')).href)
function fn(source,name,next,args,values){const from=source.indexOf('  async function '+name+'('),to=source.indexOf('  async function '+next+'(',from);assert.ok(from>=0&&to>from);return new Function(...args,source.slice(from,to)+';return '+name)(...values)}

test('工作台改卡复审：原版saveChanges混合字段变量世界书立即生效，重复施缝与SQL原版恢复正常',async()=>{
 const tree=prepareCommentAuthorTree(),root=mkdtempSync(path.join(os.tmpdir(),'workbench-card-write-'))
 const characters=createRollbackCharacterVariables({dataRoot:root}),books=createRollbackWorldbookResources({dataRoot:root}),bindings=createRollbackWorldbookBindings({dataRoot:root,profileData:{readJson:async()=>undefined,remove:async()=>{}}})
 try{
  const core=buildCore(tree.appDir,tree.original),host=core.get('tavern-plugin/lib/index.js')
  assert.equal(applyRollbackWorldbookHostTransform(host),host,'新card-edit:v2必须可重复应用')
  const resourceSource=core.get(DOMAIN+'file-resources.js').replace(/from '([.][^']+)'/g,(_all,spec)=>'from '+JSON.stringify(pathToFileURL(path.resolve(author,spec)).href))
  const modulePath=path.join(root,'file-resources.mjs');writeFileSync(modulePath,resourceSource,'utf8')
  const {createFileResourceStore,normalizeResourcePath}=await import(pathToFileURL(modulePath).href)
  const resources=createFileResourceStore({dataRoot:root,characterVariables:characters,worldbookResources:()=>books,rollbackBindings:bindings})
  await resources.ensure()
  const preparation=createCardPreparation({id:()=> 'synthetic',now:()=>99}),cardPath='cards/fixture.json'
  const raw={spec:'chara_card_v3',data:{name:'原卡',description:'原描述',extensions:{tavern_helper:{variables:{hp:1}}},character_book:{entries:[{id:0,content:'原书'}]}}}
  const original=preparation.create({kind:'import',payload:{kind:'text',name:'fixture.json',text:JSON.stringify(raw)}})
  await resources.writeWorking(cardPath,JSON.stringify(original))
  const originalFile=path.join(root,'originals','cards','fixture.json');mkdirSync(path.dirname(originalFile),{recursive:true});writeFileSync(originalFile,JSON.stringify(raw),'utf8')
  const start=host.indexOf('  async function projectCharacterVariables('),end=host.indexOf('\n  }',start)+4
  const project=new Function('characterVariableStore','rollbackWorldbookResources','normalizeResourcePath',host.slice(start,end)+';return projectCharacterVariables')(characters,books,normalizeResourcePath)
  const read=async()=>project(cardPath,JSON.parse(await resources.readText(cardPath)))
  let bumps=0
  const update=fn(host,'updateCard','replaceCardVariables',['rollbackCardEqual','readCardWorkspace','cardPreparation','characterVariableStore','rollbackWorldbookResources','normalizeResourcePath','fileResources','bumpCardProjectionRevision','syncCardName'],[isDeepStrictEqual,read,preparation,characters,books,normalizeResourcePath,resources,async()=>{bumps++},async()=>{}])
  const turn=core.get(DOMAIN+'turn-orchestration.js').replace(/^import .*$/gm,'').replace(/^export /gm,'')
  const {hasTavernCredit,withTavernCredit}=await import(pathToFileURL(path.join(author,'card-credit.js')).href)
  const {createTurnOrchestrator}=new Function('hasTavernCredit','withTavernCredit',turn+';return {createTurnOrchestrator}')(hasTavernCredit,withTavernCredit)
  const chat={id:'workbench',sessionId:'card-session',mode:'card',cardPath,cardName:'原卡',messages:[],rollbackPending:{turn:1},timeline:{operations:{old:{kind:'body',turn:1,status:'running'}}}}
  const turns=createTurnOrchestrator({store:{chatForSession:async()=>structuredClone(chat),updateCard:update,writeChat:async()=>{}},frameBuilder:{build:()=>{throw Error('工作台不用游玩frame')}}})
  const result=await turns.saveChanges({sessionId:chat.sessionId,turn:2,fields:{name:'改名'},rawOperations:[{op:'set',path:'/data/extensions/tavern_helper/variables/hp',value:9}]})
  assert.equal(result.saved,true);assert.equal((await characters.read(cardPath)).hp,9);assert.equal((await read()).raw.data.name,'改名')
  await update(cardPath,{name:'定义与书同改',character_book:{entries:[{id:2,content:'新书'}]}},{ts:100,summary:'原版修订'},[{op:'set',path:'/data/extensions/tavern_helper/variables/hp',value:10}])
  const current=await read();assert.equal(current.raw.data.name,'定义与书同改');assert.equal(current.raw.data.extensions.tavern_helper.variables.hp,10);assert.equal(current.raw.data.character_book.entries[0].content,'新书')
  const definition=JSON.parse(readFileSync(path.join(root,'resources','cards','fixture.json'),'utf8'))
  assert.equal(definition.raw.data.extensions.tavern_helper.variables,undefined);assert.deepEqual(definition.raw.data.character_book,{entries:[]},'SQL仍是变量/书的唯一权威')
  const restore=fn(host,'restoreCurrentCard','deleteCard',['chatForSession','str','fileResources','cardPreparation','normalizeResourcePath','characterVariableStore','rollbackWorldbookResources','bumpCardProjectionRevision','syncCardName'],[async()=>chat,String,resources,preparation,normalizeResourcePath,characters,books,async()=>{bumps++},async()=>{}])
  const restored=await restore(chat.sessionId);assert.equal(restored.name,'原卡')
  assert.deepEqual(await characters.read(cardPath),{hp:1});assert.equal((await books.read({kind:'card',cardPath})).entries[0].content,'原书')
  assert.equal((await read()).raw.data.name,'原卡');assert.ok(bumps>0)
  const empty=structuredClone(raw);delete empty.data.extensions.tavern_helper.variables;delete empty.data.character_book
  writeFileSync(originalFile,JSON.stringify(empty),'utf8');await restore(chat.sessionId)
  assert.deepEqual(await characters.read(cardPath),{});assert.equal(await books.read({kind:'card',cardPath}),null,'恢复原版缺书时明确删除SQL书，不让旧值复活')
  const {assertRollbackChatWritable}=await import('../lib/rollback-barrier.js')
  let index={chats:[{id:'legacy',cardPath},{id:'play',cardPath}]},saved=[]
  const sync=fn(host,'syncCardName','restoreCurrentCard',['readIndex','writeIndex','legacyViewSeams','readChat','writeChat'],[async()=>index,async value=>{index=value},{readOnlyChat:id=>id==='legacy'},async id=>{assert.notEqual(id,'legacy');return {id,mode:'story',cardName:'旧名',rollbackPending:{turn:1}}},async(value,metadata)=>{assertRollbackChatWritable(value,metadata);saved.push(value)}])
  await sync(cardPath,'工作台改名');assert.equal(saved.length,1);assert.equal(saved[0].cardName,'工作台改名')
 }finally{await characters.dispose();await books.dispose();await bindings.dispose();tree.cleanup();rmSync(root,{recursive:true,force:true})}
})

test('工作台改卡复审：SQL直接编辑不用初始化或读取前态，游玩归属写仍隔离过期结果',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'workbench-editor-rights-')),characters=createRollbackCharacterVariables({dataRoot:root}),books=createRollbackWorldbookResources({dataRoot:root}),bindings=createRollbackWorldbookBindings({dataRoot:root,profileData:{readJson:async()=>undefined,remove:async()=>{}}})
 try{
  const card='cards/任意卡.json',source={kind:'card',cardPath:card},owner={chatId:'play',turn:1}
  await characters.save(card,{hp:1});await characters.save(card,{hp:7},undefined,{hp:999});assert.deepEqual(await characters.read(card),{hp:7})
  await books.save(source,{entries:[{id:1,content:'工作台新书'}]});await books.save(source,null,{entries:[{id:0,content:'过期前态'}]});assert.equal(await books.read(source),null)
  await books.save(source,{entries:[]},undefined);assert.deepEqual(await books.read(source),{entries:[]})
  await assert.rejects(books.save(source,null,null,owner),/完整读取前态/,'游玩任务仍不得按过期前态覆盖')
  await assert.rejects(characters.save(card,{hp:8},owner,{hp:999}),/已被其他对话修改/)
  await bindings.save({[card]:{kind:'embedded',cardPath:card}});assert.equal((await bindings.read())[card].kind,'embedded')
 }finally{await characters.dispose();await books.dispose();await bindings.dispose();rmSync(root,{recursive:true,force:true})}
})
