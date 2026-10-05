const MARKER='// [dsh-tavern-shared-branch-fence:v1]'
function once(source,old,next){if(source.split(old).length!==2)throw Error('共享分支屏障锚点缺失/不唯一：'+old);return source.replace(old,next)}
export function applyRollbackSharedBranchTurnTransform(source){
 const marker='// [dsh-tavern-shared-branch-before-template:v1]'
 if(source.includes(marker))return source
 let next=marker+'\n'+source
 next=once(next,'        const projected = await options.projectUserTemplate({chat,card,turn,text:runtimeUserText})',`        // 首轮body.begin新分支先提交archive；副库只接受已登记分支，模板失败保完整失败轮基准。
        await savePreparation({source:'foreground.branch-before-template'})
        const projected = await options.projectUserTemplate({chat,card,turn,text:runtimeUserText})`)
 return once(next,'        const projected = await options.projectUserTemplate({chat,card:await store.readCard(cardPathOf(chat), chat),turn,text:userText})',`        await store.writeChat(chat)
        const projected = await options.projectUserTemplate({chat,card:await store.readCard(cardPathOf(chat), chat),turn,text:userText})`)
}
export function applyRollbackSharedBranchHostTransform(source){
 if(source.includes(MARKER))return source
 let next=MARKER+'\n'+source
 next=once(next,'      await promptTemplateGlobalVariables.save(result.scopes.global, global, { chatId: chat.id, turn })','      await promptTemplateGlobalVariables.save(result.scopes.global, global, { chatId: chat.id, turn, branchId:chat.timeline?.branchId })')
 next=once(next,'          await promptTemplateGlobalVariables.save(compiled.promptTemplateState.scopes.global, undefined, { chatId: input.chat.id, turn: Number(input.turn) })','          await promptTemplateGlobalVariables.save(compiled.promptTemplateState.scopes.global, undefined, { chatId: input.chat.id, turn: Number(input.turn), branchId:input.chat.timeline?.branchId })')
 const anchor='  const chatJournalStore = createChatSqliteStore({ dataRoot, legacyData: profileData, legacyStore: authorChatStore, now: Date.now, logger: console })'
 return once(next,anchor,anchor+`\n  // 只解析调用者确切chat，SQL提交前校验archive当前分支；回退完成后仍拒旧任务53。
  const rollbackSharedArchive=id=>chatJournalStore.rollbackArchivePath(id)
  for(const store of [promptTemplateGlobalVariables,tavernExtensionSettings,characterVariableStore,rollbackWorldbookResources,rollbackWorldbookBindings])store.bindArchiveResolver(rollbackSharedArchive)`)
}
