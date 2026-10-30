# 发布流程

## 当前状态

0.3.20通过GitHub Release提供Mac arm64 DMG和Windows x64 NSIS安装向导。两平台分别在GitHub原生runner构建和检查，全部通过后才发布预览版附件。仓库保持私有，下载需要有仓库权限；没有自动更新服务或Apple公证/Windows发布者签名。

普通用户直接阅读[下载与安装](installation.md)，无需克隆源码或安装构建环境。

## 云端构建与发布

1. 更新`package.json`版本、`CHANGELOG.md`及`docs/releases/v<版本>.md`迭代说明，并同步README和安装指南的下载版本。
2. 检查并推送代码。在GitHub Actions选择 **Build installers and publish → Run workflow**，选择目标分支。
3. Mac任务使用`macos-15` arm64 runner，运行完整检查、生成DMG、挂载复制APP、核对签名/架构/版本并运行隔离界面回归。
4. Windows任务使用`windows-2025` x64 runner，运行完整检查、生成NSIS、实际安装、核对架构/版本、运行隔离界面回归并卸载。
5. 两个平台都成功后，发布任务收集两个安装包，生成`SHA256SUMS.txt`，将安装包作为Release附件上传。上传完成前保持草稿，随后发布同版本tag的预览版。

源码目录不保存安装包。Actions中间附件保留7天，已发布Release附件不受此临时保留时间影响。工作流仅手动触发，不会因每次推送main而自动发布；同一版本不自动覆盖已有Release，迭代时应更新版本号。

当前版本下载入口为[Release v0.3.20](https://github.com/526008793/tracelogdock/releases/tag/v0.3.20)。发布流程见`.github/workflows/release.yml`，本地Windows交叉打包不属于该流程。

## 应用发布前

1. 确认待发布版本的真实功能与已验证环境，更新 README、路线图和更新日志。
2. 锁定运行时依赖及 Arthas 配套版本，检查第三方 LICENSE/NOTICE 和校验信息。
3. 完成对应平台构建、安装、启动、卸载及核心接入验证。
4. 确认构建物不含开发配置、真实地址、日志、凭据或调试秘密。
5. 将平台、芯片架构、最低系统要求、已知限制和升级方式写入发布说明。

## macOS

当前使用 electron-builder，运行 `pnpm package:mac` 输出 dist/mac-arm64/TraceLogDock.app（本机 arm64 构建）。mac.identity 为 "-"，生成完整 ad-hoc 签名的本机测试包，hardenedRuntime=false。不能设为 null 后直接沿用 Electron 的链接签名：旧包的代码身份仍是 Electron，Info.plist 未绑定且严格签名验证失败，曾导致正常启动时的内网访问被拦截。最低系统版本、arm64/x64 支持和产物格式必须由实际构建验证后确定。正式面向普通用户的发布需要准备 Apple Developer 签名和公证，相关凭据只保存在受保护的构建环境中。

ad-hoc 测试签名不代表 Apple Developer 签名或公证，不能把它描述为正式安装包。需要人工确认的系统安全提示由用户自行判断，不在工具中自动绕过。

## Windows

构建目标为Windows 10/11 x64，使用NSIS安装向导，可选安装目录并创建桌面/开始菜单快捷方式。保持当前功能版本0.3.20；不需要把Mac的.app复制到Windows。

在Windows上准备Node.js 22.12+及pnpm 10.28.1，在项目根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm package:win
```

输出`dist/windows/TraceLogDock-Setup-0.3.20-x64.exe`，后续文件名随package.json版本变化。把该exe复制到Windows后双击安装；安装后的用户无需另外安装Node.js、pnpm或本地Java，Arthas使用远端容器的JVM。构建命令包含`--publish never`，只在本地生成，不自动上传Release。

配置由Electron userData保存，Windows默认位于`%APPDATA%/TraceLogDock`；密码和AI密钥仍由本机系统安全存储加密。不要将Mac加密凭据文件复制到Windows当作可用密码，两个系统的加密上下文不同。

Windows安装包按本指南在Windows环境构建；当前不提供已验证的Mac交叉构建流程。Windows实机还需验证安装/卸载、启动、配置保存、记住密码、SSH/MFA/终端、日志与诊断。未配置Windows代码签名证书时，安装程序没有已验证发布者，不能把它描述为已签名正式发布。

## 验证与签名范围

平台安装验证脚本分别为`scripts/verify-mac-installer.sh`和`scripts/verify-windows-installer.ps1`。APP回归只使用临时项目、本机SSH/模型fixture；不连接真实服务器，不读取用户已有凭据。Windows行为测试会跳过仅针对POSIX shell的用例。

GitHub原生构建验证不代替客户环境的JumpServer策略、Docker镜像、Arthas权限或全部桌面系统版本验收。Mac ad-hoc签名和Windows无发布者签名须在Release说明中保留，不能描述为已公证/签名的正式发行版。
