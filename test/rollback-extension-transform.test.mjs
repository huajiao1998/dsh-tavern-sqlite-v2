import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {createRollbackExtensionSettings} from '../lib/rollback-extension-settings.js'
import {applyRollbackGlobalAdapterTransform,applyRollbackGlobalHostTransform} from '../deploy/rollback-global-transform.mjs'
import {applyRollbackHostTransform} from '../deploy/rollback-host-transform.mjs'
test('实际设置写口不挂正文归属，独立SQL编辑保留且不进入剧情撤销',async()=>{
 const adapter=readFileSync(new URL('../../../tmp/plg-standard-1001-code/b/lib/domain/tavern-script-host-adapter.js',import.meta.url),'utf8')
 const updated=applyRollbackGlobalAdapterTransform(adapter)
 const root=mkdtempSync(path.join(os.tmpdir(),'settings-independent-')),sql=createRollbackExtensionSettings({dataRoot:root,profileData:{readJson:async()=>undefined,remove:async()=>{}}})
 try{
  await sql.save({EjsTemplate:{n:52}},{});const saves=[]
  const begin=updated.indexOf('  async function saveFullPromptTemplateSettings('),end=updated.indexOf('  // Common variable/display writes',begin)
  const consumer=new Function('options','assertTemplateChat','resourcePermissionChat','assertPluginJson',updated.slice(begin,end)+';return {saveFullPromptTemplateSettings}')({fullExtensionSettings:{read:sql.read,save:async(...args)=>{saves.push(args);return sql.save(...args)}}},()=>{},async()=>({id:'fixture',sessionId:'s'}),()=>{})
  await consumer.saveFullPromptTemplateSettings('s',{n:99},{n:52})
  assert.deepEqual(saves,[[{EjsTemplate:{n:99}},{EjsTemplate:{n:52}}]])
  const db=new DatabaseSync(path.join(root,'tavern-extension-settings.db'));try{assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='global_undo'").get().n,0)}finally{db.close()}
  const host=applyRollbackGlobalHostTransform(applyRollbackHostTransform(readFileSync(new URL('../../../tmp/rollback-compare-1001/current-index.js',import.meta.url),'utf8')))
  assert.ok(host.includes('fullExtensionSettings: tavernExtensionSettings'));assert.ok(host.includes('tavernExtensionSettings.version()'))
  assert.ok(!host.includes('tavernExtensionSettings.pruneRollback('));assert.ok(!host.includes('tavernExtensionSettings.reserveRollback('))
  assert.deepEqual(await sql.read(),{EjsTemplate:{n:99}})
  // 独立捕获旧代接缝，避免测试依赖已经删除的转换器；旧源码就地升级也不得残留撤销。
  let oldHost='// [dsh-tavern-rollback-extension:v1]\n'+host
  for(const method of ['pruneRollback','preflightRollback','reserveRollback','releaseRollback'])oldHost=oldHost.replace('      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)','      await tavernExtensionSettings.'+method+'(chat, turn'+(method==='releaseRollback'?', archive':'')+')\n      await worldbookRecallLog.pruneRollback(chat, turn, chat.timeline.branchId)')
  const upgradedHost=applyRollbackGlobalHostTransform(oldHost)
  for(const method of ['pruneRollback','preflightRollback','reserveRollback','releaseRollback'])assert.ok(!upgradedHost.includes('tavernExtensionSettings.'+method+'('))
  assert.equal(applyRollbackGlobalHostTransform(upgradedHost),upgradedHost)
  const oldAdapter='// [dsh-tavern-rollback-extension:v1]\n'+updated
   .replace('return saveGlobalPromptTemplateSettings(settings, expectedSettings)','return saveGlobalPromptTemplateSettings(settings, expectedSettings, rollbackGlobalOwner(settingsChat))')
   .replace('async function saveGlobalPromptTemplateSettings(settings, expectedSettings)','async function saveGlobalPromptTemplateSettings(settings, expectedSettings, owner)')
   .replace('options.fullExtensionSettings.save({ ...current, EjsTemplate: settings }, base)','options.fullExtensionSettings.save({ ...current, EjsTemplate: settings }, base, owner)')
   .replace('options.extensionSettings.save(settings, expectedSettings)','options.extensionSettings.save(settings, expectedSettings, rollbackGlobalOwner(extensionChat))')
  const upgraded=applyRollbackGlobalAdapterTransform(oldAdapter)
  assert.ok(!upgraded.includes('rollbackGlobalOwner(settingsChat)'));assert.ok(!upgraded.includes('rollbackGlobalOwner(extensionChat)'));assert.equal(applyRollbackGlobalAdapterTransform(upgraded),upgraded)
 }finally{await sql.dispose();rmSync(root,{recursive:true,force:true})}
})
