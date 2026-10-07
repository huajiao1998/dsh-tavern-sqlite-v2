# V2 一键安装 / 卸载

包名与独立仓库：`dsh-tavern-sqlite-v2`。V2 使用服务端 MVU / 卡脚本 VM / ESM 与 SQLite；V1 使用作者浏览器执行。两版不能在同一实例共装。

## 支持范围

- macOS、Linux、WSL2 CLI；已有作者 2.5.0（接缝与维护检查复核至 `8480f7de`）、DSH / boot 0.1.5-rc.2、Node.js 22.19+、pnpm。未知作者源码布局或未知管理器明确拒绝，不猜测覆盖。
- Windows 10 1803+：支持桌面版（Electron）的 `install.ps1`；原生 Windows CLI 的服务生命周期尚未接线，不冒称支持。桌面版卡脚本 VM 在 Worker 线程执行，Linux/CLI 走原进程内路径，能力驱动自动分叉。
- 四个解析器 json5、jsonrepair、lodash、yaml 已vendor到包内，零运行时npm依赖，不要求桌面宿主的离线元数据缓存另有四包。安装包管理仍固定 `--offline --ignore-scripts --config.auto-install-peers=false`；兜底卸载不依赖旧包解析器/包管理。
- V2 启动需要 `--experimental-vm-modules`。已有 systemd 单元可在 install 后加 `--prepare-env`，授权安装器备份并补上旗标、隔离旧维护备份，失败恢复；不加该选项时不改启动配置，缺旗标会在停服前拒绝。

## 公开一键命令

安装到已有酒馆（默认自动识别目录，无需手填路径）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- install
```

卸载（保留原档和所有数据库）：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall
```

检查恢复材料，但不改源码、装配或服务状态：

```sh
curl -fsSL https://github.com/huajiao1998/dsh-tavern-sqlite-v2/releases/latest/download/install.sh | sh -s -- uninstall --check
```

**目录默认自动识别**：检查 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前工作目录和 `~/.dsh-tavern` 下的已有 tavern profile。找到唯一目标就直接继续；只有未找到或多个实例时才提示用 `--home` 指定目标，不把手填路径作为正常安装步骤，也不扫描全盘猜目录。自定义位置若不在这些候选中，需从酒馆 home 工作目录执行或按提示选择。

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
- **Windows 推荐双击 `run-install.cmd`**（0.2.7 起随包提供）：它绕过执行策略、把全部输出（含 PowerShell 解析错误）写进同目录 `install.log`，并且结束时总是暂停——双击不会闪退。也可继续右键 `install.ps1` 运行。
- 0.2.7起，安装器日志**进入脚本就立即打开**（不再等跑到维护步骤）：没找到酒馆/Node、参数不合法这类早期失败同样会留下日志。日志固定为脚本同目录 `install.log`（每次覆盖），不是酒馆维护证据，不读取存档；脚本目录不可写时改放 `%TEMP%\dsh-tavern-install.log` 并在窗口里告知。等待条件不再依赖宿主类型：只要还连着控制台，除 `-Yes` 外一律停住等你看（点窗口叉或输入0才是正常退出）。
- **安装阶段产物只落插件包目录**：`install.log` 与 `result.json`（维护入口通过 `--report-dir` 写的用户可见结果）都在 `install.ps1` 同目录；报错时把这两个文件发给维护者即可，不必去翻酒馆 `maintenance` 目录。酒馆维护目录只保留安装期内部证据材料（预演副本、单元备份等）。
- “现装不同代”指插件包差异，不是酒馆版本不匹配；安装仍不盲目覆盖不同代。新卸载实现会处理可证明的升级覆盖/半装残留，0.2.9新增兜底能力见下节。

升级已有旧版：先卸旧，再安装新包。获取器只在本地完整包与发行版同代时复用，否则下载固定新发行附件。坏现装包不可当执行器，但不再据此拒绝残留卸载；使用完整新包。没有装配且源码已确认卸净才是幂等，不以“没看到包”早退。不跨V1/V2认领。

## 双平台兜底卸载（0.2.9）

Windows 的 `install.ps1 uninstall` / 菜单 3 和 Linux 一键命令的 `uninstall` 使用同一个维护实现，不需要额外“强制”参数；0.2.9 起生效。请下载新包，不要继续用旧安装器卸载。

- 安装中断、依赖/bundle/链接不齐、旧插件包损坏或版本不同，都不再以“必须先有完整安装”为卸载前提；不调用损坏旧包、不要求旧包 vendor/peer/VM 能力、不依赖 pnpm remove。
- 作者升级已覆盖的文件，只有与随包可信官方源码逐字节匹配才原样保留；不能仅凭无标记放行。
- 仍有本插件接缝或中断写入的文件，以准确作者发布提交对应的可信有限官方源码恢复。污染 before、旧备份不当恢复权威，不改 after 哈希冒充一致。
- 本插件新建模块、四份接缝记录及确切自有源码备份保留恢复前像后清理；装配只摘本包依赖/bundle与本包链接/安装目录，包代码归档，不递归删除共享 node_modules。
- 修改前逐字节复核并保存本次源码/装配前像；失败尝试恢复两者，不以部分撤除冒报卸净。`uninstall --check` 只读列计划。
- 没有对应可信官方原像、文件归属无法确认、另一产品线或路径/符号链接越界时，保留现场并明确报缺什么材料，**不靠删除酒馆目录或存档解决**。
- 原件独立启动保护仍保留，卸载不触发原档自动迁移，不把 SQLite 分叉转换回作者文件式存档。数据保留不等于卸载后 SQLite 分叉可直接由原版游玩。

恢复资产覆盖已审查的四棵作者 2.5.0 树；这是卸载恢复材料，不是安装 SHA 白名单。新作者发布需更新可信材料后验证，不能声称已支持任意未来布局/外部篡改。

## 前像保护与旧记录自动恢复（0.2.1，历史正常路径说明）

- 不再删除含接缝内容的备份后从当前缝合态重建；保留备份并明确报告。
- 标准记录缺失但核心接缝仍在时，不把当前入口捕获成新的“作者原文”。
- 旧版卸载恢复链失效时，自动查本包 `maintenance/dsh-tavern-sqlite-v2/` 下已有的安装前像，不扫描存档、Git 或其他实例。
- 候选必须是洁净安装前像，作者包身份匹配；在有限源码副本中重新施缝，**全部活动目标 JS 必须与当前源码逐字节相等**，并真实预演卸载成功，才可使用。不同候选产生不同卸载后像时拒绝猜测。
- 修复只更新可验证的 `before`，**不修改 `after` 校验哈希**；真实源码漂移仍拒绝。执行前保存当前材料与证明结果，同版 install 也可修复这类元数据，不停止或重启服务。
- `--check` 只写本次维护诊断副本，目标不改；结果会报告 `repairAvailable`。缺少或删除历史安装证据、候选不匹配、未知代际时仍安全拒绝，明确报“前像不可恢复”，不承诺修复任意外部篡改。

## 离线入口

完整解压包中执行：

```sh
sh deploy/install.sh install
sh deploy/install.sh uninstall
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
