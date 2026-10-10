// 原生原档只读解码：完整官方升级图 + strict/current 校验，不迁移、不恢复写盘。
// 同 ID 导入入口永久拒绝；用户手动官方分叉才创建新的 SQLite 会话。
import { closeSync, openSync, readSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { zstdDecompressSync } from "node:zlib"

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// jsonl 后端的 canonical 代文件名（v0 为 session.jsonl，v3 为 session.v3.jsonl）
const CANONICAL_LOG = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/
// header 只读前缀预算：只取首行 / 首个 zstd 帧，绝不整档解码；超出即失败（不改写、不跳过）。
const HEADER_PREFIX_LIMIT = 8 * 1024 * 1024
const HEADER_CHUNK = 64 * 1024

/** 与官方 encodeSegment 同契约；只定向授权 ID，不枚举其他会话目录。 */
function encodeSegment(id) {
	const raw = String(id)
	if (!raw) throw new Error('原档 Session 身份为空')
	if (raw === '.' || raw === '..') return '~002E'.repeat(raw.length)
	let result = ''
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]
		result += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
	}
	return result
}

/**
 * 在 jsonl root 里定位某会话的当前代日志文件。
 * @returns { path, version, compressed } 或 undefined。
 */
export function findJsonlArtifact(root, id) {
	let projectDirs
	try {
		projectDirs = readdirSync(root, { withFileTypes: true })
	} catch {
		return undefined
	}
	for (const project of projectDirs) {
		if (!project.isDirectory()) continue
		const projectDir = join(root, project.name)
		{
			const sessionDir = join(projectDir, encodeSegment(id))
			let files
			try {
				files = readdirSync(sessionDir)
			} catch {
				continue
			}
			let best
			for (const file of files) {
				if (file.endsWith(".tmp")) continue
				let base = file
				let compressed = false
				if (base.endsWith(".zstd")) {
					base = base.slice(0, -5)
					compressed = true
				}
				const match = CANONICAL_LOG.exec(base)
				if (match === null) continue
				const version = match[1] === undefined ? 0 : Number(match[1])
				if (best === undefined || version > best.version) best = { path: join(sessionDir, file), version, compressed }
			}
			return best
		}
	}
	return undefined
}

/** 解码整个 jsonl 文件为行数组（首行 header，其余事件行）。多帧 zstd 逐帧解压。 */
function decodeLines(path, compressed) {
	const raw = readFileSync(path)
	let text
	if (compressed) {
		const chunks = []
		let cursor = 0
		while (cursor < raw.length) {
			const at = raw.indexOf(ZSTD_MAGIC, cursor)
			if (at !== cursor) {
				if (at < 0) throw new Error(`session artifact ${path}: trailing garbage after last zstd frame at offset ${cursor}`)
				throw new Error(`session artifact ${path}: unexpected bytes before zstd frame at offset ${at}`)
			}
			// 帧边界：下一帧起点或文件尾（迁移读的是完好文件，不需要 torn-tail 恢复）
			const next = raw.indexOf(ZSTD_MAGIC, cursor + 4)
			const end = next < 0 ? raw.length : next
			const frame = raw.subarray(cursor, end)
			const decoded = zstdDecompressSync(frame, { info: true })
			if (decoded.engine.bytesWritten !== frame.length) throw new Error(`session artifact ${path}: trailing garbage in zstd frame at offset ${cursor}`)
			chunks.push(decoded.buffer)
			cursor = end
		}
		text = Buffer.concat(chunks).toString("utf8")
	} else {
		text = raw.toString("utf8")
	}
	const lines = text.split("\n")
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
	return lines
}

/**
 * 只读原档前缀：compressed 时读到第一个 zstd 帧边界（下一帧 magic 前）为止，
 * 否则读到首个换行为止。**不读整档、不切行数组、不解事件。**
 */
function readHeaderPrefix(path, compressed) {
	const fd = openSync(path, "r")
	try {
		let prefix = Buffer.alloc(0)
		const chunk = Buffer.allocUnsafe(HEADER_CHUNK)
		for (;;) {
			const read = readSync(fd, chunk, 0, HEADER_CHUNK, prefix.length)
			if (read <= 0) return prefix
			const piece = chunk.subarray(0, read)
			prefix = prefix.length === 0 ? Buffer.from(piece) : Buffer.concat([prefix, piece])
			if (prefix.length > HEADER_PREFIX_LIMIT) {
				throw new Error(`session artifact ${path}: header prefix exceeds ${HEADER_PREFIX_LIMIT} bytes`)
			}
			if (compressed && prefix.length >= ZSTD_MAGIC.length && !prefix.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
				throw new Error(`session artifact ${path}: unexpected bytes before the first zstd frame`)
			}
			const stop = compressed ? prefix.indexOf(ZSTD_MAGIC, ZSTD_MAGIC.length) : prefix.indexOf(0x0a)
			if (stop >= 0) return prefix.subarray(0, stop)
		}
	} finally {
		closeSync(fd)
	}
}

