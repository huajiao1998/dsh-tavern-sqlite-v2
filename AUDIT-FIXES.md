# 0.4.12 存储审查修复与验证

基线：f40b973e6f43dcc5d6ebde732a97c5eb91037733（已合并 PR #17）。验证环境：Windows / Node.js v24.15.0，2026-10-15。

## 修复范围

|编号|触发与结果|修复|
|---|---|---|
|B10 补充|窄命令 headerSets 改写 id 后，档案冷读失败|将 id 纳入追加/单楼命令的保留头字段，写前拒绝|
|B12|最新楼变 helper 或未结算槽，当前变量仍保留旧树|全量与局部写共享候选复核，按新角色和选中槽回拨；无合格树清空状态；新激活冷楼也能恢复为当前树|
|B13|单楼 SQL 事务失败，snapshotAt 暴露未提交树|单楼命令异常时清理该档变量缓存和写入追踪|
|B14|单楼 changes 的对象 set 被改成深合并，旧字段残留；null→对象报错|保留 changes 的 set/delete 边界与顺序，兼容原内部 patch 入口；继续拒绝毒键、缺父路径和 splice|
|B15|修改 K4 冷楼 turn，快照仍属于旧 turn|无行内 variables 时同步现有快照的 turn 与 selected，覆盖 patch 和单楼命令|

B11 已随 PR #17 合并，本次继续保留其缓存隔离及回归测试。B01、B02–B06、B08、B09 采用作者现有修复，不重复修改。B07 采用新版 rowid 排序契约。

## 追加修复 B16–B19

- B16：单楼命令与 patch 的显式 variables 删除意图传入归档层，同事务清理快照；普通 K4 缺字段保持原语义，删除后重新赋值以最终数组为准。
- B17：局部修剪不再 hydrate 已归档冷楼，避免把不变历史树重新序列化、upsert 并重写消息。仍有历史原始行扫描，不宣称恒定时间。
- B18：缺少 variable_state 时仅从幸存快照推导，不从已被 deleteFrom 清空的消息热树复活当前态。
- B19：snapshotAt 使用 turn 索引查询及完整候选排序，避免部分热缓存抢先返回更早楼。代价是每次历史读取执行一次索引查询。

追加 9 项回归覆盖冷/热楼、patch/单楼删除、删除后赋值、删除事务失败、消息写入计数、全部快照清空及同轮多楼冷热一致性。B16–B19 的四个复现均在改动前已确认失败。

## 回归验证

新增 test/audit-store-regressions.test.mjs：22 项自含合成测试。最初的 11 项在本 PR 前序提交 da91ca0 上全部失败，修复后通过；另补充冷楼重新激活、旧 patch 入口和空 JSON 键的兼容覆盖。

下面 10 个测试文件合计 **57 tests / 57 pass / 0 fail**：

```shell
node --experimental-vm-modules --test test/audit-store-regressions.test.mjs test/audit-regressions.test.mjs test/variable-snapshot-cache.test.mjs test/variable-archive.test.mjs test/variable-query-sqlite-compat.test.mjs test/esm-module-loader.test.mjs test/db-save-identities.test.mjs test/db-save-exchange.test.mjs test/worldbook-recall-store.test.mjs test/worldbook-recall-sql-read.test.mjs
```

作者原有 test/audit-storage-fixes.test.mjs 另 **10 pass / 0 fail**，包含局部截断、物理回退、保留未触碰热项、helper 冷树回拨、稀疏分页和当前态回收。因此本轮 67 项定向测试通过。该文件硬编码将合成夹具写到仓库外 tmp/gate-fixtures-audit-storage，本机授予该定向测试写入权限后执行；未改其测试源码。

git diff --check 与三个修改源码文件的 node --check 均通过。

## 验证边界

- 测试只使用合成 SQLite 数据；新增 store 测试注入简化的 update 差量/set/delete helper 与不参与断言的投影替身。它验证真实 store/命令/变量归档/SQL 行为，不代表完整宿主装配。
- 作者 issue15-boundaries.test.mjs 的三项存储测试依赖仓库外 copy-json-tree.js；此前复验因缺夹具失败。其他 native-message/已知写集宿主测试也依赖外部源码，本轮未据此宣称全量通过。
- 变量查询兼容测试的历史召回扩展段仍因缺冻结源码未执行。未进行真实 UI/E2E、安装部署或玩家存档迁移。
- 大包测试为 1/4/8 MiB 合成容器进入 schema 检查，不等同完整大存档玩法验收；原有合成完整 DB 交换往返测试通过。

本 PR 仅修改存储源码、回归测试及本说明，不改变包版本或安装器。没有自动修复此前已被错误写入的玩家数据。

## PR 后续：B21–B23（基于 6c341eef，2026-10-15）

- B21：snapshotAt 与 snapshotAll 在同楼多个非选中变量树的排序平局时使用一致的 swipe_id 次序。保持既有非选中树回退语义，不将缺失选中槽改成空结果。
- B22：patch 中间 splice 前只补齐受影响后缀，在同一事务内清理旧索引快照并按新楼序归档。覆盖删除、插入无变量行、多次 splice、删尾与失败回滚；避免变量错配持久化。
- B23：单楼/追加窄命令记录撤销前像时，写入前按需补齐被改旧楼的变量。显式删除冷楼变量即使原始行 JSON 看起来不变也记录前像；同轮重复修改保留最初前像。普通未归属写入不增加撤销记录。

新增 19 项测试；test/audit-store-regressions.test.mjs 合计 41 项。B23 覆盖冷热楼的替换、删除、重复修改、无归属写入、事务失败，以及恢复保存后重新打开数据库。

本次定向验证：前述 10 文件加 rollback-owned-runtime-writes.test.mjs 与 rollback-worldbook-history.test.mjs，共 88/88 通过；audit-storage-fixes.test.mjs 另 10/10 通过，总计 98 项。git diff --check 通过。

边界：B23 此次修复和验证的是 recordCommandUndo 窄命令链，不宣称通用 patch/update 的所有撤销路径均已验证。B20 冷楼变量子路径修改失败，以及 B18 deleteFrom 后再编辑文字使旧树重新归档的问题仍未修复。不自动恢复此前已错配或缺失的玩家数据。未运行完整宿主 UI/E2E。
