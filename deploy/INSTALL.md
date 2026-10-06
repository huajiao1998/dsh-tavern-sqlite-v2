# V2 一键安装 / 卸载

包名与独立仓库：`dsh-tavern-sqlite-v2`。V2 使用服务端 MVU / 卡脚本 VM / ESM 与 SQLite；V1 使用作者浏览器执行。两版不能在同一实例共装。

## 支持范围

- macOS、Linux、WSL2 CLI；已有作者 2.5.0（含 v2.5 重发布后的最新提交，实测至 `9e9b26d`）、DSH / boot 0.1.5-rc.2、Node.js 22.19+、pnpm。未知作者源码布局、Desktop 或未知管理器明确拒绝，不猜测覆盖。
- Windows 10 1803+：桌面版（Electron）与 Windows CLI 均用 `install.ps1`（见下节）；桌面版卡脚本 VM 在 Worker 线程执行，Linux/CLI 走原进程内路径，能力驱动自动分叉。
- 四个解析依赖 json5、jsonrepair、lodash、yaml 必须在已有离线材料中可用。下载本插件包不等于联网安装第三方依赖；官方包管理固定 `--offline --ignore-scripts --config.auto-install-peers=false`。
- V2 启动需要 `--experimental-vm-modules`。已有 systemd 单元可在 install 后加 `--prepare-env`，授权安装器备份并补上旗标、隔离旧维护备份，失败恢复；不加该选项时不改启动配置，缺旗标会在停服前拒绝。

## 公开一键命令

安装到已有酒馆目录：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- install --home /绝对路径/已有酒馆安装目录
```

卸载（保留原档和所有数据库）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall --home /绝对路径/已有酒馆安装目录
```

检查恢复材料，但不改源码、装配或服务状态：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall --check --home /绝对路径/已有酒馆安装目录
```

仓库根 `install.sh` 也会完整获取 latest 正式 Release SH 再执行；失败或空文件不执行。正式 SH 固定同代 tgz 地址、版本与 SHA256。

## Windows 一键装卸（0.2.3 起）

下载 Release 附件 `dsh-tavern-sqlite-v2-<版本>-win.zip`，解压到酒馆目录内任意一层（例如 `D:\Program Files (x86)\DSH-Tavern\`），进入解压出的 `dsh-tavern-sqlite-v2` 文件夹，右键 `install.ps1` →「使用 PowerShell 运行」进入菜单（安装 / 更新 / 卸载 / 只读预检）。也可命令行：

```powershell
.\install.ps1 install    # 安装（离线，用本包）
.\install.ps1 update     # 更新：联网校验官方 SHA256 后先卸旧再装新
.\install.ps1 uninstall  # 卸载（保留原档与数据库）
.\install.ps1 check      # 只读预检，可开着酒馆运行
```

- 桌面版安装/卸载前请从托盘**完全退出**酒馆；完成后重新启动生效。未装 Node.js 时，安装器可复用桌面版自带运行时（Electron RUN_AS_NODE）。
- `update` 仅下载官方 GitHub Release 资产并用 SHA256SUMS 核对，不索取任何凭据。
- Windows CLI 版需自行安装 Node.js 22+，并保证酒馆启动带 `--experimental-vm-modules`。
- 找不到酒馆时可用 `-TavernHome <目录>` 显式指定。

升级已有旧版：先执行上述 uninstall，再执行 install。获取器仅在本地包版本与发行版一致时复用本地包，否则下载固定发行附件作为执行器；可用新执行器卸载同一版本线的旧版。坏包拒绝，不猜测跨 V1/V2 迁移。未安装时 uninstall 幂等返回。

## 前像保护与旧记录自动恢复（0.2.1）

- 不再删除含接缝内容的备份后从当前缝合态重建；保留备份并明确报告。
- 标准记录缺失但核心接缝仍在时，不把当前入口捕获成新的“作者原文”。
- 旧版卸载恢复链失效时，自动查本包 `maintenance/dsh-tavern-sqlite-v2/` 下已有的安装前像，不扫描存档、Git 或其他实例。
- 候选必须是洁净安装前像，作者包身份匹配；在有限源码副本中重新施缝，**全部活动目标 JS 必须与当前源码逐字节相等**，并真实预演卸载成功，才可使用。不同候选产生不同卸载后像时拒绝猜测。
- 修复只更新可验证的 `before`，**不修改 `after` 校验哈希**；真实源码漂移仍拒绝。执行前保存当前材料与证明结果，同版 install 也可修复这类元数据，不停止或重启服务。
- `--check` 只写本次维护诊断副本，目标不改；结果会报告 `repairAvailable`。缺少或删除历史安装证据、候选不匹配、未知代际时仍安全拒绝，明确报“前像不可恢复”，不承诺修复任意外部篡改。

## 离线入口

完整解压包中执行：

```sh
sh deploy/install.sh install --home /绝对路径/已有酒馆安装目录
sh deploy/install.sh uninstall --home /绝对路径/已有酒馆安装目录
```

也可给正式 SH 指定本地包：`--package ./dsh-tavern-sqlite-v2-0.2.3.tgz`。源码 SH 不含发行摘要，不能单独用于联网下载；正式 SH 由构建器生成。

自动识别仅看 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前目录及 `~/.dsh-tavern`；多个目录或找不到时要求 `--home`，不扫描磁盘。`--port` 核对端口，`--systemd-unit` 指定已有单元。

## 服务、数据与验收

原来运行则按原管理方式恢复；原来停止则保持停止。停前重核 PID / 代次 / cwd / home / argv。维护不经迁移 launcher，不读取、复制、转换、删除存档或数据库，不代建新 ID 分叉。原档只读、用户手动新 ID 分叉原则不变。

包准备后共享 60 秒成功预算；超时保留失败原因并恢复原状态，不冒报成功。默认终端显示独立作业进度，终端断开后恢复继续；`--background` 返回证据目录。无需用户名、密码或 Cookie。

源码、装配、准确进程及 HTTP 基础健康不代表页面/玩法验收；用户须登录刷新确认。401/403/跳转只说明基础可达，性能和跨平台真实停启须另行实测。

## 独立发行构建

```sh
node scripts/build-release.mjs --out ./dist --repository huajiao1998/dsh-tavern-sqlite-v2
```

输出目录须不存在，生成 tgz、Windows zip（`-win.zip`，内含包体＋根 `install.ps1`，该副本带 UTF-8 BOM 分发例外）、固定版本 install.sh、SHA256SUMS（tgz＋zip）、release.json。不上传、不覆盖旧附件，不包含内部测试或运维资料。只有正式发布新 Release 后，公网 latest 才会取得新代。
