# 第三方组件说明

本文件区分当前实际使用的开发工具和未来计划集成的组件。本项目私有及保留权利的状态不改变第三方组件的独立许可。

## 当前开发工具

| 组件              | 用途          | 上游及许可证                                                 |
| ----------------- | ------------- | ------------------------------------------------------------ |
| Prettier          | 格式检查      | [上游](https://github.com/prettier/prettier)，MIT            |
| markdownlint-cli2 | Markdown 检查 | [上游](https://github.com/DavidAnson/markdownlint-cli2)，MIT |

完整实际依赖版本由 pnpm-lock.yaml 记录。发布分发物前需要核对直接和传递依赖的许可义务，本文不是完整依赖清单。

## 应用与验证组件

| 组件       | 计划用途             | 上游及许可证                                                |
| ---------- | -------------------- | ----------------------------------------------------------- |
| Electron   | 已使用：桌面运行时   | [上游](https://github.com/electron/electron)，MIT           |
| Vue        | 已使用：界面         | [上游](https://github.com/vuejs/core)，MIT                  |
| TypeScript | 已使用：开发语言工具 | [上游](https://github.com/microsoft/TypeScript)，Apache-2.0 |
| ssh2       | SSH 连接             | [上游](https://github.com/mscdex/ssh2)，MIT                 |
| xterm.js   | 内嵌终端             | [上游](https://github.com/xtermjs/xterm.js)，MIT            |
| Arthas     | JVM 诊断             | [上游](https://github.com/alibaba/arthas)，Apache-2.0       |

JumpServer 与 Docker 是目标环境中的外部系统，本仓库当前不分发它们。Arthas 缺包时由目标容器下载 Maven Central 官方4.0.5可执行启动JAR，APP不内置二进制；启动JAR锁定SHA-256。仅boot模式由官方启动器按固定4.0.5版本通过HTTPS下载/解压依赖，保留发行内容；APP不宣称验证了启动器内部下载的ZIP哈希。适用 [Arthas Apache-2.0 许可证](https://github.com/alibaba/arthas/blob/master/LICENSE)。离线再分发须自行保留完整的许可证及适用声明。

当前还使用 Zod（模型校验，MIT）、electron-vite/Vite（构建，MIT）、electron-builder（本地打包，MIT）、tsx（测试执行，MIT）及 playwright-core（桌面验证，Apache-2.0）。ssh2 与 xterm.js（含 addon-fit，MIT）已集成，Arthas 通过目标环境已有包或官方固定版本下载集成，APP 不分发其二进制。最终分发物的完整依赖许可须在正式发布前核对。
