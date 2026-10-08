// 作者夹具的外部包桩加载器（**不安装任何包**）：固定 68215 作者的 domain 模块传递性 import 了本地未安装的
// `jsdom` / `marked` / `yaml`。此加载器为这些 specifier 返回**同一份**最小 data: URL 模块，
// 使真实 helper 模块可在测试进程内被 import，且**差分两侧用的是同一桩实现**（进程级 hook，不存在只给一侧）。
// scope：**仅测试进程**用于 import 固定作者夹具模块；不进产品运行路径、不进 deploy/发行包、不改变产品行为。
// 真实优先、桩兜底：chevrotain 是作者 MacroParser 的**真实解析器**，最小桩会把「真实业务 helper」验证变成假覆盖 ⇒
// 解析到**工作区已在盘的真实安装** tools/sql-test-kit/node_modules/chevrotain（v11.2.0，exports['.'].import = ./lib/src/api.js）；
// existsSync 探测入口，不 npm install/不下载/不改 fixture。仅当真实 API 不兼容时才回退最小桩（并在测试文件注明未覆盖）。
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKSPACE_ROOT = path.resolve(process.cwd(), '..', '..')
const REAL_PACKAGES = {
  chevrotain: ['tools/sql-test-kit/node_modules/chevrotain/lib/src/api.js']
}

function resolveRealPackage(specifier) {
  const candidates = REAL_PACKAGES[specifier]
  if (!candidates) return null
  for (const relative of candidates) {
    const absolute = path.resolve(WORKSPACE_ROOT, relative)
    if (existsSync(absolute)) return pathToFileURL(absolute).href
  }
  return null
}

const STUBS = {
  jsdom: 'export class JSDOM { constructor() { this.window = { document: { querySelectorAll: () => [], querySelector: () => null }, addEventListener: () => {} } } }\nexport default { JSDOM }\n',
  marked: 'function parse(value) { return String(value === undefined || value === null ? "" : value) }\nexport { parse }\nexport const marked = parse\nexport class Marked { parse(value) { return parse(value) } }\nexport default { parse, marked, Marked }\n',
  yaml: 'export function parse(value) { return {} }\nexport function stringify(value) { return "" }\nexport default { parse, stringify }\n'
}

export async function resolve(specifier, context, next) {
  const real = resolveRealPackage(specifier)
  if (real !== null) return { url: real, shortCircuit: true }
  const source = Object.prototype.hasOwnProperty.call(STUBS, specifier) ? STUBS[specifier] : null
  if (source !== null) return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true }
  return next(specifier, context)
}
