# expose-chats 缝（部署件）—— 把酒馆的聊天存储接口暴露成服务

## 为什么需要

host 侧的 `/tavern-save` 命令要读/写**酒馆的**聊天存储（判断存档格式、执行迁移）。
但 `chats` 是作者在 `index.js` 里内联构造并内部持有的，**不是服务**（全 `index.js` 只有 `tavernSessionSignals` 一个 provide）。
⇒ 我们**不**另建第二个 store 实例（连同一个 SQLite 文件会各带一份内存缓存、写入串行化也不共享）⇒ **必须用作者那一个**。

## 缝（一行）

在 `lib/index.js` 里 `createChatPersistence({ store: chatJournalStore, … })` **之后**加：

```js
  // [dsh-tavern-storage] 把聊天存储接口暴露给我们的插件（/tavern-save 命令与迁移面板要用）
  //   注：index.js 本来就是我们的整文件基线；这一行是"取作者那一个实例"的必要缝。
  ctx.provide('tavernChats', chatPersistence)
```

（`chatPersistence` 是作者那条线的现成变量名；若上游改名，用紧邻的 `createChatPersistence(` 调用点定位。）

## 验证

1. `dsh --profile tavern --dump-config | grep -n tavernChats` —— 确认 provider 在位；
2. 起服后执行命令：`/tavern-save status` → 期望回一行「已使用数据库存档」或「本局使用旧格式…」；
   `/tavern-save migrate` → 迁移后**再跑一次 status**，应变成「已使用数据库存档」（幂等）；
3. 页面实测：输入区上方的面板应显示同一行文案，按钮可点（未接线时会明确显示原因与所需缝）。