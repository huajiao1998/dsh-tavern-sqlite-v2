# 公开 API 兼容与退役策略（V2）

本文件定义 `dsh-tavern-sqlite-v2` 公开导出面（`package.json` 的 `exports`）的兼容承诺与退役记录。
**2026-10-15 计算重构**：按用户明确授权，自有计算实现（MVU/卡脚本/Helper/VM/ESM）被彻底删除，
计算唯一由**上游服务端运行时**执行；随之删除 11 个计算专用导出，不留垫片、不留兼容分支、不留旧引擎回落。

## 1. 合同面与三类真实消费形态

`exports` 的 **46 个子路径**是唯一公开合同面。判断"有没有消费者"必须区分三种形态，**只做仓内 `import 'dsh-tavern-sqlite-v2/<subpath>'` 检索会漏**：

| 形态 | 例子 | 说明 |
|---|---|---|
| ① 包内相对 import | `chat-sqlite-store.js:8` → `./lib/variable-archive.js` | 生产链主力，不经 `exports` 子路径 |
| ② deploy 生成垫片 | `deploy/standard-seam-transforms.mjs` 写入作者树的 `storagePackage('<name>')` 垫片 | 在**目标作者树**里按包名解析导出，仓内看不到直接 import |
| ③ 宿主装配行 | `profiles/tavern/cordis.patch.yml` 持久行（`bootstrap/session-persistence.js`、`bootstrap/host-patch.js`、`bootstrap/standard-host.js`）+ 普通行 `plugin.js` | 由安装器写入，运行时由宿主 Loader 加载 |

## 2. 分类（46 键）

| 分类 | 数量 | 条目 |
|---|---|---|
| prod（仓内生产消费者/根入口/宿主装配） | 32 | 见 §6 全表 |
| deploy-only（仅 deploy 动态装配） | 11 | `./regeneration-adoption`、`./legacy-view-seams`、`./legacy-fork-records`、`./legacy-source-workspace`、`./budgets`、`./conversation-fork-point`、`./fork-history-markers`、`./chat-history-rescue`、`./current-variables`、`./compaction-warning`、`./upstream-compute` |
| test-only | 1 | `./variable-store` |
| infra（解析器基础设施） | 2 | `./package.json`、`./locale/*.json` |

## 3. 政策

1. **默认保留 exports**：本仓零引用 ≠ 无外部消费者；不因"仓内没人用"删除子路径或文件。
2. **deprecated 只做注记**：不改运行时行为、不改解析器、不改 `files`、不删文件、不改导出形状。
3. **退役三步**：先标注 → 停新增消费者 → **大版本**移除；移除前必须有大版本决定 + 外部证据。
4. **infra 永久保留**：`./package.json`、`./locale/*.json` 是解析器依赖，任何情况下不删。
5. **不复活生产死路径**：不得为了兼容旧 API 把已退役实现接回主流程。
6. 数据侧总则：存档与变量只有一个权威（SQLite 同库同事务）。外部集成**只经插件公开服务/命令面**，**不直接写库**、不自行打开数据库文件、不代做归档/回退副数据清理（会绕过 CAS、身份校验与派生清理）。

## 4. 2026-10-15 计算重构的删除记录（用户明确授权，非默认退役流程）

| 删除的导出 | 原文件 | 删除理由 |
|---|---|---|
| `./sandbox-policy` | `lib/sandbox-policy.js` | 自有沙箱策略层，随计算退役 |
| `./mvu-card-runtime` | `lib/mvu/mvu-card-runtime.js` | 自有进程内卡脚本运行时 |
| `./mvu-script-sandbox` | `lib/mvu/mvu-script-sandbox.js` | 旧签名兼容垫片 |
| `./mvu-update-core` | `lib/mvu/mvu-update-core.js` | 自有 MVU 变量核心 |
| `./card-script-dispatch-store` | `lib/card-script-dispatch-store.js` | 自有 JSON 分派标记存储 |
| `./server-execution` | `lib/server-execution.js` | 自有服务端执行器 |
| `./server-dependencies` | `lib/server-dependencies.js` | 自有解析器/依赖供给 |
| `./opening-server-init` | `lib/opening-server-init.js` | 自有开局初始化 |
| `./esm-module-loader` | `lib/mvu/esm-module-loader.js` | 自有 ESM 加载器 |
| `./tavern-helper-api` | `lib/tavern-helper-api.js` | 自有 Helper API 包装 |
| `./tavern-regex-api` | `lib/tavern-regex-api.js` | 自有正则 API 包装 |

