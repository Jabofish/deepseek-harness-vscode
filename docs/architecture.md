# 架构与目录职责

## 运行时结构

```mermaid
flowchart TB
  subgraph Renderer["Webview Renderer - 不可信 UI 边界"]
    REACT["React Features"]
    STORE["Zustand Store"]
    TL["Timeline Reducer"]
    REACT --> STORE --> TL
  end

  subgraph Host["VS Code Extension Host - 唯一平台边界"]
    ROUTER["Validated Message Router"]
    UC["Application Use Cases"]
    CC["Connection Coordinator"]
    DISC["Discovery Providers"]
    SUP["Managed Process Supervisor"]
    ROUTER --> UC
    UC --> CC
    CC --> DISC
    CC --> SUP
  end

  subgraph Adapter["Versioned DSH Boundary"]
    RC6["rc6 Adapter + Repositories"]
    STREAM["Shared Host/Mux Stream"]
    RC6 --> STREAM
  end

  Renderer <-->|"webview-protocol v1"| ROUTER
  UC --> RC6
  CC --> RC6
  RC6 <-->|"loopback RPC/events"| DSH["dsh web"]
```

## 包依赖

| 包                          | 职责                                        | 可以依赖                                | 禁止依赖                      |
| --------------------------- | ------------------------------------------- | --------------------------------------- | ----------------------------- |
| `packages/domain`           | 稳定业务类型、错误、仓储接口                | 无平台依赖                              | VS Code、React、HTTP、process |
| `packages/application`      | 用例、连接协调、端口接口                    | Domain                                  | DSH wire type、VS Code UI     |
| `packages/dsh-adapter`      | rc.6/rc.7/rc.8 RPC/Event 映射、仓储、流恢复 | Domain、Application ports、固定上游包   | VS Code、React                |
| `packages/webview-protocol` | Host/Webview 版本化消息 Schema              | Zod                                     | 传输实现、Secret              |
| `packages/timeline`         | 事件归并、回放、可见窗口                    | Domain                                  | React、VS Code、HTTP          |
| `packages/ui`               | 无业务副作用的可复用 UI                     | React、Domain view DTO                  | DSH、VS Code API              |
| `apps/extension`            | Composition Root、进程/文件/网络/凭据、命令 | Application、Adapter、Protocol、VS Code | React                         |
| `apps/webview`              | 极简 UI、局部状态、虚拟列表                 | UI、Timeline、Protocol                  | Node、VS Code 模块、直接网络  |

## 完整目录

```text
apps/
  extension/
    src/
      backend/
        discovery/        # 候选来源；不负责健康验证
        diagnostics.ts    # allowlist 脱敏输出
        process-supervisor.ts
        runtime-locator.ts
      commands/           # VS Code 命令注册和错误呈现
      config/             # dsh.* 设置读取/验证
      view/               # WebviewViewProvider、CSP、路由
      vscode/             # 凭据、安装、context keys、右栏引导
      activate.ts
      composition-root.ts
      extension.ts
  webview/
    src/
      app/                 # Store 和协议客户端
      features/            # 按能力分隔 UI，不共享副作用
      styles/
packages/
  application/            # Use cases + ports
  domain/                 # 业务契约
  dsh-adapter/
    src/versions/rc6/     # 兼容基线与通用 mapper
    src/versions/rc7/     # rc.7 版本身份与契约入口
    src/versions/rc8/     # rc.8 版本身份、增量事件与契约入口
    src/repositories/     # 每个能力域一个仓储
  timeline/
  ui/
  webview-protocol/
  test-support/
tests/
  integration/
  vscode-e2e/
docs/
  adr/
```

## 连接状态机

```mermaid
stateDiagram-v2
  [*] --> Idle
  Idle --> Discovering: view visible / connect command
  Discovering --> Connecting: verified candidate exists
  Connecting --> Connected: adapter created
  Connecting --> Discovering: candidate failed, try next
  Discovering --> RuntimeMissing: no candidate, no runtime
  Discovering --> Starting: no candidate, start allowed, runtime found
  Starting --> Connected: child ready and probed
  Starting --> Failed: timeout / early exit
  Connected --> Discovering: external connection lost, reconnect enabled
  Connected --> Stopping: dispose managed backend
  Connected --> Idle: dispose external backend client only
  Stopping --> Idle
  RuntimeMissing --> Discovering: retry / install succeeded / path selected
  Failed --> Discovering: explicit retry
```

`auto` 模式必须完整走完 Discovering 才能 Starting；`attach-only` 没有 Starting 边；`new-isolated` 明确跳过外部候选但仍禁止创建两个受管子进程。
`custom` 模式只把用户配置的、经过 Host 校验的 loopback endpoint 作为候选；健康检查失败直接进入 Failed，不执行发现、运行时定位或启动。

## 进程所有权不变量

| 来源                              | ownership  | 扩展关闭时                   | 连接断开时                   |
| --------------------------------- | ---------- | ---------------------------- | ---------------------------- |
| 设置/已知端口/进程发现/companion  | `external` | 仅关客户端和流               | 尝试重连或提示，绝不停止进程 |
| 当前扩展 `spawn` 并持有子进程句柄 | `managed`  | 优雅停止，超时后只终止该句柄 | 按策略重连或停止该子进程     |

PID 不能单独证明所有权。只有当前进程内创建并保存的 `ManagedProcessHandle` 才允许停止。

## 扩展点

- 新 DSH 版本：新增 `versions/<version>` 和 Mapper；Domain/API Protocol 不随 wire shape 改动。
- 新发现方法：实现 `DiscoveryProvider`，输出候选；协议验证仍由 Probe 完成。
- 新工具：向 `ToolRendererRegistry` 注册；未知工具始终退回通用卡片。
- 新功能 UI：新增 `features/<capability>`；通过协议和用例调用，不直接跨层。
