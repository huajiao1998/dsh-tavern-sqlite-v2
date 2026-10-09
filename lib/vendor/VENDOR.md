# lib/vendor —— 运行时依赖（安装零外部依赖）

## 为什么放这里

本插件的四个解析器依赖（`lodash` / `yaml` / `json5` / `jsonrepair`）**不通过 npm 安装**，
而是随包携带。原因是 2026-10-06 在 Windows 桌面版酒馆上实测到的硬事实：

- 桌面版宿主用 Desktop 自带的 pnpm 11.8.0 装包，其 **store 与离线元数据缓存都不是默认位置**；
- pnpm 11 的 `store-dir` **只认 CLI flag**（桌面版 `dshmarket` 的 issue #244 明确记录：
  项目 `.npmrc`、用户 `.npmrc`、`pnpm-workspace.yaml` 全部无效），
  且 dsh CLI 会把参数拼成字符串交给 pnpm ⇒ 含空格的路径必须内嵌双引号；
- 即使 store 指对了，**`lodash` 等包的 registry 元数据在离线缓存里不存在**
  （作者自己的依赖用 `lodash-es`），离线解析直接 `ERR_PNPM_NO_OFFLINE_META` 失败。

只要 `package.json` 里声明这四个依赖，**离线安装在这类宿主上就不可能成功**。
把运行时依赖打进包内后，安装变成"零依赖"：任何宿主、任何网络条件都能装。

## 内容与版本

版本与 SHA256 台账见同目录 [manifest.json](<manifest.json>)；来源均为官方 registry
（`https://registry.npmmirror.com`，与官方 npm 同源分发的 tarball）。

| 包 | 版本 | 许可证 | 包内入口 | 体积 |
|---|---|---|---|---|
| lodash | 4.17.21 | MIT | `lodash/lodash.min.js` | 73 KB |
| json5 | 2.2.3 | MIT | `json5/index.mjs` | 46 KB |
| jsonrepair | 3.15.0 | MIT | `jsonrepair/esm/index.js` | 69 KB |
| yaml | 2.9.1 | ISC | `yaml/dist/index.js` | 287 KB |
| acorn | 8.15.0 | MIT | `acorn/acorn.mjs` | 229792 B |

Acorn 为注释接缝块的离线词法/结构解析器，复用工作区工具依赖中的官方单文件产物，随附 MIT 许可；不依赖用户酒馆的 node_modules，不联网补装。阶段③已纳入维护入口依赖完整性清单，版本与入口记入同目录台账。本阶段不运行发布用 SHA 增量检测。

- 各包 `LICENSE` / `LICENSE.md` 已随附（MIT / ISC 均要求保留版权与许可声明）。
- `yaml/dist` 已剔除 `*.d.ts`、`*.map` 与 `cli.mjs`；`jsonrepair/esm` 已剔除 sourcemap。
- `lodash/package.json`、`yaml/package.json` 里的 `{"type":"commonjs"}` 是**必需的**：
  本包是 `"type":"module"`，不加这个标记，这两个 CJS 产物会被当成 ESM 加载而报
  `does not provide an export named 'default'`。

## 维护约定

- 升级依赖须保留官方版本、入口与许可来源，开发时仅验证受影响调用。发布用摘要检测和发布前全量测试遵循项目规则，各自仅在获发布授权、输入冻结后执行一次，开发期不得提前运行。
  `deploy/maintenance/driver.mjs` 的 `assertPackageDependencies()` 在安装前核对
  “零运行时依赖 + 台账齐全 + 五个入口文件存在”，不符即拒绝安装。
- 不要在 `package.json` 里重新声明这四个依赖——那会让离线安装在桌面版宿主上重新失败。