同时删除：`lib/mvu/` 全目录（15 文件）、`lib/helper-generation-api.js`、`lib/helper-message-reader.js`、
`lib/helper-readonly-api.js`、`deploy/core-runtime-transform.mjs`、`deploy/helper-readonly-source.mjs`、
`deploy/mvu-card-runtime.shim.js`、`deploy/mvu-update-core.shim.js`，以及计算专用 vendor
`lib/vendor/lodash`、`lib/vendor/json5`、`lib/vendor/jsonrepair`。

**替代路径不是兼容层**：`./upstream-compute` 提供的是上游调用的**身份/屏障策略**
（`authorizeUpstreamCall` / `runUpstreamRequest` / `pageView` / `computationBlocked`），
不包含任何卡算法；算法由上游 `server-script-worker` 在其 jsdom 子进程内执行。

**失败语义**：服务端不可用时任务保留并明确失败/等待；**不转交页面、不切旧引擎**。
上游原有的页面优先、失败/容量回落与服务禁用开关已从策略中移除。

## 5. 已标注 deprecated 的保留项

| 导出/文件 | 注记位置 | 现役替代 | 迁移建议 |
|---|---|---|---|
| `./variable-store` | `variable-sqlite-store.js:14`（仓内仅测试消费者） | `createVariableArchive`（`lib/variable-archive.js`，由 `chat-sqlite-store.js` 构造，正文与变量同事务） | 读写变量走插件公开命令/服务面；**不直接写库** |
| `./rollback-head-prune` | `lib/rollback-head-prune.js:1` | `lib/clean-rollback.js` 主路径 | 回退走 `cleanRollback` 公开面；不要新增消费者 |

## 6. 全表（46 键 → 分类）

- `.`、`./session-persistence`、`./host-patch`、`./host-session-install`、`./rollback-layers`、`./rollback-head-prune`、`./rollback-cleanup`、`./rollback-business-state`、`./rollback-barrier`、`./clean-rollback`、`./worldbook-recall-store`、`./rollback-global-variables`、`./rollback-extension-settings`、`./rollback-character-variables`、`./rollback-worldbook-resources`、`./rollback-worldbook-bindings`、`./db-save-exchange`、`./chat-store`、`./author-migration-adapter`、`./failure-state`、`./session-window-projector`、`./activity-state`、`./client`、`./host-actions`、`./save-handlers`、`./variable-ops`、`./legacy-bindings`、`./tavern-chat-state`、`./migration-ops`、`./read-variables`、`./standard-host`、`./variable-archive` —— **prod（32）**
- `./regeneration-adoption`、`./legacy-view-seams`、`./legacy-fork-records`、`./legacy-source-workspace`、`./budgets`、`./conversation-fork-point`、`./fork-history-markers`、`./chat-history-rescue`、`./current-variables`、`./compaction-warning`、`./upstream-compute` —— **deploy-only（11）**
- `./variable-store` —— **test-only（1）**
- `./package.json`、`./locale/*.json` —— **infra（2，永久保留）**

## 7. 未核项（删除**其余**导出前的必要前置证据）

- 跨仓外部消费者（其他包/profile 配置对 `dsh-tavern-sqlite-v2/*` 的使用）。
- `tools/deployed-baseline` 镜像内容。
- 维护/卸载器的 owned-file 清单对旧资产的归属判定。

上述任一项未核实时，**其余导出一律不得删除**（§4 的计算专用导出已获用户明确授权，不在此列）；
如需推进，按 §3 第 3 条走大版本流程。

## 8. 证据指针

- 机器可读事实源：`package.json` 的 `exports`。
- 计算重构范围与核查：[UPSTREAM-SERVER-ONLY-COMPUTE-AUDIT-2026-10-15](<../../docs/workstreams/plugin/UPSTREAM-SERVER-ONLY-COMPUTE-AUDIT-2026-10-15.md>)。
- 上游计算接入定向断言：`test/upstream-compute-integration.test.mjs`。
