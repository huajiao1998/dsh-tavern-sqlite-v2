# chat-sqlite-store 缝（部署件）—— 把酒馆的聊天存档换成我们包里的行级 SQLite 实现

> ✅ **推荐用工具施缝，别手打**：`node <包>/deploy/apply-seams.mjs`（幂等 / 自动备份 / `node --check` /
> 失败回滚 / `--check` 只查不改 / `--uninstall` 恢复作者原样）。本文件记录**缝的内容与理由**，
> 工具按这里的口径实现；两者不一致时以工具为准（工具是唯一的执行路径）。

## 为什么需要（这是**存储本体**替换，不是辅助层）

会话/transcript 后端能靠 bundle 装配层接管（`sessionPersistence` 是服务）；但**聊天存档**
不是服务 —— 作者在 `index.js` 里内联构造 `createChatJournalStore(...)` 再包成
`createChatPersistence({ store })` ⇒ 要换成我们的实现，只能动作者树这一个装配点。

**红线**：这是**存储本体**，未安装本包时必须**响亮失败**（降级 = 存档写不进去，风险远大于报错）。

## 两步（缺一不可）

### 第一步：垫片

把 `deploy/chat-sqlite-store.shim.js` **整份写入**
`<tavern-plugin>/lib/domain/chat-sqlite-store.js`（作者上游**没有**这个文件 —— 行级 SQLite 存档
完全是我们加的，所以这是"新增 + 改装配"，不是"覆盖作者实现"）。

⚠ 垫片里**不能写裸说明符** `import('dsh-tavern-storage-sqlite-v2/chat-store')`：垫片在
`apps/dsh-tavern/tavern-plugin/lib/domain/` 下，而我们的包被 pnpm 装在
`<DSH_HOME>/profiles/tavern/node_modules/` —— **两棵不同的树**，裸解析必失败。
垫片已改为按 profile 锚点 `createRequire(...).resolve(...)`（2026-09-30 首次真机应用时踩中）。

### 第二步：装配（`lib/index.js`，三处）

```js
// ① 顶部导入
import { createChatSqliteStore } from './domain/chat-sqlite-store.js'

// ② 作者原存储**保留**：它是"上游块布局 / journal 单文件"的读源与维护者（我们只读它、不写它）
const authorChatStore = createChatJournalStore({ dataRoot, legacyData: profileData, now: Date.now, logger: console,
  backgroundSnapshots: true, newConversations: true, migrateLegacy: process.env.DSH_TAVERN_COMPATIBLE_STORAGE === '1' })
// ③ 我们的行级 SQLite store 叠在上面：写入走 archive.db，未迁移档的读取交给作者 store
const chatJournalStore = createChatSqliteStore({ dataRoot, legacyData: profileData, legacyStore: authorChatStore, now: Date.now, logger: console })
```
（`chatJournalStore` 这个变量名沿用作家的，后面 `createChatPersistence({ store: chatJournalStore })` 与
`flushMaintenance` 都不用改；维护那条 effect 指向 `authorChatStore`。）

## ⚠ `legacyStore` 为什么必须有（2026-09-30 用户当场纠正）

上游 v2.4 起，**新档一律是内容寻址块布局**：`chats/<id>/head.json` + `blocks/<xx>/<hash>.json`。
真实用户装完我们的插件后，手里的档**就是这个形态** —— 他们**不会**（也不该）先把档改成
journal 单文件。所以"迁移旧档"必须能**原样读块布局**：

| | 只实现 journal 单文件（先前） | 补上 `legacyStore`（现在） |
|---|---|---|
| `version()` | 认（统计 `chats/<id>.json`） | 认（两种承载都统计，回 `legacy:<size>:<mtimeNs>`） |
| `read()` 未迁移档 | ❌ 读不出来 ⇒ 迁移必然失败 | ✅ 交给作者 store 读块布局 |
| 用户体验 | "必须自己改存档"（不可接受） | 装上即可迁移 |

> 当时的错误做法：为了让面板出现"旧格式"，我**手工把块布局档转成了 journal 单文件** ——
> 那等于**改了被测物**，把"读不出块布局"这个真缺口掩盖成了假阳性。教训：
> **测试必须用真形态；让测试通过的正确姿势是改产品代码，不是改被测数据。**

## 验证

```bash
# 1) 装配在位
grep -n "createChatSqliteStore\|legacyStore" <tavern-plugin>/lib/index.js
# 2) 起服后（未打开档时）判定：应回 legacy:<size>:<mtimeNs>
#    ⇒ 面板「本局使用旧格式（可看不可玩）：legacy:…」+ 迁移按钮可点
# 3) 点迁移后再判定：应回 sqlite:gen:<n> ⇒ 面板「已使用数据库存档」（幂等）
#    并确认 chats/<id>/archive.db 出现、旧块布局目录**原样保留**
```
