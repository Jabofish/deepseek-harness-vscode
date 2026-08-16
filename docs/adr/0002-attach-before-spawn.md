# ADR 0002：先连接、后启动，并显式记录进程所有权

- 状态：Accepted
- 日期：2026-08-16

## 决策

`auto` 模式先完成候选发现与协议 Probe，全部失败后才定位和启动 DSH。发现的实例为 external；只有当前扩展直接创建并持有句柄的实例为 managed。

## 不变量

- external 永不被 stop/restart/kill；PID 不是所有权证明。
- 并发连接/视图/命令共享一个 in-flight 操作和一个受管实例。
- 不扫描任意端口范围。
- 启动只绑定 loopback，默认 port 0。

## 后果

发现必须跨平台、可失败降级且所有候选都需协议验证；进程 Supervisor 必须可测试和严格释放。
