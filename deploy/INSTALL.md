# V2 本地优先一键安装 / 卸载

> 本文是装卸协议，不承载开发进度或许可。仓库接续从[START](<../../../docs/START.md>)、[NOW](<../../../docs/NOW.md>)进入，显式确认[AGENTS](<../../../AGENTS.md>)并核Git；V1/V2状态与现装代看[共用台账](<../../../docs/workstreams/plugin/TASKS.md>)。V2仍本地未部署/未公开，命令存在不授权执行。

V2 的包名和独立仓库名均为 `dsh-tavern-sqlite-v2`。V2 保留服务端 MVU / 卡脚本 VM / ESM、SQLite 权威存储与干净回退；V1 仍使用作者浏览器执行。两版只能选一版，不能在同一实例同时安装。

## 支持范围与前提

- 复用 V1 的 macOS、Linux、WSL2 CLI 维护流程；已有作者 2.5.0（5d2ffacf已验；d5b2e6c4的[源码接缝/完整恢复副本](<../../../docs/workstreams/plugin/UPSTREAM-RETIRED-MVU-V2-FIX-2026-10-05.md>)已通过，实际CLI/页面未验）、DSH / boot 0.1.5-rc.2、Node.js 22.19+ 及 pnpm。不另装酒馆、Node、Python或宿主 peer。Desktop、未知源码布局或管理器不冒称支持。
- **无需手工预配 `--experimental-vm-modules`**：安装命令加 `--prepare-env`（仅 install），安装器自动把它补进 systemd 单元——备份原 unit 到维护证据目录、daemon-reload、按原方式重启复验、失败自动回滚，**安装完成后服务启动自带该参数**。同一开关还自动隔离旧代（V1 线）维护残留备份到维护证据目录（只移动不删除；无授权时列清单明确拒绝）。不加该开关维持默认：要求该参数已存在于启动命令，否则停服前明确拒绝（安装器默认不改动你的启动配置）；停止态指定 systemd 单元时也核原 ExecStart，纯停止态可离线安装但仍保持停止、未来启动须带该旗标。
- 装卸调用官方包管理，固定 `--offline --ignore-scripts --config.auto-install-peers=false`。V2 声明的 json5、jsonrepair、lodash、yaml 必须在既有离线依赖材料中可用；缺依赖明确失败并恢复，不偷偷联网、不另建依赖树镜像。下载本插件 tgz 与安装第三方依赖是两件事。
- 新包名不自动认领旧包或记录。已经安装旧名称或 V1 时，先用**其所属旧代安装器完整卸载**，保留旧包与恢复材料，再装 V2；新安装器写前拒绝共装或覆盖。

## GitHub 一键命令（仓库和正式 Release 发布后生效）

安装：

```sh
curl -fsSL https://raw.githubusercontent.com/huajiao1998/dsh-tavern-sqlite-v2/main/install.sh | sh
```

卸载：

```sh
curl -fsSL https://raw.githubusercontent.com/huajiao1998/dsh-tavern-sqlite-v2/main/install.sh | sh -s -- uninstall
```

仓库根 [install.sh](<../install.sh>) 是稳定入口，完整获取 latest 正式 Release 的安装 SH，再透传参数；下载失败或为空时不执行。正式 SH 固定同代 tgz 地址、版本与 SHA256。只上传 main 不发正式 Release，不会让上述命令安装新版。本轮仅生成本地文件，**未创建仓库、上传或验证远端 URL 可用**。

## 本地离线安装 / 卸载（现在可用）

在解压包的目录执行：

```sh
sh deploy/install.sh install --home /绝对路径/已有酒馆安装根目录
sh deploy/install.sh uninstall --home /绝对路径/已有酒馆安装根目录
```

只保留 Release SH 和 tgz 时：

```sh
sh install.sh install --home /绝对路径/已有酒馆安装根目录 --package ./dsh-tavern-sqlite-v2-0.1.2.tgz
sh install.sh uninstall --home /绝对路径/已有酒馆安装根目录
```

获取器按完整本地目录、显式 tgz、脚本旁/当前目录/缓存、已装包查找，只有缺包才下载固定附件。坏包直接拒绝，不联网替换；卸载使用本地所属代，不下载新版，未装时幂等返回。源码中的 [deploy/install.sh](<install.sh>) 不含可下载发行摘要，仅完整本地包可用；Release SH 必须由构建器生成。

自动识别仅看 `DSH_TAVERN_CLI_HOME`、`DSH_HOME`、当前目录和 `~/.dsh-tavern`，多个/找不到才要求 `--home`，不扫描磁盘或存档。`--port` 可核对原端口；`--systemd-unit xxx.service` 可明确既有单元。

## 运行状态与保护

原来运行：重核 PID / 代次 / cwd / home / 启动命令后精确停止，装卸成功或失败恢复都沿原方式恢复。原来停止：保持停止，不拉起。有限源码副本先预检和核恢复材料；不复制整个 profile / node_modules，不读取、复制、转换或删除存档和数据库，不自动迁移或代建新 ID 分叉。默认终端显示独立作业进度，终端中断后恢复继续；`--background` 返回作业结果路径，`--check` 只作预检、不装卸或停服。

包准备后共享 60 秒成功预算；超时走失败恢复，恢复可能超过预算，不能冒报成功。无需用户名、密码或 Cookie；只证明源码、装配、准确进程与 HTTP 基础可达。401/403/跳转不代表认证插件库存或页面正常，用户须登录刷新验收。跨平台真实停启、现场性能和玩法仍须实测，本地断言不代证。

## 独立仓库构建

在包根运行：

```sh
node scripts/build-release.mjs --out ./dist --repository huajiao1998/dsh-tavern-sqlite-v2
```

输出目录必须不存在；生成固定版本 tgz、Release 用 install.sh、SHA256SUMS 和 release.json。不上传、不覆盖旧产物，内部测试、旧维护夹具及运维 README 不入 tgz。正常发布递增 package.version；必要时 `--tag` 指定新 tag，不能覆盖已发布附件。公开前仍须完成对应源码整理、许可证和敏感扫描；不要直接上传包含运维历史的整个工作区。
