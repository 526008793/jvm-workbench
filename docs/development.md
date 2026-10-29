# 开发指南

## 当前实现

0.2.0 已实现配置与多窗口、SSH/MFA/内嵌终端、JumpServer 人工选机确认、容器发现和实时日志。Arthas 自动诊断与凭据持久化尚未实现。

## 环境与启动

要求 Node.js 22.12 或更新的受支持版本、pnpm 10.28.1 和 Git。桌面冒烟及本机打包当前在 macOS 验证，Windows 尚未验收。

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm dev
```

如果 Node.js 发行方式没有附带 Corepack，先按 pnpm 官方方式准备包管理器。首次执行 Electron 时可能需要从官方分发源下载对应运行时。

## 命令

| 命令                | 作用                                                    |
| ------------------- | ------------------------------------------------------- |
| `pnpm dev`          | 启动 Electron/Vue 开发模式                              |
| `pnpm build`        | 构建主进程、preload 和渲染层到 out                      |
| `pnpm start`        | 启动构建后的 APP                                        |
| `pnpm typecheck`    | TypeScript 与 Vue 类型检查                              |
| `pnpm test`         | 配置、隔离、命令及本地 SSH/Docker 协议行为测试          |
| `pnpm test:remote`  | 实际 Electron 连接本地 SSH/MFA 服务，验证终端和双源日志 |
| `pnpm test:desktop` | 构建后验证真实 Electron 窗口与持久化                    |
| `pnpm package:mac`  | 生成本机测试用未签名 Mac APP                            |
| `pnpm format`       | 格式化代码和文档                                        |
| `pnpm check`        | 格式、Markdown、链接、类型、行为测试与构建              |

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

macOS 默认使用 ~/Library/Application Support/TraceLogDock/projects.json，当前不持久化登录秘密，另有 known-hosts.json 保存主机信任。开发隔离可以通过 TRACELOGDOCK_USER_DATA 指定专门目录。应用默认空项目，不写入演示服务器或模拟日志。

## 工程约定

主进程、preload 和渲染层保持边界，所有项目操作核对调用窗口所属项目。配置写操作在主进程排队，revision 防止旧版本覆盖；配置损坏时保留原文件并报告。

日志和状态展示与实际实现一致。远程执行接入后先绑定项目、环境和真实目标，不能通过全局 currentProject 推断。关键状态和错误需有注释及可追踪日志，不记录密码、OTP 或完整业务参数。

## 私有维护

项目仅由所有者维护，暂不开源，不开放 Issues 或外部贡献流程。提交围绕明确行为组织，功能修改同步文档与必要验证，不添加外部协作者或自动创建依赖更新 PR 的配置。

当前本机协议与界面流程已验证；后续仍需在授权测试目标验证真实 JumpServer 与 Docker，再接入 Arthas，见[验证计划](testing.md)。

## SSH 构建依赖

ssh2 的可选 cpu-features 原生检测模块不参与安装，使用已验证的 JavaScript 路径，避免在 Electron ABI 下编译仅用于优化选择的模块。此项由 pnpm.ignoredOptionalDependencies 明确记录，不能因此跳过主机身份或认证验证。
