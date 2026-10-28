# 第三方组件说明

本文件区分当前实际使用的开发工具和未来计划集成的组件。根目录 Apache-2.0 许可证不改变第三方组件的独立许可。

## 当前开发工具

| 组件              | 用途          | 上游及许可证                                                 |
| ----------------- | ------------- | ------------------------------------------------------------ |
| Prettier          | 格式检查      | [上游](https://github.com/prettier/prettier)，MIT            |
| markdownlint-cli2 | Markdown 检查 | [上游](https://github.com/DavidAnson/markdownlint-cli2)，MIT |

完整实际依赖版本由 pnpm-lock.yaml 记录。发布分发物前需要核对直接和传递依赖的许可义务，本文不是完整依赖清单。

## 计划集成，当前未分发

| 组件       | 计划用途     | 上游及许可证                                                |
| ---------- | ------------ | ----------------------------------------------------------- |
| Electron   | 桌面运行时   | [上游](https://github.com/electron/electron)，MIT           |
| Vue        | 界面         | [上游](https://github.com/vuejs/core)，MIT                  |
| TypeScript | 开发语言工具 | [上游](https://github.com/microsoft/TypeScript)，Apache-2.0 |
| ssh2       | SSH 连接     | [上游](https://github.com/mscdex/ssh2)，MIT                 |
| xterm.js   | 内嵌终端     | [上游](https://github.com/xtermjs/xterm.js)，MIT            |
| Arthas     | JVM 诊断     | [上游](https://github.com/alibaba/arthas)，Apache-2.0       |

JumpServer 与 Docker 是目标环境中的外部系统，本仓库当前不分发它们。未来若配套分发 Arthas 包，应固定版本并保留其 LICENSE、NOTICE（若存在）及所需依赖声明；实现时更新此文档。
