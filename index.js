// dsh-tavern SQLite 会话后端（T2：权威存储，jsonl 停写）
// 继承 JsonlSessionPersistence 复用其写句柄（批量缓冲/promise 串行/close）、
// tracker（事件路由/单写者 claim/pending 表/flushAll）与全部契约校验；
// 接管存储接缝：新会话事务写 SQLite；原档通过精确官方解码只读查看，绝不自动迁移。
// 只有用户显式创建新的原生 Session 分叉与新 Chat 才能继续游玩。
//
// （2026-09-29 砍单刀1）运维回退开关 TAVERN_SESSION_BACKEND 已退役删除：
// jsonl 停写是唯一路径。物理回退 = 还原 profiles/tavern/cordis.patch.yml
// 备份 + 重启（jsonl 后端原样接管；已迁移会话数据在 .db，两源不互见须知）。
import { createRequire } from "node:module"
import { readdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
// §4.1「未迁移档可看不可玩」：开始轮次前过一道门（见 guardTurnStart）
import { assertLegacySessionWritable, isLegacySession, listLinkedLegacySessionIds, chatIdForSession } from "./lib/tavern-chat-state.js"
import { listLegacyBindings } from "./lib/legacy-bindings.js"
import { rewindRollbackHandles } from "./lib/rollback-handles.js"
import { rewindSessionMemory } from './lib/rollback-cleanup.js'
import { assertRollbackSessionWritable, rollbackSchedulingBarrier } from "./lib/rollback-barrier.js"
import { legacyArtifactFor, readLegacySession, statLegacySession, createLegacyReadHandle } from "./lib/legacy-session-reader.js"

const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh-tavern")
const runtimeModules = path.join(dshHome, "runtime/lib/node_modules/@deepseek-ai")
const requireFrom = (segment) => {
	const entry = path.join(runtimeModules, segment)
	return createRequire(entry)(entry)
}

const jsonlMod = requireFrom("dsh-session-persistence-jsonl/lib/index.js")
const JsonlSessionPersistence = jsonlMod.default ?? jsonlMod
const persistMod = requireFrom("dsh-session-persistence/lib/index.js")
const { SessionPersistenceNotFoundError, SessionPersistenceRevision } = persistMod

import { SqliteSessionStore } from "./store.js"
const originalOpen = JsonlSessionPersistence.prototype.open
const originalCreate = JsonlSessionPersistence.prototype.create

// 接管的存储接缝清单：原型接管的覆盖面
export const TAKEOVER_SEAMS = Symbol.for("dsh-tavern.session-backend.seams")
const TAKEOVER_KEYS = [
	"persistBatch", "persistHeader", "appendLines", "materialize", "truncateTornTail",
	"acquireLease", "acquireWriteLease",
	"findLog", "requireStoredLog", "resolveCurrentLog", "readStoredLog",
	"stat", "list", "locate",
	"ensureMigrated", "readStored", "truncateEvents", "loadRollbackSession", "bindRollbackArchive", "setRollbackPending", "guardTurnStart", "assertWritable", "create", "open", "ensureRootEncoding"
]

export default class TavernSessionPersistence extends JsonlSessionPersistence {
	/** 对齐官方 sqlite 后端：等 ctx.sessions 就绪再挂（保证路由安装时序）。 */
	static inject = ["sessions"]

	constructor(ctx, config) {
		super(ctx, config)
		/** 后端诊断标签，遮蔽 Service.name（不改服务键）——对齐官方 sqlite 后端写法。 */
		this.name = "session-persistence-tavern-sqlite"
		console.warn("[SESSION-BACKEND] dsh-tavern SQLite 会话后端构造, root =", this.root)
		console.warn("[SESSION-BACKEND] SQLite 后端已接管；原档只读，新会话写 .db")
		// 先加固自身：own-property 接管 + 会话补丁重装挂钩（挂载即生效，不依赖复扫时序）
		patchInstanceAndPrototypes(this, this)
		// 声明"这些存储接缝归本后端所有"：宿主会话补丁安装器据此**跳过**官方实现（否则它会把
		// 官方 stat/open/… 盖在我们头上，原档 stat 变回官方实现 → 显式绑定源 workspace 登记失败）。
		try {
			Object.defineProperty(this, TAKEOVER_SEAMS, { value: TAKEOVER_KEYS, configurable: true, enumerable: false })
		} catch { /* 忽略：拿不到声明时补丁侧按"非接管后端"处理，行为与历史一致 */ }
		console.warn("[SESSION-BACKEND] 已对自身实例安装接管（own-property + 重装挂钩）")
		sweepRogueInstance(this)
		setTimeout(() => sweepRogueInstance(this), 5000)
		setTimeout(() => sweepRogueInstance(this), 30000)
	}

	// ---------- 数据库会话检查（兼容旧方法名，不执行迁移） ----------

	/** 只允许已存在的新 SQLite 会话，原档拒绝写入；不创建、不导入。 */
	ensureMigrated(id) {
		this.assertWritable(id)
		const existing = this.store.openExisting(id)
		if (existing?.readMeta() !== undefined) return Promise.resolve({ migrated: false })
		throw new SessionPersistenceNotFoundError(id)
	}

	assertWritable(id) {
		assertLegacySessionWritable(id)
		if (legacyArtifactFor(this.root, id)) {
			const error = new Error('原生原档只读；必须创建新会话、新聊天的显式 SQLite 分叉')
			error.code = 'DSH_TAVERN_LEGACY_READ_ONLY'
			throw error
		}
	}

	async create(header, options) {
		this.assertWritable(header.id)
		return originalCreate.call(this, header, options)
	}

	async open(id, access, options) {
		options?.signal?.throwIfAborted()
		const artifact = legacyArtifactFor(this.root, id)
		if (artifact) {
			if (access !== 'read') this.assertWritable(id)
			return createLegacyReadHandle(readLegacySession(this.root, id, this.generationFormat), options?.signal)
		}
		if (access !== 'read') this.assertWritable(id)
		if (isLegacySession(id)) throw new SessionPersistenceNotFoundError(id)
		return originalOpen.call(this, id, access, options)
	}

	// SQLite backend无需扫描JSONL根编码；原档只经精确只读reader。
	async ensureRootEncoding() {}

	/** 从 SQLite 读全量（返回结构与 jsonl 后端的 stored log 对齐）。 */
	readStored(id) {
		const legacy = readLegacySession(this.root, id, this.generationFormat)
		if (legacy) return legacy
		if (isLegacySession(id)) throw new SessionPersistenceNotFoundError(id)
		const session = this.store.openExisting(id)
		const all = session?.readAll()
		if (all === undefined) throw new SessionPersistenceNotFoundError(id)
		return {
			status: "current",
			meta: all.header,
			events: all.events,
			eventState: "shared-frozen",
			inheritedEventCount: all.inheritedEventCount,
			tornTruncateTo: undefined,
			recoveredTail: undefined,
			revision: SessionPersistenceRevision(`sqlite:${this.store.pathOf(id)}:${all.events.length}`)
		}
	}

	// ---------- 写路径（存储接缝） ----------

	/**
	 * §4.1「未迁移档可看不可玩」的唯一拦截点：**写 turn/start 之前**。
	 * 放在存储层 = 覆盖所有入口（客户端发送 / agent 工具 / 子代理）；此时事件还没落库，
	 * 拦下来不留半状态，LLM 调用也不会发生（turn/start 先于 request/header 与模型调用）。
	 */
	guardTurnStart(id, events) {
		this.assertWritable(id)
		assertRollbackSessionWritable(id)
		if (events?.some(event => event.type === 'turn/start') && rollbackSchedulingBarrier.has(id)) throw new Error('物理回退静止期间禁止开启新轮次')
	}

	async persistBatch(header, events, _isMaterialized, inheritedEventCount) {
		this.guardTurnStart(header.id, events)
		let session = this.store.openExisting(header.id)
		if (session === undefined) {
			session = this.store.open(header.id)
			session.materialize(header, inheritedEventCount, events)
			this.tracker.materialized(header.id)
			return
		}
		session.appendBatch(events)
	}

	async persistHeader(header, inheritedEventCount) {
		this.assertWritable(header.id)
		let session = this.store.openExisting(header.id)
		if (session === undefined) {
			session = this.store.open(header.id)
			session.materialize(header, inheritedEventCount, [])
		}
		this.tracker.materialized(header.id)
	}

	/**
	 * 完全接管基类的 jsonl 写函数：改道 SQLite。任何实例（含装载器重复构造产生的
	 * 游离实例）调用到这两个函数都不会写 transcript。接管生效后这两个函数不应再被
	 * 触碰——一旦被调用即响亮记录调用栈（等于抓到漏网写入通道）。
	 */
	async appendLines(meta, events) {
		this.guardTurnStart(meta?.id, events)
		console.error(`[session-sqlite] 拦截 appendLines（transcript 写入已转 SQLite）id=${meta?.id} n=${events?.length} stack=${String(new Error().stack || "").split("\n").slice(2, 6).join(" | ")}`)
		if ((events?.length ?? 0) > 0) this.store.materializeSession(meta, 0, events)
	}

	async materialize(meta, inheritedEventCount, events) {
		this.assertWritable(meta.id)
		console.error(`[session-sqlite] 拦截 materialize（transcript 写入已转 SQLite）id=${meta?.id} n=${events?.length} stack=${String(new Error().stack || "").split("\n").slice(2, 6).join(" | ")}`)
		this.store.materializeSession(meta, inheritedEventCount, events)
	}

	/** SQLite 无 torn tail 概念；事务保证半批永不可见。 */
	async truncateTornTail(header) { this.assertWritable(header.id) }

	/** 跨进程写锁不需要：每会话一库 + SQLite 写事务天然串行；进程内单写者由 tracker 保证。 */
	async acquireLease(id) {
		this.assertWritable(id)
		console.error(`[session-sqlite] 拦截 acquireLease（session.lock 已抑制）${new Date().toISOString()} stack=${String(new Error().stack || "").split("\n").slice(2, 6).join(" | ")}`)
		return { release: async () => {} }
	}

	async acquireWriteLease(header) {
		this.assertWritable(header.id)
		console.error(`[session-sqlite] 拦截 acquireWriteLease（session.lock 已抑制）${new Date().toISOString()} stack=${String(new Error().stack || "").split("\n").slice(2, 6).join(" | ")}`)
		return { release: async () => {} }
	}

	// ---------- 读路径（存储接缝） ----------

	/** 原档优先返回精确只读产物；其他会话返回 .db 路径，不存在则 undefined。 */
	async resolveCurrentLog(id, _signal) {
		const artifact = legacyArtifactFor(this.root, id)
		if (artifact) return artifact.path
		if (isLegacySession(id)) return undefined
		return this.store.exists(id) ? this.store.pathOf(id) : undefined
	}

	async readStoredLog(_logPath, expectedId, _signal) {
		_signal?.throwIfAborted()
		return this.readStored(expectedId)
	}

	/** 读取完整已存日志；原档官方 strict/current 解码，不迁移、不写回。 */
	async requireStoredLog(id, signal) {
		signal?.throwIfAborted()
		return this.readStored(id)
	}

	/**
	 * findLog 的消费方：create 查重（`!== undefined`）与 open write（`currentPath`）。
	 * 原生原档优先于同 ID 影子库，防止查重漏掉原件；原档写打开在前置守卫拒绝。
	 * 原件路径仅在只读持久化接缝内部流转，
	 * locate() 仍然恒 undefined、不对外暴露。
	 */
	async findLog(id, _signal) {
		const artifact = legacyArtifactFor(this.root, id)
		if (artifact) return { currentPath: artifact.path, sourcePath: artifact.path, sourceVersion: artifact.version }
		if (isLegacySession(id)) return undefined
		if (this.store.exists(id)) {
			const dbPath = this.store.pathOf(id)
			return { currentPath: dbPath, sourcePath: dbPath, sourceVersion: 3 }
		}
		return undefined
	}

	/**
	 * 拒绝向消费方暴露原始产物路径（对齐官方 sqlite 后端语义：库后端无每会话原件）。
	 * transcript 的路径从此不出现在任何拒绝诊断/原始访问入口。
	 */
	locate(_meta) {
		return undefined
	}

	// ---------- 观察（stat / list：绑定原档只读、新会话 SQLite） ----------

	async stat(id, options) {
		options?.signal?.throwIfAborted()
		// 原档观测走 header-only（官方 stat 语义：不读事件日志）：只读首行/首个 zstd 帧，
		// 只构造官方 restore 并取其构造期 header（零 decodeRow/finish），不读正文。
		// 官方 stat 快照本就没有 eventCount；旧代次升级是 one-to-many，行数 ≠ 事件数，不假造。
		// 正文校验仍在真正读取时执行（open/readStored 走原有官方完整恢复路径）；stat 通过不表示正文已验证。
		const legacy = statLegacySession(this.root, id, this.generationFormat)
		if (legacy) return { header: legacy.meta, revision: SessionPersistenceRevision(legacy.revision), sizeBytes: legacy.sizeBytes }
		if (isLegacySession(id)) throw new SessionPersistenceNotFoundError(id)
		const pending = this.tracker.pendingOf(id)
		if (pending !== undefined) return { header: pending.header, revision: pending.revision }
		const session = this.store.openExisting(id)
		if (session !== undefined) {
			const meta = session.readMeta()
			if (meta !== undefined) {
				return {
					header: meta.header,
					revision: SessionPersistenceRevision(`sqlite:${this.store.pathOf(id)}:${meta.eventCount}`),
					eventCount: meta.eventCount,
					sizeBytes: this.store.sizeOf(id)
				}
			}
		}
		throw new SessionPersistenceNotFoundError(id)
	}

	async list(options) {
		const signal = options?.signal
		const snapshots = []
		const listed = new Set()
		// 已授权绑定原档先读，绝不枚举所有旧档正文。
		for (const binding of listLegacyBindings()) {
			signal?.throwIfAborted()
			if (binding.chatId === 'chat-mu0rqvmu-ji0z6a') continue
			snapshots.push(await this.stat(binding.sessionId, options))
			listed.add(binding.sessionId)
			listed.add(binding.originalSessionId)
		}
		// 作者原本已有链接的普通原档也必须进入宿主目录：stat 能读而 list 漏列，
		// 会让前端 summary/binding 永远缺失，刷新只能等到8秒超时。
		// 仅按明确链接读 header；无原生承载时略过，不读 Chat 正文、不补绑定、不迁移。
		for (const id of listLinkedLegacySessionIds()) {
			signal?.throwIfAborted()
			if (listed.has(id)) continue
			const legacy = statLegacySession(this.root, id, this.generationFormat)
			if (!legacy) continue
			snapshots.push({ header: legacy.meta, revision: SessionPersistenceRevision(legacy.revision), sizeBytes: legacy.sizeBytes })
			listed.add(id)
		}
		// 新会话只列 .db；原档同ID影子库不打开。
		let entries
		try {
			entries = readdirSync(this.root)
		} catch (error) {
			// 响亮记录：这里曾把 ReferenceError 静默吞成空列表（.db 会话永不被列出），别再无声
			console.error(`[session-sqlite] list() 扫描 root 失败: ${error?.message ?? error}`)
			entries = []
		}
		for (const file of entries) {
			if (!file.endsWith(".db")) continue
			const id = file.slice(0, -3)
			if (chatIdForSession(id) === 'chat-mu0rqvmu-ji0z6a') continue
			if (listed.has(id) || isLegacySession(id) || legacyArtifactFor(this.root, id)) continue
			const session = this.store.openExisting(id)
			const meta = session?.readMeta()
			if (meta === undefined) continue
			signal?.throwIfAborted()
			listed.add(meta.header.id)
			snapshots.push({
				header: meta.header,
				revision: SessionPersistenceRevision(`sqlite:${this.store.pathOf(id)}:${meta.eventCount}`),
				eventCount: meta.eventCount,
				sizeBytes: this.store.sizeOf(id)
			})
		}
		// 3. 本进程 created-but-unmaterialized 会话
		for (const [id, entry] of this.tracker.pendingEntries()) {
			signal?.throwIfAborted()
			if (chatIdForSession(id) === 'chat-mu0rqvmu-ji0z6a') continue
			if (!listed.has(id)) snapshots.push({ header: entry.header, revision: entry.revision })
		}
		return snapshots
	}

	// ---------- T3：回退裁剪（单一路径：当场截断 + 句柄回卷） ----------

	/**
	 * 物理删除 seq > boundarySeq 的事件并回拨游标（单事务），然后回卷该会话活动写句柄。
	 * 三步顺序不可换：
	 *   ① 先 drainLive()：把句柄里"已接受但还没落地"的路由缓冲排空，保证 DELETE 之后
	 *      不会再有迟到批次写进新尾部（缓冲排空失败即抛，不放行半状态的截断）；
	 *   ② store.truncateFrom(boundarySeq)：单事务 DELETE + event_count 回拨；
	 *   ③ rewindOpenHandles：句柄游标/观测长度回卷——不回卷则下一次 read 抛
	 *      "stored log shrank below a previously observed prefix"、append 抛
	 *      "append seq mismatch"（tools/truncate-live.test.mjs 实证）。
	 * 调用方（lib/domain/rollback-cleanup.js）随后必须就地重建宿主 Session 的内存
	 * 镜像（log/SurfaceManager/投影注册表），三段合起来才等价"那一轮没发过"。
	 */
	async truncateEvents(header, boundarySeq, identity) {
		this.assertWritable(header.id)
		await this.drainOpenHandles(header.id)
		const session = this.store.openExisting(header.id)
		if (session === undefined) throw new SessionPersistenceNotFoundError(header.id)
		const meta = session.truncateFrom(boundarySeq, identity)
		this.rewindOpenHandles(header.id, meta?.eventCount ?? 0)
		return meta
	}

	/** 冷Session只读构造用于回退，不resume Agent、不附着、不追加恢复标记或任务。 */
	async loadRollbackSession(id) {
		this.assertWritable(id)
		await this.drainOpenHandles(id)
		const db = this.store.openExisting(id), stored = db?.readAll()
		if (!stored) throw new SessionPersistenceNotFoundError(id)
		// 使用已装共享补丁的同一验证/构造器；不能绕回stock词汇，也不忽略必需扩展事件。
		const patch = this[Symbol.for('dsh-tavern.host-session-patch.v1')]
		if (patch?.serverReady !== true || typeof patch.restoreStoredSession !== 'function') throw new Error('冷会话恢复缺少已就绪的酒馆宿主补丁，拒绝用原生词汇猜测读取')
		const session = patch.restoreStoredSession(stored)
		if (session?.id !== id) throw new Error('冷会话恢复身份不一致')
		// rc.2构造器会追加未发布的end-seed；删掉仅在内存生成的后缀，不把它落库。
		rewindSessionMemory(session, stored.events.length)
		return session
	}

	async bindRollbackArchive(id, file) {
		this.assertWritable(id)
		const session=this.store.openExisting(id)
		if(!session)throw new SessionPersistenceNotFoundError(id)
		session.bindRollbackArchive(file)
	}
	async setRollbackPending(id, pending) {
		this.assertWritable(id)
		const session = this.store.openExisting(id)
		if (!session) throw new SessionPersistenceNotFoundError(id)
		session.setRollbackPending(pending)
	}

	/** 排空该会话活动写句柄的路由缓冲（无句柄/无缓冲时零成本）。 */
	async drainOpenHandles(id) {
		const handles = this.tracker?.openHandles
		if (handles === undefined || typeof handles[Symbol.iterator] !== "function") throw new Error('回退缺少活动句柄tracker，拒绝跳过排空')
		for (const handle of handles) {
			if (handle?.id !== id) continue
			if (handle.access === 'write' && typeof handle.drainLive !== 'function') throw new Error('回退活动写句柄缺少drainLive，拒绝截断')
			if (typeof handle.drainLive === "function") await handle.drainLive()
		}
	}

	/** 把该会话所有活动写句柄的游标/观测长度回卷到截断后的长度。 */
	rewindOpenHandles(id, eventCount) {
		rewindRollbackHandles(this.tracker?.openHandles, id, eventCount)
	}
}

// ---------- 基类原型级接管（完全接管的收口） ----------
// 子类 override 只约束自己的实例；装载器 EntryGroup 回滚重试会把本插件构造两次，
// 消费方（agent-loop 等）可能持有另一个实例的引用并由它创建写句柄——这是 jsonl
// 继续被写、session.lock 继续存在的根因。把全部存储接缝钉到基类原型上，任何实例
// （含游离实例）的读写都收敛到同一 SQLite 存储，transcript 不再被读写。
//
// 另外把「哪些接缝归接管后端」登记到 globalThis：cordis 把服务交给上下文时会把实例方法
// 绑定复制成服务门面的 own-property，实例上的标记传不到门面，宿主会话补丁必须从全局
// 注册表读取该清单，才能不从源头把官方 stat/open/… 盖回存储接缝（2026-09-30 实测）。
try {
	globalThis[Symbol.for("dsh-tavern.session-backend.owned-seams")] = { keys: TAKEOVER_KEYS, impl: TavernSessionPersistence.prototype }
} catch { /* 忽略：拿不到注册表时补丁侧退回历史行为（可能覆盖存储接缝） */ }

const sharedStores = new Map()
function sharedStoreFor(root) {
	let store = sharedStores.get(root)
	if (store === undefined) {
		store = new SqliteSessionStore(root)
		sharedStores.set(root, store)
	}
	return store
}

for (const key of TAKEOVER_KEYS) {
	const impl = TavernSessionPersistence.prototype[key]
	if (typeof impl === "function") JsonlSessionPersistence.prototype[key] = impl
}
Object.defineProperty(JsonlSessionPersistence.prototype, "store", {
	configurable: true,
	get() {
		return sharedStoreFor(this.root ?? path.join(dshHome, "profile-data", "tavern", "sessions"))
	}
})

// 兜底接管：注册表里若存在非本类的持久化实例（双构造/回滚窗口期被消费方捕获的游离
// 对象，或别的类副本），直接给那个对象打 own-property 补丁——实例属性优先于任何
// 原型链，无论它是谁、从哪个模块副本来，读写都强制收敛到共享 SQLite 存储。
function sweepRogueInstance(self) {
	try {
		const other = typeof self.ctx?.get === "function" ? self.ctx.get("sessionPersistence") : undefined
		if (other !== undefined && other !== self) {
			patchInstanceAndPrototypes(other, self)
			console.warn("[SESSION-BACKEND] 已对游离持久化实例兜底接管 ctor=" + (other?.constructor?.name ?? "unknown"))
		}
	} catch (e) {
		console.warn("[SESSION-BACKEND] 游离实例兜底接管失败: " + (e?.message ?? e))
	}
	// 文档诊断法（Cordis 教程 ch.6「诊断始终无法加载的插件」）：枚举插件注册表，
	// 把所有 fiber 的名字与状态打出来——任何隐藏的持久化插件/实例都会现形。
	try {
		if (typeof self.ctx?.registry?.values === "function") {
			const lines = []
			for (const runtime of self.ctx.registry.values()) {
				let states = "?"
				try {
					states = Array.from(runtime?.fibers ?? []).map((f) => `${f?.name ?? "?"}:${f?.state ?? "?"}`).join(",")
				} catch {}
				lines.push(`${runtime?.name ?? "?"}[${states}]`)
			}
			console.warn("[SESSION-BACKEND] 插件注册表: " + lines.join(" | "))
		}
	} catch {}
}

// 根修：不只补实例，还把实例的原型链（含 data: 模块副本的类原型）上所有同名接缝
// 全部替换成接管实现。cordis 服务代理按"属性/原型链现查"取方法，原型链被替换后
// 任何查找路径、任何后续新建的实例都只能拿到我们的实现——口子从源头关闭。
// 缝写入必须走 Object.defineProperty：cordis 服务代理（ctx.get 返回的 Proxy）的 set 陷阱
// 会吞掉普通赋值（`obj[key] = impl` 静默无效），而 defineProperty 会落到真实目标上——
// 官方宿主补丁正是用 defineProperty 把它的实现写进目标、盖在我们的 own-property 之上；
// 我们再用赋值"重装"就会看起来成功（无异常）却完全没写进去，实机上表现为补丁后
// persistence.stat 变成官方实现（对原档返回 undefined）→ workspace 登记失败、启动崩溃。
function defineSeam(target, key, impl) {
	const old = Object.getOwnPropertyDescriptor(target, key)
	try {
		Object.defineProperty(target, key, {
			value: impl, configurable: true, writable: true,
			enumerable: old?.enumerable ?? false,
		})
	} catch {
		try { target[key] = impl } catch {}
	}
}

function patchInstanceAndPrototypes(obj, self) {
	for (const key of TAKEOVER_KEYS) {
		const impl = TavernSessionPersistence.prototype[key]
		if (typeof impl === "function") defineSeam(obj, key, impl)
	}
	defineSharedAccessors(obj, self)
	installReassertHook(obj, self)
	let proto = Object.getPrototypeOf(obj)
	const seen = new Set()
	while (proto !== null && proto !== Object.prototype && !seen.has(proto)) {
		seen.add(proto)
		for (const key of TAKEOVER_KEYS) {
			const impl = TavernSessionPersistence.prototype[key]
			if (typeof impl === "function" && typeof proto[key] === "function") defineSeam(proto, key, impl)
		}
		defineSharedAccessors(proto, self)
		proto = Object.getPrototypeOf(proto)
	}
	// 自证：重装后 own-property 读回来必须是我们的原函数。⚠ 不能用 `obj.stat !== 原型.stat`
	// 判定 —— cordis 服务代理/服务基类会把方法绑定后返回（toString 是 native code），
	// 那个比较恒为真、只会刷假警告（2026-09-30 实测踩过）。改读 own 描述符。
	try {
		const descriptor = Object.getOwnPropertyDescriptor(obj, "stat")
		if (descriptor && descriptor.value !== undefined && descriptor.value !== TavernSessionPersistence.prototype.stat) {
			console.warn("[SESSION-BACKEND] 接缝重装未生效：stat 的 own 实现仍不是接管实现")
		}
	} catch {}
}

function defineSharedAccessors(target, self) {
	try {
		if (Object.getOwnPropertyDescriptor(target, "store") === undefined) {
			Object.defineProperty(target, "store", { configurable: true, get: () => sharedStoreFor(self.root) })
		}
	} catch {}
}

// 会话补丁协作挂钩：酒馆的 host-session-patch 会把编译副本（PatchedPersistence）的
// 全部原型方法整体覆盖到本实例的 own 属性上（连我们的租约 no-op 一起换掉）。它现在
// 从源头中性化了租约（见 tavern-plugin/lib/domain/host-session-patch.js），同时会在
// 覆盖完成后调用这个符号方法——让接管后端当场把自己的全部接缝重新装回去，彻底消掉
// "补丁覆盖 → 下次定时复扫"之间的窗口（不再依赖 +5s/+30s 的补救时序）。
const REASSERT = Symbol.for("dsh-tavern.session-backend.reassert")

function installReassertHook(obj, self) {
	try {
		Object.defineProperty(obj, REASSERT, {
			configurable: true,
			writable: true,
			value: () => {
				try {
					patchInstanceAndPrototypes(obj, self)
					console.warn("[SESSION-BACKEND] 会话补丁覆盖后已立即重装接管 " + new Date().toISOString())
				} catch (e) {
					console.warn("[SESSION-BACKEND] 重装接管失败: " + (e?.message ?? e))
				}
			},
		})
	} catch {}
}

console.warn(`[SESSION-BACKEND] 原型接管完成: ${TAKEOVER_KEYS.length} 个接缝, acquireLease=${JsonlSessionPersistence.prototype.acquireLease === TavernSessionPersistence.prototype.acquireLease ? "已接管" : "未接管"}`)
