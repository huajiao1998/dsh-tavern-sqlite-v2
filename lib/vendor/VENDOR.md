# lib/vendor —— 运行时依赖（安装零外部依赖）

## 为什么放这里

本包的运行时依赖（`yaml` / `acorn`）**不通过 npm 安装**，而是随包携带。原因是 2026-10-06
在 Windows 桌面版酒馆上实测到的硬事实：

- 桌面版宿主用 Desktop 自带的 pnpm 11.8.0 装包，其 **store 与离线元数据缓存都不是默认位置**；
- pnpm 11 的 `store-dir` **只认 CLI flag**（桌面版 `dshmarket` 的 issue #244 明确记录：
  项目 `.npmrc`、用户 `.npmrc`、`pnpm-workspace.yaml` 全部无效），
  且 dsh CLI 会把参数拼成字符串交给 pnpm ⇒ 含空格的路径必须内嵌双引号；
- 即使 store 指对了，**这些包的 registry 元数据在离线缓存里不存在**，离线解析直接
  `ERR_PNPM_NO_OFFLINE_META` 失败。

只要 `package.json` 里声明这些依赖，**离线安装在这类宿主上就不可能成功**。
把运行时依赖打进包内后，安装变成"零依赖"：任何宿主、任何网络条件都能装。

## 2026-10-15 计算重构后的范围收窄

计算（卡脚本/MVU/Helper）唯一由**上游服务端运行时**执行，本包不再自建计算实现，
因此计算专用解析器 `lodash` / `json5` / `jsonrepair` 连同自有计算源码一起退役，
不再作为安装门槛或台账条目。

剩余两组：

| 包 | 版本 | 许可证 | 包内入口 | 用途 |
|---|---|---|---|---|
| yaml | 2.9.1 | ISC | `yaml/dist/index.js` | 安装器 `parseDocument` / `YAMLSeq` |
| acorn | 8.15.0 | MIT | `acorn/acorn.mjs` | 注释接缝块 lexer（`deploy/comment-seam-blocks.mjs`） |

版本与 SHA256 台账见同目录 [manifest.json](<manifest.json>)；来源均为官方 registry
（`https://registry.npmmirror.com`，与官方 npm 同源分发的 tarball）。

- 各包 `LICENSE` 已随附（MIT / ISC 均要求保留版权与许可声明）。
- `yaml/package.json` 里的 `{"type":"commonjs"}` 是**必需的**：
  本包是 `"type":"module"`，不加这个标记，`yaml/dist/index.js` 会被当成 ESM 加载而报
  `does not provide an export named 'default'`。

## 维护约定

- 升级依赖须保留官方版本、入口与许可来源，开发时仅验证受影响调用。发布用摘要检测和发布前全量测试遵循项目规则，各自仅在获发布授权、输入冻结后执行一次，开发期不得提前运行。
  `deploy/maintenance/driver.mjs` 的 `assertPackageDependencies()` 在安装前核对
  “零运行时依赖 + 台账齐全 + 入口文件存在”，不符即拒绝安装。
- 不要在 `package.json` 里重新声明这些依赖——那会让离线安装在桌面版宿主上重新失败。
- 计算依赖不再回迁：上游服务端运行时自带给料，本包不复制算法，也不为兼容保留解析器。