/** 从首个 zstd 帧（或纯文本前缀）取出 header 行文本；解出的帧必须恰好用尽所读字节，否则 fail-closed。 */
function decodeHeaderLine(path, compressed) {
	const prefix = readHeaderPrefix(path, compressed)
	if (prefix.length === 0) return ""
	if (!compressed) {
		const text = prefix.toString("utf8")
		const newline = text.indexOf("\n")
		return newline < 0 ? text : text.slice(0, newline)
	}
	if (prefix.length < ZSTD_MAGIC.length || !prefix.subarray(0, ZSTD_MAGIC.length).equals(ZSTD_MAGIC)) {
		throw new Error(`session artifact ${path}: unexpected bytes before the first zstd frame`)
	}
	const decoded = zstdDecompressSync(prefix, { info: true })
	if (decoded.engine.bytesWritten !== prefix.length) {
		throw new Error(`session artifact ${path}: truncated zstd header frame at offset 0`)
	}
	const text = decoded.buffer.toString("utf8")
	const newline = text.indexOf("\n")
	return newline < 0 ? text : text.slice(0, newline)
}

/**
 * header-only 只读观测（对齐官方 stat 语义：`stat` 只读代次 header，不读事件日志）。
 * 单一路径：构造官方 restore（`generationFormat.createRestore(headerLine, {recovery:"strict",
 * validation:"current"})`）并**只取其构造期 header** —— 官方 restore 对象在构造时就持有已解码/
 * 已迁移的 header（CurrentSessionFormatRestore.header = decoder.header；
 * MigratingSessionFormatRestore.header = migration.header），因此**无需也不得调用 decodeRow/finish**，
 * 正文（含关系校验）一律不触碰。现场真实 service 的 createRestore 在读到第一行事件之前都成功
 * （报错发生在 decodeRow）。
 * ⚠ 上面那对 options 只是**请求参数**：现场真实 generationFormat 的 createRestore 是
 * `(header) => catalog.createRestore(header, {recovery:"recoverable", validation:"transformed"})`，
 * 第 2 个参数被忽略、实际策略由运行时自定 ⇒ 本函数只声明请求，不声明实际恢复策略，也不据此
 * 宣称正文已被 strict/current 验证。运行时未暴露该入口即响亮拒绝（不留 readHeader 分支、不留兜底、
 * 不合成事件数组）。不迁移、不写回、不跳行：header 损坏或身份不符一律 fail-closed
 * （createRestore 自身抛错即透传）。
 */
export function readJsonlSessionHeader(path, compressed, expectedId, generationFormat) {
	const line = decodeHeaderLine(path, compressed).trim()
	if (line === "") throw new Error(`session artifact ${path}: empty log`)
	let headerLine
	try {
		headerLine = JSON.parse(line)
	} catch (error) {
		throw new Error(`session artifact ${path}: header line is not valid JSON (${error?.message ?? error})`)
	}
	if (headerLine === null || typeof headerLine !== "object" || Array.isArray(headerLine)) {
		throw new Error(`session artifact ${path}: header line is not a JSON object`)
	}
	if (headerLine.id !== expectedId) {
		throw new Error(`session artifact ${path}: stored session identity mismatch (expected ${JSON.stringify(String(expectedId))}, stored ${JSON.stringify(headerLine.id)})`)
	}
	if (typeof generationFormat?.createRestore !== "function") {
		throw new Error(`session artifact ${path}: generationFormat does not expose the official createRestore`)
	}
	const header = generationFormat.createRestore(headerLine, { recovery: "strict", validation: "current" })?.header
	if (header === null || typeof header !== "object" || Array.isArray(header)) {
		throw new Error(`session artifact ${path}: header-only read produced no session header`)
	}
	return { header }
}

/**
 * 解析一个 jsonl 会话日志 → { header, inheritedEventCount, events }。
 * 走原有的人工完整恢复路径（官方升级图 createRestore + 逐行 decodeRow + finish），行为与本轮
 * header-only 改动无关、也未改变。⚠ recovery/validation 的**实际**取值由运行时 generationFormat
 * 决定（现场接口只接受 header，第二个参数被忽略）；这里传的 strict/current 只是请求参数，
 * 不得据此宣称实际执行了 strict/current 校验。
 * 官方插件事件扩展保持原语义；结构或引用损坏一律拒绝，不跳行、不恢复、不合成事件。
 */
export function decodeJsonlSession(path, compressed, expectedId, generationFormat) {
	const lines = decodeLines(path, compressed)
	if (lines.length === 0) throw new Error(`session artifact ${path}: empty log`)
	const headerLine = JSON.parse(lines[0])
	if (headerLine.id !== expectedId) {
		throw new Error(`session artifact ${path}: stored session identity mismatch (expected ${JSON.stringify(String(expectedId))}, stored ${JSON.stringify(headerLine.id)})`)
	}
	const restore = generationFormat.createRestore(headerLine, { recovery: "strict", validation: "current" })
	const events = []
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "") continue
		restore.decodeRow(JSON.parse(lines[i]))
	}
	const artifact = restore.finish()
	events.push(...artifact.events)
	// seq 连续性（迁移对账的底线）
	for (let i = 0; i < events.length; i++) {
		if (events[i].seq !== i) {
			throw new Error(`session artifact ${path}: seq discontinuity at index ${i} (expected ${i}, got ${events[i].seq})`)
		}
	}
	return { header: artifact.header, inheritedEventCount: artifact.inheritedEventCount, events }
}

// noinspection JSUnusedGlobalSymbols
/** 兼容旧导出名称，但任何调用都零读写并响亮拒绝同 ID 导入。 */
export function migrateJsonlSession() {
	const error = new Error('禁止同ID迁移原档：请先创建官方原生分叉，再将新聊天保存到SQLite')
	error.code = 'DSH_TAVERN_EXPLICIT_FORK_REQUIRED'
	throw error
}
