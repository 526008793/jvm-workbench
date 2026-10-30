# 开发指南

## 当前实现

0.3.20已实现项目工作区、SSH/MFA/内嵌终端、目标认证复用、多实例日志、Arthas单次深入诊断、运行源码与可选AI分析；Mac已验证，Windows提供NSIS构建入口。安装步骤见[安装指南](installation.md)。

## 环境与启动

要求 Node.js 22.12 或更新的受支持版本、pnpm 10.28.1 和 Git。非Windows行为测试另需Python 3，用于隔离的真实PTY回归，桌面APP运行不依赖Python。桌面冒烟当前在macOS验证；已有Windows x64安装包构建入口，GitHub原生runner的安装/APP验证由发布流程执行，详见[发布流程](releasing.md)。

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm dev
```

如果 Node.js 发行方式没有附带 Corepack，先按 pnpm 官方方式准备包管理器。首次执行 Electron 时可能需要从官方分发源下载对应运行时。

## 命令

| 命令                         | 作用                                                    |
| ---------------------------- | ------------------------------------------------------- |
| `pnpm dev`                   | 启动 Electron/Vue 开发模式                              |
| `pnpm build`                 | 构建主进程、preload 和渲染层到 out                      |
| `pnpm start`                 | 启动构建后的 APP                                        |
| `pnpm typecheck`             | TypeScript 与 Vue 类型检查                              |
| `pnpm test`                  | 配置、隔离、命令及本地 SSH/Docker 协议行为测试          |
| `pnpm test:remote`           | 实际 Electron 连接本地 SSH/MFA 服务，验证终端和双源日志 |
| `pnpm test:desktop`          | 构建后验证真实 Electron 窗口与持久化                    |
| `pnpm package:mac:installer` | 生成Mac arm64 DMG到dist/release                         |
| `pnpm package:mac`           | 生成本机 ad-hoc 签名 Mac 测试 APP                       |
| `pnpm package:win`           | 生成Windows x64 NSIS安装向导到dist/windows，不自动发布  |
| `pnpm format`                | 格式化代码和文档                                        |
| `pnpm check`                 | 格式、Markdown、链接、类型、行为测试与构建              |

相对链接检查只验证本地文件，不抓取外站或验证标题锚点。桌面冒烟使用虚构项目和临时目录，远程冒烟仅连接本机隔离 SSH 服务，不连接生产；截图位于 output/playwright，不提交版本库。

## 当前目录

```text
src/main/        窗口、IPC、配置存储与上下文归属
src/preload/     渲染层可调用的有限业务接口
src/renderer/    Vue 页面与样式
src/shared/      模型、通道名与命令模板
tests/          配置、命令和隔离行为验证
scripts/        文档检查与桌面冒烟
docs/           架构、开发及接入设计
```

## 配置位置

macOS 默认使用 ~/Library/Application Support/TraceLogDock/projects.json，passwords.json仅保存用户选择记住的系统加密密码，另有known-hosts.json保存主机信任。开发隔离可以通过 TRACELOGDOCK_USER_DATA 指定专门目录。应用默认空项目，不写入演示服务器或模拟日志。

## 工程约定

主进程、preload 和渲染层保持边界，所有项目操作核对调用窗口所属项目。配置写操作在主进程排队，revision 防止旧版本覆盖；配置损坏时保留原文件并报告。

日志和状态展示与实际实现一致。远程执行接入后先绑定项目、环境和真实目标，不能通过全局 currentProject 推断。关键状态和错误需有注释及可追踪日志，不记录密码、OTP 或完整业务参数。

## 私有维护

项目仅由所有者维护，暂不开源，不开放 Issues 或外部贡献流程。提交围绕明确行为组织，功能修改同步文档与必要验证，不添加外部协作者或自动创建依赖更新 PR 的配置。

当前本机协议与界面流程已验证；后续仍需在授权测试目标验证真实 JumpServer 与 Docker，以及真实 JVM attach，见[验证计划](testing.md)。

## SSH 构建依赖

ssh2 的可选 cpu-features 原生检测模块不参与安装，使用已验证的 JavaScript 路径，避免在 Electron ABI 下编译仅用于优化选择的模块。此项由 pnpm.ignoredOptionalDependencies 明确记录，不能因此跳过主机身份或认证验证。

Arthas 协议行为见 tests/arthas.test.ts；`pnpm test:arthas` 在实际 Electron 中验证缺包安装与已有包复用的诊断流程，使用隔离 SSH/Arthas 响应，不代表真实增强验收。

`pnpm test:passwords`使用实际Electron safeStorage验证记住、重启后使用、MFA与忘记密码。验证优先针对最终签名APP执行，避免开发Electron与产品APP共享钥匙串服务时产生身份差异；仅使用虚构密码和临时profile，不读取真实已保存凭据。

本机ad-hoc包升级后，macOS可能因代码身份变化要求重新允许访问TraceLogDock Safe Storage。此原生钥匙串弹窗会阻塞同步safeStorage调用，进而阻塞桌面自动化；需要用户在系统窗口处理，随后重跑测试，不能静默修改钥匙串权限或把超时当作验证通过。
