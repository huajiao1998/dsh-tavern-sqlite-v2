// ⚠ 部署件：整份写入作者树 <tavern-plugin>/lib/domain/mvu/mvu-update-core.js
//
// 该文件**本来就是我们写的**（作者主线 origin/main 里没有）⇒ 实现收回我们包
//（`lib/mvu/mvu-update-core.js`，44.6 KB，含同目录 6 个兄弟模块）。
// 作者树 `tavern-script-host-adapter.js:26` 用 **namespace 导入**（`import * as mvuUpdateCore`）⇒ `export *` 静态转出。
//
// ⚠⚠ **部署前置（A3）**：本文件（及其兄弟 mvu-parse-string）依赖 4 个裸依赖 ——
//   lodash / yaml / json5 / jsonrepair —— 已写进我们 `package.json` 的 `dependencies`。
//   **必须先让标准安装流程把依赖装进 profile（pnpm install / `dsh plugin --profile tavern add`），
//   再应用本垫片**；否则本垫片会让酒馆在导入期直接失败（静态 export 无降级）。
export * from 'dsh-tavern-sqlite-v2/mvu-update-core'