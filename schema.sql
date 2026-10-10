-- ============================================================================
-- dsh-tavern-sqlite-v2 全库 DDL（按实现反推，2026-10）
-- 本文件为纯 DDL，幂等（IF NOT EXISTS）；运行时各库由代码 ensure，此处供审阅/新建参考。
-- 物理形态：每会话/每档一库，WAL 模式（PRAGMA journal_mode=WAL，属连接级设置，不在此）。
-- 按节执行：各节对应不同数据库文件，不可整文件灌进同一个库（§1/§3 的
-- variable_snapshots/variable_state 同名不同形，分别属于 chat 存档库与旧变量独立库）。
-- 来源：chat-sqlite-store.js、lib/variable-archive.js、lib/timeline-nodes.js、
--       store.js、variable-sqlite-store.js、lib/rollback-global-variables.js、
--       lib/worldbook-recall-store.js、lib/server-dependencies.js、
--       lib/legacy-bindings.js、lib/legacy-fork-records.js、lib/mvu/esm-module-loader.js
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Chat 存档库：chats/<chatId>.db（chat-sqlite-store.js）
--    现行为 v4：archive_head(id=1 单行) + archive_head_fields(键行) + archive_messages(楼层行)
--    + archive_timeline_nodes(timeline 子行，P2-a) + 变量表 + 世界书历史（同库同连接）。
--    kind=0 头字段；kind=1 仅 messages 占位；timeline 键 v4 后 value_json 置 NULL 占位。
--    legacy_fork_markers 等历史表由 migration-ops.js 迁移期清理，不在此。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS archive_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_head_fields (
  key TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  value_json TEXT
);

CREATE INDEX IF NOT EXISTS archive_head_fields_ord ON archive_head_fields (ord);

CREATE TABLE IF NOT EXISTS archive_messages (
  message_index INTEGER PRIMARY KEY,
  message_json TEXT NOT NULL
);

-- P2-a（v4）：timeline 子行化。node_key 约定：'@meta'（标量/participants）、
-- 'checkpoints:<i>'（数组第 i 项）、'operations:<operationId>'（单条操作，id 原样入键）。
-- v3 及以前 timeline 为 archive_head_fields 整键；head 占位 NULL 时读子行表组装。
CREATE TABLE IF NOT EXISTS archive_timeline_nodes (
  node_key TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  value_json TEXT NOT NULL
);

-- MVU 变量快照链（lib/variable-archive.js，与 chat 表同库）：
-- 逐 swipe 一行的完整变量树（时间旅行 = 同 message_index 取 turn<=N 的 selected 行）。
CREATE TABLE IF NOT EXISTS variable_snapshots (
  message_index INTEGER NOT NULL,
  swipe_id INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  slot_count INTEGER NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  mvu_ready INTEGER NOT NULL DEFAULT 0,
  tree_json TEXT,
  operations_json TEXT,
  uid TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_index, swipe_id)
);

CREATE INDEX IF NOT EXISTS variable_snapshots_turn ON variable_snapshots (turn);

-- 当前变量态单行缓存（id=1）。
CREATE TABLE IF NOT EXISTS variable_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tree_json TEXT NOT NULL,
  turn INTEGER NOT NULL,
  message_index INTEGER NOT NULL,
  swipe_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 世界书历史快照（lib/rollback-worldbook-history.js）。
CREATE TABLE IF NOT EXISTS archive_worldbook_history (
  book_id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_json TEXT NOT NULL
);

-- ----------------------------------------------------------------------------
-- 2. 会话事件库：sessions/<sessionId>.db（store.js，schema v1）
--    meta.schema_version = '1'。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  header_json TEXT NOT NULL,
  format_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  inherited_event_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  time INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  extra_json TEXT
);

CREATE INDEX IF NOT EXISTS events_type ON events (type);

-- ----------------------------------------------------------------------------
-- 3. MVU 变量独立库（第一阶段形态）：chats/<chatId>/variables.db（variable-sqlite-store.js）
--    快照链 + 当前态；与 §1 的 variable_* 是两代实现，按档择一。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS variable_snapshots (
  turn INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  tree_json TEXT NOT NULL,
  operations_json TEXT,
  uid TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS variable_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tree_json TEXT NOT NULL,
  turn INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
-- 4. 共享全局变量库（lib/rollback-global-variables.js，每库一组同形表）：
--    prompt-template-variables.db / tavern-extension-settings.db /
--    character-variables.db / worldbook-resources.db / worldbook-bindings.db
--    key 形如 JSON['<scope>','<name>']；retired 的 global_undo/global_rollback_keys/
--    global_rollback_owners/global_key_revisions 已退役（init 时 DROP）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS global_values (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS global_scopes (
  scope TEXT PRIMARY KEY
);

-- 仅 character-variables.db / worldbook-resources.db 需要（按 scope 前缀索引）。
CREATE INDEX IF NOT EXISTS character_variable_scope ON global_values (json_extract(key, '$[0]'));

-- ----------------------------------------------------------------------------
-- 5. 世界书召回库（lib/worldbook-recall-store.js）。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recalls (
  chat_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  branch_id TEXT,
  created_at INTEGER NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (chat_id, operation_id)
);

CREATE INDEX IF NOT EXISTS recalls_chat_time ON recalls (chat_id, created_at, operation_id);
CREATE INDEX IF NOT EXISTS recalls_chat_branch_turn_time ON recalls (chat_id, branch_id, turn, created_at, operation_id);

-- ----------------------------------------------------------------------------
-- 6. 卡脚本派发库（lib/server-dependencies.js）：内容寻址派发标记。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_marks (
  card_path TEXT NOT NULL,
  script_id TEXT NOT NULL,
  content TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (card_path, script_id, content)
);

-- ----------------------------------------------------------------------------
-- 7. 旧档绑定与分叉记录库（lib/legacy-bindings.js、lib/legacy-fork-records.js）：
--    新库必须同时具备两表（旧读路径 listLegacyBindings 依赖 legacy_bindings）。
--    legacy_fork_records.state ∈ claimed/bound/created/complete。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS legacy_bindings (
  chat_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  original_session_id TEXT NOT NULL,
  artifact_path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_fork_records (
  source_chat_id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  at_seq INTEGER NOT NULL,
  target_title TEXT NOT NULL,
  token TEXT NOT NULL,
  state TEXT NOT NULL,
  target_session_id TEXT NOT NULL DEFAULT '',
  target_chat_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  claimed_at INTEGER NOT NULL,
  bound_at INTEGER,
  created_at INTEGER,
  completed_at INTEGER
);

-- ----------------------------------------------------------------------------
-- 8. MVU ESM 源码缓存库（lib/mvu/esm-module-loader.js）：按 URL 缓存模块源。
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS module_sources (
  url TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
