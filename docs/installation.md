# Mac 与 Windows 安装使用

当前版本为 **0.3.20预览版**。使用APP不需要下载源码，也不需要Node.js、pnpm或本地Java。

## 直接下载

在[GitHub Release](https://github.com/526008793/tracelogdock/releases/tag/v0.3.20)选择对应附件，也可直接点击：

| 系统                       | 下载                                                                                                                                       | 安装方式                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Mac Apple Silicon（M系列） | [TraceLogDock-0.3.20-mac-arm64.dmg](https://github.com/526008793/tracelogdock/releases/download/v0.3.20/TraceLogDock-0.3.20-mac-arm64.dmg) | 打开DMG，把APP拖到“应用程序” |
| Windows x64                | [TraceLogDock-Setup-0.3.20-x64.exe](https://github.com/526008793/tracelogdock/releases/download/v0.3.20/TraceLogDock-Setup-0.3.20-x64.exe) | 双击并按安装向导操作         |
| SHA-256校验值              | [SHA256SUMS.txt](https://github.com/526008793/tracelogdock/releases/download/v0.3.20/SHA256SUMS.txt)                                       | 核对下载文件完整性           |

仓库保持私有，下载需要登录有该仓库访问权限的GitHub账号。Mac包不适用于Intel芯片；Windows包为x64。发布流程在原生Mac/Windows runner上完成构建、安装包核对和隔离APP回归后才上传附件；真实业务服务器及所有客户端系统版本仍需按实际环境核对。

安装包存放在Release附件，源码仓库不提交构建目录、用户配置和运行日志。只有维护者自行构建时才需要下面的开发环境；普通使用者可直接跳到安装步骤或首次配置。

## 获取源码与构建环境

构建需要 Git、Node.js 22.12+ 和 pnpm 10.28.1。使用有该私有仓库权限的账号获取代码：

```bash
git clone https://github.com/526008793/tracelogdock.git
cd tracelogdock
```

已有工作副本时，先保存本地修改，再同步仓库代码。pnpm 准备方法见[开发指南](development.md)。下面的打包命令只构建本地产物，不创建 GitHub Release。

## Mac：安装与自行构建

当前已验证 Apple Silicon；Intel Mac 和其他系统版本需要分别构建、验收，不能直接使用 arm64 包。

在 Mac 的项目根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm package:mac
```

`pnpm package:mac`产物为`dist/mac-arm64/TraceLogDock.app`；维护者需要DMG时运行`pnpm package:mac:installer`，输出`dist/release/TraceLogDock-0.3.20-mac-arm64.dmg`。直接下载的DMG无需执行构建命令。

1. 如果正在使用旧版，先用 `⌘Q` 完全退出。
2. 下载用户双击DMG；自行构建用户在Finder打开`dist/mac-arm64`。把其中的`TraceLogDock.app`拖到“应用程序”。
3. 从“应用程序”打开 TraceLogDock，也可添加到 Dock。
4. 如系统提示来源或首次打开确认，先核对安装文件来源，再通过系统提供的允许打开入口处理。

当前为本机 ad-hoc 签名，尚无 Apple Developer 签名与公证。构建保留完整签名及本地网络用途声明；不要自行改为不签名、移除签名或关闭系统安全机制。

首次连接内网时，允许 APP 的本地网络访问；如连接被系统阻止，到“系统设置 → 隐私与安全性 → 本地网络”检查 TraceLogDock。升级后访问已保存密码时，系统可能再次显示 TraceLogDock Safe Storage 钥匙串授权窗口，应在系统窗口处理。

## Windows：安装与自行构建

在 Windows 10/11 x64 的项目根目录打开 PowerShell，执行：

```powershell
pnpm install --frozen-lockfile
pnpm package:win
```

产物为 `dist/windows/TraceLogDock-Setup-0.3.20-x64.exe`，文件名中的版本会跟随 `package.json` 更新。`win-unpacked` 是构建中间目录，分发安装时使用 Setup exe。

1. 退出旧版 TraceLogDock。
2. 双击 Setup exe，按安装向导选择安装目录。
3. 完成后通过桌面或开始菜单的 TraceLogDock 快捷方式启动。
4. 如需卸载，在 Windows 设置的“应用”中找到 TraceLogDock 并卸载。

当前未配置 Windows 发布者代码签名证书，系统可能显示未知发布者；应核对文件来源。发布流程会在原生Windows runner安装NSIS、运行隔离APP回归并卸载；这不等于Windows 10/11所有系统版本和真实服务器环境均已验收。

Windows 安装包应在 Windows 环境构建。当前不提供已验证的 Apple Silicon 交叉构建流程，也不要求在 Mac 上准备 Wine、Rosetta 或 Windows 虚拟机。

## 首次配置服务器和服务

1. 首次启动进入项目管理，新建项目和环境，再打开项目工作区。以后启动会恢复最近项目。
2. 工作区默认进入左侧第一项“服务器配置”，添加 SSH 或 JumpServer 的地址、端口、账号和目标资产信息。
3. 点击“连接”，输入密码或选择私钥，核对首次主机指纹；MFA 按服务器提示完成。可选择在本设备记住密码，不保存动态验证码。
4. JumpServer 需在内嵌终端完成选机，点击“确认已进入目标服务器”并核对主机名。
5. 点击 SERVICES 右侧“＋”创建服务。在服务器配置页点击“发现容器”并关联当前服务，或编辑服务手动填写服务器与容器映射。
6. 不同服务器分别配置目标连接。同一堡垒机账号可使用“复用登录”建立独立目标终端，分别选机确认；原终端不要退出后再换成另一台服务器。

SERVICES 每行有编辑和删除按钮。编辑可修改名称、服务器与容器映射；删除当前服务会切换剩余服务，删除最后一个显示空状态。容器发现列表可以关闭，再次展开会复用当前结果。

## 查看日志

进入“服务日志”，选择服务与实例，选择日志范围后点击“开始日志”。APP 自动执行命令，无需复制到终端。

- 未开启合并时单选一个实例；开启“合并查看本环境服务日志”后允许多选，并显示本环境已订阅服务的输出。
- 支持只看新日志、最近 N 行、最近一段时间、自定义开始/结束时间。日期按本机时区选择，发送时转换为 UTC；结束时间留空持续跟随，填写则查询固定时间段后结束。
- 切换服务或菜单保留后台任务。“暂停显示”只冻结画面，“停止日志”才请求结束对应日志命令；合并视图可停止全部服务日志。
- 日志框随窗口高度扩展，最低 480px；SQL 和 Java 异常的多行内容尽量作为整条记录显示。

界面只保留本环境最近 2000 条显示记录，关闭或重载后不会作为本地日志文件保留。需要历史内容时，以 Docker 日志驱动或已有日志平台的保留范围为准。详细操作见[使用流程](usage.md)和[Docker 日志](docker-logs.md)。

## 方法诊断与 AI

1. 选择服务，进入“方法诊断 → 接入 JVM”，发现 Java 进程并接入 Arthas；容器缺包时按页面提示准备官方固定版本工具。
2. 搜索 Controller 等同步入口方法。默认“深入追踪（单次请求）”无需先逐层填下游方法；启动后等待增强完成，再触发一次待观察的业务请求。
3. 在“诊断结果”查看慢点与本地建议。按需查看任务原 JVM 的运行反编译源码；读取源码不会再次执行该业务请求。
4. 如需 AI，在独立“AI 配置”页选择源码来源，填写模型地址、模型名和可选 Key，保存并测试连通性，再分析诊断结果。未启用 AI 仍有本地规则建议。

反编译代码不保证原始注释或行号，采样结果也不等于精确方法计时；AI 与本地建议均需结合证据核对。接入条件见[Arthas 诊断](arthas.md)，源码与模型说明见[AI 分析](ai-analysis.md)。

## 升级与本地数据

| 平台    | 默认用户数据目录                             |
| ------- | -------------------------------------------- |
| Mac     | `~/Library/Application Support/TraceLogDock` |
| Windows | `%APPDATA%\TraceLogDock`                     |

项目配置、主机信任及加密凭据保存在用户数据目录，和 APP 安装目录分开。升级前先退出旧版，再替换 Mac APP 或运行新的 Windows 安装向导；同一系统用户通常可沿用已有配置。

备份应在 APP 退出后进行。Mac 与 Windows 的安全存储不通用，不能通过复制加密凭据文件实现跨系统免密登录；在新设备或系统上重新填写密码和 AI Key。更多配置说明见[配置文档](configuration.md)。
