// ⚠ 部署件：把本文件内容**整份写入**作者树 <tavern-plugin>/lib/domain/mvu/mvu-card-runtime.js
//
// 该文件**本来就是我们写的**（作者主线 origin/main 里没有它）⇒ 现将实现收回我们包（`lib/mvu/mvu-card-runtime.js`），
// 作者树只留这层转出；顺带把 ⑮c（活动感知异步钩子预算，改用我们包的 `hookBudget`）一并做进包内版本。
//
// 公开面（作者树 `tavern-script-host-adapter.js:28` 要的 2 个 + 本文件全部 4 个导出）：
//   createCardScriptRuntime / getOrCreateRuntime / disposeRuntime / disposeAll
// 说明：这里用**静态 re-export**（而非动态 + 缺包降级）—— 本插件已是酒馆的硬依赖（会话后端与聊天存档都在包里），
//       因此"缺包即导入失败"是诚实的行为，不需要假装能降级。
export { createCardScriptRuntime, getOrCreateRuntime, disposeRuntime, disposeAll } from 'dsh-tavern-sqlite-v2/mvu-card-runtime'