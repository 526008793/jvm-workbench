# Arthas 方法诊断

## 接入前提

Arthas 必须加载到目标 JVM，不能仅凭远程方法名工作。首期在 Docker 场景通过已授权的目标会话执行 `docker exec`，定位 Java 进程并启动或连接固定版本 Arthas。

不默认 Java PID 为 1，也不默认镜像具备 JDK attach 能力、可写目录或外网访问。需验证 JVM 用户、启动参数、镜像和实际 Java 版本。

工具包可以镜像预置，或由 APP 配套提供并通过允许的文件渠道分发。配套分发必须锁定版本、校验来源与完整性，并保留第三方许可证。当前仓库没有包含 Arthas 二进制包或自动上传实现。

## 方法搜索

输入方法名或 `ClassName#methodName`，在选定实例的已加载业务类中搜索。候选展示完整类名、签名、ClassLoader 和实例来源。

同名方法、类未加载以及不同节点运行不同版本必须如实说明。选择某个重载签名不代表 Arthas 命令天然只增强该重载，应按实际命令能力显示匹配范围。

## 快捷模板

CLASS 和 METHOD 为占位符，选择候选后再生成真实命令。

| 入口         | 示例                                                   |
| ------------ | ------------------------------------------------------ |
| 慢调用       | `trace CLASS METHOD '#cost > 200' -n 5`                |
| 参数与返回值 | `watch CLASS METHOD '{params,returnObj}' -s -x 2 -n 5` |
| 异常调用     | `watch CLASS METHOD '{params,throwExp}' -e -x 2 -n 5`  |
| 是否进入     | `watch CLASS METHOD 'params' -b -x 1 -n 5`             |
| 调用统计     | `monitor -c 5 CLASS METHOD`                            |
| 调用来源     | `stack CLASS METHOD -n 5`                              |
| JVM 概况     | `dashboard`                                            |
| 繁忙线程     | `thread -n 5`                                          |
| 阻塞线程     | `thread -b`                                            |

monitor 的 `-c` 是统计周期，ClassLoader 使用 `--classloader`；trace/watch 的 `-c` 语义不同，不能采用统一参数拼接。参数和返回值观察应按需选择字段，不默认持久化完整业务对象。

## 多实例执行

每个实例先核对真实容器、JVM 和方法，再单独提交任务。界面区分已提交、增强完成、等待调用、已有结果和失败，不能把一个节点成功展示为全部节点成功。

trace 主要输出当前增强方法的一层直接调用耗时，可继续诊断慢的下一层方法。异步线程和跨 RPC 不会自动形成完整链路；未采集的历史调用无法事后补出。

## 数据通道

优先验证现有 SSH/PTY 和官方客户端的文本输出，先保证可用。若 agent HTTP API 实际可达，可使用结构化结果。

SSH 端口转发到宿主机不等于能访问容器内的 127.0.0.1。需要验证真实网络路径，不能默认开放新公网端口。Tunnel 是已加载 agent 的连接转发，不是 attach 工具，也不能直接假定它代理任意 HTTP API。

## 停止与异常

HTTP API 长任务使用 `init_session → async_exec → pull_results`，停止用 `interrupt_job`，最后 `close_session`。终端通道按实际客户端验证中断行为。

不使用全局 `stop` 或 `reset` 假装停止当前任务，以免影响其他连接。Starter 默认禁用 stop 的行为也需要纳入兼容验证。

`-n` 是采集次数条件，不是无调用超时。工具侧任务结束时间仍需要发送中断；APP 被强杀时，本地计时器不会继续工作。未实现并验证远端终止机制时，掉线只能显示未知状态并在重连后核对，不能宣称一定已停止。

## 上游参考

- [Arthas Tunnel](https://arthas.aliyun.com/doc/tunnel.html)
- [Spring Boot Starter](https://arthas.aliyun.com/doc/spring-boot-starter.html)
- [HTTP API](https://arthas.aliyun.com/doc/http-api.html)
- [trace](https://arthas.aliyun.com/doc/trace.html)
- [watch](https://arthas.aliyun.com/doc/watch.html)
- [monitor](https://arthas.aliyun.com/doc/monitor.html)

## 当前状态

文档已确定操作语义，具体版本与目标环境尚未完成兼容验证，集成功能待实现。
