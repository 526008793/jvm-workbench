# 开发指南

## 当前可开发内容

目前仓库包含文档、示例、社区文件和文档 CI，没有 Electron/Vue 应用源码。不要使用尚不存在的 `pnpm dev` 或打包命令。后续添加应用骨架时同步更新本指南和锁文件。

## 环境

- Node.js 22 或更新的受支持版本；`.nvmrc` 指向首期 CI 基线 22。
- pnpm 10.28.1，由 package.json 的 packageManager 固定。
- Git。

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm check
```

若 Node.js 发行方式没有附带 Corepack，按 pnpm 官方方式先安装包管理器。当前依赖只用于文档质量检查，不会安装 Electron 或启动远程连接。

## 命令

| 命令                | 作用                                   |
| ------------------- | -------------------------------------- |
| `pnpm format`       | 格式化受支持文件                       |
| `pnpm format:check` | 检查格式                               |
| `pnpm lint:docs`    | 检查 Markdown                          |
| `pnpm check:links`  | 检查受版本管理的 Markdown 相对文件链接 |
| `pnpm check`        | 按顺序运行全部检查                     |

相对链接检查验证本地文件目标，不抓取外站，也不验证标题锚点。外部地址和 Mermaid 渲染由评审及 GitHub 页面复核。不要把有限的本地链接检查描述为完整网站可用性检查。

## 当前目录

```text
.github/      Issue、PR 模板和 CI
  workflows/
docs/         产品、架构、开发和集成说明
  adr/        架构决策记录
examples/     虚构配置
scripts/      仓库文档检查脚本
```

未来源码布局见[架构说明](architecture.md)。会话临时记录和真实服务器配置不放进公开仓库。

## 工程约定

- TypeScript 为后续应用实现语言，主进程、preload 和渲染层保持明确边界。
- 功能、文档和验证范围保持一致；未验证能力标记为待验证。
- 远程执行先绑定项目、环境和真实目标，再下发命令。
- 代码日志记录任务状态和错误原因，不记录秘密或完整业务参数。
- 依赖更新同步锁文件，不引入与当前交付无关的大量运行时包。

## 调试顺序

先在授权测试目标验证直连 SSH 与 JumpServer，再加入 Docker 日志和 Arthas。使用脱敏会话样本调试解析，不以生产资产列表作为测试夹具。具体矩阵见[验证计划](testing.md)。
