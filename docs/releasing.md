# 发布流程

## 当前状态

当前功能版本为0.3.20，提供本机Mac测试包与Windows x64 NSIS安装包构建入口；没有GitHub Release、正式代码签名或Apple公证发布流程。版本号及成功打包不代表目标平台的安装/运行已验收。

安装、升级及首次配置步骤见[Mac与Windows安装使用](installation.md)。

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

## GitHub Release

只有真实构建和验收通过后创建版本 tag 和 Release，附准确的产物清单、SHA-256 校验和、版本变化及限制。不自动将任意 main 提交发布给用户，首期也不实现自动更新服务。

当前 CI 验证文档、类型、行为测试和应用构建；签名发布流水线随正式发布条件加入。
