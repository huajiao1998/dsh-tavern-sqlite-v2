import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import {createRollbackCharacterVariables} from '../lib/rollback-character-variables.js'
import {createRollbackWorldbookResources} from '../lib/rollback-worldbook-resources.js'
import {createCardPreparation} from '../../../tools/live-plugin-src/lib/domain/card-preparation.js'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
import {applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackCharacterHostTransform} from '../deploy/rollback-character-transform.mjs'
import {applyRollbackWorldbookHostTransform} from '../deploy/rollback-worldbook-transform.mjs'
test('实际卡编辑单SQL不写文件，混合与修订跨存储删前拒绝，定义文件故障不改两副库',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'card-single-store-')),characters=createRollbackCharacterVariables({dataRoot:root}),books=createRollbackWorldbookResources({dataRoot:root})
 try{
  const source=readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8'),host=applyRollbackWorldbookHostTransform(applyRollbackCharacterHostTransform(applyRollbackGlobalHostTransform(applyRollbackHostTransform(source))))
  const preparation=createCardPreparation({id:()=> 'fixture',now:()=> 99}),cardPath='cards/fixture.json'
  const workspace={kind:'dsh-tavern-character-workspace',version:1,raw:{spec:'chara_card_v3',data:{name:'fixture',extensions:{tavern_helper:{variables:{hp:52}}},character_book:{entries:[{id:0,content:'52'}]}}},meta:{}}
  const projectStart=host.indexOf('  async function projectCharacterVariables'),projectEnd=host.indexOf('  const fileResources',projectStart)
  const project=new Function('characterVariableStore','rollbackWorldbookResources','normalizeResourcePath',host.slice(projectStart,projectEnd)+';return projectCharacterVariables')(characters,books,value=>value)
  await project(cardPath,workspace)
  const revStart=host.indexOf('  async function cardProjectionRevision('),revEnd=host.indexOf('  async function bumpCardProjectionRevision(',revStart)
  const revision=new Function('readJson','CARD_PROJECTION_REVISIONS','str','characterVariableStore','rollbackWorldbookResources',host.slice(revStart,revEnd)+';return cardProjectionRevision')(async()=>({cards:{}}),'unused',String,characters,books)
  const initialRevision=await revision(cardPath)
  const editStart=host.indexOf('  async function updateCard('),editEnd=host.indexOf('  async function replaceCardVariables(',editStart)
  let writes=0,bumps=0,fail=true,stored=workspace
  const edit=new Function('rollbackCardEqual','readCardWorkspace','cardPreparation','characterVariableStore','rollbackWorldbookResources','normalizeResourcePath','fileResources','bumpCardProjectionRevision','syncCardName',host.slice(editStart,editEnd)+';return updateCard')(isDeepStrictEqual,async()=>project(cardPath,stored),preparation,characters,books,value=>value,{writeWorking:async(_path,text)=>{writes++;if(fail)throw Error('原创定义文件故障');stored=JSON.parse(text)}},async()=>{bumps++},async()=>{})
  await edit(cardPath,{},undefined,[{op:'set',path:'/data/extensions/tavern_helper/variables/hp',value:53}]);assert.equal(await characters.read(cardPath).then(v=>v.hp),53);assert.equal(writes,0);assert.equal(bumps,0)
  const variablesRevision=await revision(cardPath);assert.ok(variablesRevision>initialRevision);await edit(cardPath,{character_book:null});assert.equal(await books.read({kind:'card',cardPath}),null);assert.equal(writes,0);assert.ok(await revision(cardPath)>variablesRevision)
  const variableVersion=await characters.version(),bookVersion=await books.version()
  await assert.rejects(edit(cardPath,{name:'混合',character_book:{entries:[]}}),/混合跨存储/)
  await assert.rejects(edit(cardPath,{character_book:{entries:[]}},undefined,[{op:'set',path:'/data/extensions/tavern_helper/variables/hp',value:99}]),/混合跨存储/)
  await assert.rejects(edit(cardPath,{character_book:{entries:[]}},{note:'跨文件修订'}),/混合跨存储/)
  assert.equal(await characters.version(),variableVersion);assert.equal(await books.version(),bookVersion);assert.equal(writes,0)
  await assert.rejects(edit(cardPath,{name:'只改名'}),/原创定义文件故障/);assert.equal(await characters.version(),variableVersion);assert.equal(await books.version(),bookVersion)
  fail=false;await edit(cardPath,{name:'只改名'});assert.equal(stored.raw.data.name,'只改名');assert.equal(stored.raw.data.extensions.tavern_helper.variables,undefined);assert.equal(stored.raw.data.character_book,null);assert.equal((await project(cardPath,stored)).raw.data.extensions.tavern_helper.variables.hp,53)
  await books.save({kind:'card',cardPath},{entries:[{id:0,content:'新书SQL'}]},null);fail=false;await edit(cardPath,{name:'再改名'});assert.deepEqual(stored.raw.data.character_book,{entries:[]});assert.equal((await project(cardPath,stored)).raw.data.character_book.entries[0].content,'新书SQL')
  const beforeVariables=await characters.read(cardPath),beforeBook=await books.read({kind:'card',cardPath}),versions=[await characters.version(),await books.version()],writeCount=writes
  await assert.rejects(edit(cardPath,{},undefined,[{op:'set',path:'/data/extensions/tavern_helper/variables/hp',value:55},{op:'set',path:'/data/description',value:'混合定义'}]),/混合跨存储/);assert.deepEqual(await characters.read(cardPath),beforeVariables);assert.deepEqual(await books.read({kind:'card',cardPath}),beforeBook);assert.deepEqual([await characters.version(),await books.version()],versions);assert.equal(writes,writeCount)
  const savedBook=books.save;let fault=true
  books.save=async(...args)=>{const result=await savedBook(...args);if(fault){fault=false;throw Error('原创单SQL提交后回包故障')}return result}
  await assert.rejects(edit(cardPath,{character_book:{entries:[{id:0,content:'提交后重试'}]}}),/单SQL提交后回包故障/);const commitVersion=await books.version();await edit(cardPath,{character_book:{entries:[{id:0,content:'提交后重试'}]}});assert.equal(await books.version(),commitVersion);assert.equal(writes,writeCount);assert.equal((await project(cardPath,stored)).raw.data.character_book.entries[0].content,'提交后重试')
  // 定义编辑不覆盖SQL共享变量/书；剧情回退不拥有这些当前值。
  books.save=savedBook;const baselineBook=await books.read({kind:'card',cardPath}),baselineVariables=await characters.read(cardPath)
  await books.save({kind:'card',cardPath},{entries:[{id:0,content:'旧53'}]},baselineBook,{chatId:'fixture',turn:53});await characters.save(cardPath,{hp:530}, {chatId:'fixture',turn:53},baselineVariables)
  await edit(cardPath,{name:'仅改名不播53'});assert.deepEqual(stored.raw.data.character_book,{entries:[]});assert.equal(stored.raw.data.extensions.tavern_helper.variables,undefined)
  assert.equal(books.pruneRollback,undefined);assert.equal(characters.pruneRollback,undefined);assert.deepEqual((await project(cardPath,stored)).raw.data.character_book,{entries:[{id:0,content:'旧53'}]});assert.deepEqual((await project(cardPath,stored)).raw.data.extensions.tavern_helper.variables,{hp:530})
 }finally{await characters.dispose();await books.dispose();rmSync(root,{recursive:true,force:true})}
})
