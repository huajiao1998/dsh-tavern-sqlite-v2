// dsh-tavern SQLite 会话存储物理层（T2）
// 每会话一库：sessions/<sessionId>.db，WAL 模式，事务写入。
// schema v1：meta + sessions(单行) + events；浅合并表（tavern_messages 等）T3 加入时 bump schema_version。
import { DatabaseSync } from "node:sqlite"
import { existsSync, mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from 'node:util'
import {rollbackSchedulingBarrier} from './lib/rollback-barrier.js'
import {assertRollbackArchiveWritable,validateRollbackArchive} from './lib/rollback-archive-guard.js'

const SCHEMA_VERSION = 1

const SCHEMA_SQL = `
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
CREATE INDEX IF NOT EXISTS events_type ON events(type);
`

/** 会话事件 ↔ 存储行的互转：顶层附加字段（ignorable/sourceEventSeqs/surfaceOp）收敛进 extra_json。 */
export function eventToRow(event) {
	const { type, seq, time, data, ...extra } = event
	return {
		seq,
		type,
		time,
		data_json: JSON.stringify(data),
		extra_json: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
	}
}

export function rowToEvent(row) {
	const event = { type: row.type, seq: row.seq, time: row.time, data: JSON.parse(row.data_json) }
	if (row.extra_json !== null && row.extra_json !== undefined) Object.assign(event, JSON.parse(row.extra_json))
	return event
}

/** 单会话库的打开连接包装：建表、事务、按 seq 读写。一个实例对应一个 .db 文件。 */
export class SqliteSessionDb {
	constructor(path) {
		this.path = path
		this.db = new DatabaseSync(path)
		this.db.exec("PRAGMA journal_mode = WAL")
		// FULL：每次 COMMIT fsync —— 对齐契约「flush 是持久化屏障」的最强语义
		this.db.exec("PRAGMA synchronous = FULL")
		this.db.exec(SCHEMA_SQL)
		this.db.exec(`INSERT OR IGNORE INTO meta(key, value) VALUES('schema_version', '${SCHEMA_VERSION}')`)
		const row = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
		if (row === undefined || Number(row.value) > SCHEMA_VERSION) {
			this.db.close()
			throw new Error(`session store ${path}: unsupported schema version ${row?.value ?? "missing"} (this build supports <= ${SCHEMA_VERSION})`)
		}
		this.stmts = {
			insertEvent: this.db.prepare("INSERT INTO events(seq, type, time, data_json, extra_json) VALUES (?, ?, ?, ?, ?)"),
			selectEvents: this.db.prepare("SELECT seq, type, time, data_json, extra_json FROM events ORDER BY seq"),
			selectEventsFrom: this.db.prepare("SELECT seq, type, time, data_json, extra_json FROM events WHERE seq >= ? ORDER BY seq"),
			countEvents: this.db.prepare("SELECT COUNT(*) AS n FROM events"),
			selectSession: this.db.prepare("SELECT id, header_json, format_version, created_at, inherited_event_count, event_count FROM sessions"),
			upsertSession: this.db.prepare(
				"INSERT INTO sessions(id, header_json, format_version, created_at, inherited_event_count, event_count) VALUES (?, ?, ?, ?, ?, ?) " +
				"ON CONFLICT(id) DO UPDATE SET event_count = excluded.event_count"
			)
		}
	}

	/** 持久回退屏障只保存1位；重启后旧Agent仍不能给半态追加事件。 */
	setRollbackPending(pending) {
		if (pending) this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('rollback_pending','1')").run()
		else this.db.prepare("DELETE FROM meta WHERE key='rollback_pending'").run()
	}
	bindRollbackArchive(file) {
		validateRollbackArchive(file)
		const previous=this.db.prepare("SELECT value FROM meta WHERE key='rollback_archive'").get()?.value
		if(previous && previous!==file)throw new Error('Session回退archive绑定禁止静默替换')
		this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('rollback_archive',?)").run(file)
	}
	assertRollbackWritable(events) {
		const archive=this.db.prepare("SELECT value FROM meta WHERE key='rollback_archive'").get()?.value
		const owner=archive&&assertRollbackArchiveWritable(archive)
		if(events?.some(event=>event.type==='turn/start') && rollbackSchedulingBarrier.has(owner || this.readMeta()?.header.id))throw new Error('物理回退静止期间禁止新Session轮次')
		if (this.db.prepare("SELECT value FROM meta WHERE key='rollback_pending'").get()?.value === '1') throw new Error('物理回退未完成，Session禁止追加事件，请先重试回退')
	}

	/** 当前游标（= 已存事件数 = 下一个 seq）。 */
	cursor() {
		return Number(this.stmts.countEvents.get().n)
	}

	/** 读取单行 header 元数据（不读事件体）。 */
	readMeta() {
		const row = this.stmts.selectSession.get()
		if (row === undefined) return undefined
		return {
			header: JSON.parse(row.header_json),
			formatVersion: Number(row.format_version),
			inheritedEventCount: Number(row.inherited_event_count),
			eventCount: Number(row.event_count)
		}
	}

	/** 全量读出（header + 事件数组）。 */
	readAll() {
		const meta = this.readMeta()
		if (meta === undefined) return undefined
		const events = this.stmts.selectEvents.all().map(rowToEvent)
		return { ...meta, events }
	}

	readEventsFrom(seq) {
		return this.stmts.selectEventsFrom.all(seq).map(rowToEvent)
	}

	/** 首次物化：header 行 + 可空的首批事件，单事务。库已存在且非空时拒绝（防重复物化）。 */
	materialize(header, inheritedEventCount, events) {
		if (this.readMeta() !== undefined && this.cursor() > 0) {
			throw new Error(`session store ${this.path}: refusing to re-materialize a non-empty session`)
		}
		this.db.exec("BEGIN IMMEDIATE")
		try {
			if(events?.length)this.assertRollbackWritable(events)
			this.stmts.upsertSession.run(header.id, JSON.stringify(header), header.version, header.createdAt, inheritedEventCount, 0)
			for (const event of events ?? []) this.stmts.insertEvent.run(...rowToInsertArgs(event))
			this.db.prepare("UPDATE sessions SET event_count = ? WHERE id = ?").run(this.cursor(), header.id)
			this.db.exec("COMMIT")
		} catch (error) {
			this.db.exec("ROLLBACK")
			console.error(`[session-sqlite] materialize failed for ${this.path}: ${error?.message ?? error}`)
			throw error
		}
	}

	/**
	 * 轮边界检查点（2026-09-29 用户定策）：在"新一轮开始前"把上一轮及更早的 WAL 帧
	 * 并入主库，使**主库最多落后一轮** —— 备份/复制只拿 .db 时最多丢一轮（此前是
	 * 撞 1000 帧阈值才合并，最坏可落后约 7 轮）；WAL 空间同时被复用。
	 * 绝不影响写入：有读者占用时退 PASSIVE（不截断，但仍把已提交帧并入主库）；
	 * 任何异常只记录、不上抛——检查点失败不能挡住游玩。
	 */
	checkpointRoundBoundary() {
		try {
			const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()
			if (Number(result?.busy ?? 0) !== 0) {
				const passive = this.db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()
				console.warn(`[session-sqlite] 轮边界检查点被读者占用 → 退 PASSIVE（并入 ${Number(passive?.checkpointed ?? 0)} 帧）: ${this.path}`)
				return
			}
			const frames = Number(result?.log ?? 0)
			if (frames > 0) console.log(`[session-sqlite] 轮边界检查点: 并入 ${frames} 帧 → 主库最多落后一轮 (${this.path})`)
		} catch (error) {
			console.warn(`[session-sqlite] 轮边界检查点失败（不影响写入）: ${this.path} ${error?.message ?? error}`)
		}
	}

	/** 追加一个批次（调用方已保证与库内游标连续；这里再断言一道）。 */
	appendBatch(events, expectedCursor) {
		if (events?.length) this.assertRollbackWritable(events)
		// 新一轮（turn/start）写入前先把上一轮并入主库：主库最多落后一轮
		if (Array.isArray(events) && events.some(event => event?.type === "turn/start")) this.checkpointRoundBoundary()
		this.db.exec("BEGIN IMMEDIATE")
		try {
			if(events?.length)this.assertRollbackWritable(events)
			const cursor = this.cursor()
			if (expectedCursor !== undefined && cursor !== expectedCursor) {
				throw new Error(`session store ${this.path}: cursor drift (stored ${cursor}, expected ${expectedCursor})`)
			}
			for (let i = 0; i < events.length; i++) {
				if (events[i].seq !== cursor + i) {
					throw new Error(`session store ${this.path}: append seq mismatch at index ${i} (expected ${cursor + i}, got ${events[i].seq})`)
				}
				this.stmts.insertEvent.run(...rowToInsertArgs(events[i]))
			}
			this.db.prepare("UPDATE sessions SET event_count = ?").run(cursor + events.length)
			this.db.exec("COMMIT")
		} catch (error) {
			this.db.exec("ROLLBACK")
			console.error(`[session-sqlite] appendBatch failed for ${this.path}: ${error?.message ?? error}`)
			throw error
		}
	}

	/** 纯尾DELETE与唯一自身身份保存同事务；不是普通追加豁免，不关闭任何回退屏障。 */
	truncateFrom(boundarySeq, identity) {
		if (!Number.isSafeInteger(boundarySeq) || boundarySeq < -1) throw new Error('回退SQL边界无效')
		this.db.exec("BEGIN IMMEDIATE")
		try {
			let rollbackIdentity
			if (identity !== undefined) {
				const meta = this.readMeta(), rows = this.db.prepare("SELECT seq,type,time,data_json,extra_json FROM events WHERE type='subagent/descriptor' AND seq>=?").all(meta?.inheritedEventCount ?? 0)
				if (meta?.header.origin !== 'subagent' || rows.length !== 1 || !isDeepStrictEqual(rowToEvent(rows[0]), identity) || identity.seq <= boundarySeq || Object.keys(identity).some(key => !['seq','type','time','data'].includes(key))) throw new Error('回退身份必须来自本Session既有唯一自身元数据，拒绝伪造或业务写入')
				rollbackIdentity = { type: identity.type, seq: boundarySeq + 1, time: identity.time, data: identity.data }
			}
			this.db.prepare("DELETE FROM events WHERE seq > ?").run(boundarySeq)
			if (rollbackIdentity) {
				if (this.cursor() !== boundarySeq + 1) throw new Error('回退身份保存前SQL前缀不连续')
				this.stmts.insertEvent.run(...rowToInsertArgs(rollbackIdentity))
			}
			this.db.prepare("UPDATE sessions SET event_count = ?").run(this.cursor())
			const meta = this.readMeta()
			this.db.exec("COMMIT")
			return rollbackIdentity ? { ...meta, rollbackIdentity } : meta
		} catch (error) {
			this.db.exec("ROLLBACK")
			throw error
		}
	}

	/** 迁移导入：整会话（header + 全部事件）单事务写入；目标库已有内容时拒绝。 */
	importSession(header, inheritedEventCount, events) {
		this.db.exec("BEGIN IMMEDIATE")
		try {
			if (this.readMeta() !== undefined) throw new Error(`session store ${this.path}: already imported`)
			this.stmts.upsertSession.run(header.id, JSON.stringify(header), header.version, header.createdAt, inheritedEventCount, events.length)
			for (const event of events) this.stmts.insertEvent.run(...rowToInsertArgs(event))
			this.db.exec("COMMIT")
		} catch (error) {
			this.db.exec("ROLLBACK")
			throw error
		}
	}

	/** 迁移对账：读回并与源对拍。 */
	verifyAgainst(expectedEvents) {
		const all = this.readAll()
		if (all === undefined) throw new Error(`session store ${this.path}: nothing imported to verify`)
		if (all.events.length !== expectedEvents.length) {
			throw new Error(`migration verify failed for ${this.path}: event count ${all.events.length} != source ${expectedEvents.length}`)
		}
		for (let i = 0; i < expectedEvents.length; i++) {
			if (expectedEvents[i].seq !== all.events[i].seq || expectedEvents[i].type !== all.events[i].type) {
				throw new Error(`migration verify failed for ${this.path}: divergence at index ${i} (source ${expectedEvents[i].seq}/${expectedEvents[i].type} vs stored ${all.events[i].seq}/${all.events[i].type})`)
			}
		}
		return all
	}

	close() {
		this.db.close()
	}
}

function rowToInsertArgs(event) {
	const row = eventToRow(event)
	return [row.seq, row.type, row.time, row.data_json, row.extra_json]
}

/** 会话库集合：root 目录下平铺 <sessionId>.db，进程内连接缓存。 */
export class SqliteSessionStore {
	constructor(root) {
		this.root = root
		this.dbs = new Map()
	}

	/** sessionId → 库文件路径。id 白名单校验（防路径穿越）；格式不符抛错。 */
	pathOf(id) {
		if (typeof id !== "string" || id.length === 0 || id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
			throw new Error(`session-sqlite: refusing to map unusable session id ${JSON.stringify(String(id))}`)
		}
		return join(this.root, `${id}.db`)
	}

	exists(id) {
		return existsSync(this.pathOf(id))
	}

	sizeOf(id) {
		try {
			return statSync(this.pathOf(id)).size
		} catch {
			return undefined
		}
	}

	/** 打开（或复用缓存的）会话库连接。 */
	open(id) {
		const cached = this.dbs.get(id)
		if (cached !== undefined) return cached
		mkdirSync(this.root, { recursive: true })
		const session = new SqliteSessionDb(this.pathOf(id))
		this.dbs.set(id, session)
		return session
	}

	/** 只在文件存在时打开（避免探测性 open 造出空库）。 */
	openExisting(id) {
		if (!this.exists(id)) return undefined
		return this.open(id)
	}

	revisionOf(id) {
		return `sqlite:${this.pathOf(id)}:${this.openExisting(id)?.cursor() ?? 0}`
	}

	/** 写路径统一入口：header 物化（首批可空）。 */
	materializeSession(header, inheritedEventCount, events) {
		const session = this.open(header.id)
		if (session.readMeta() === undefined) session.materialize(header, inheritedEventCount, events)
		else if ((events?.length ?? 0) > 0) session.appendBatch(events)
	}

	closeAll() {
		for (const session of this.dbs.values()) session.close()
		this.dbs.clear()
	}
}
