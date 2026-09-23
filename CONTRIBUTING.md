# 贡献指南

## 变更粒度

每个变更只完成一个可测试的能力切片。避免“先把所有 UI 写完”或“先把所有 RPC 写完”，因为这会制造
无法验证的半成品。实现规则与验收条件见 [AGENTS.md](AGENTS.md)；新切片的计划方式见
[docs/implementation-order.md](docs/implementation-order.md)。

推荐提交格式：

```text
feat(connection): attach to an existing rc6 backend
test(adapter): cover malformed session history frames
docs(capabilities): record live model-switch verification
```

## 开发环境

要求 Node.js `>=22.19 <27` 和 pnpm `11.19`（由根 `packageManager` 固定）。环境配置、调试和真实
DSH 联调见 [docs/development.md](docs/development.md)。

```powershell
corepack enable
pnpm install --frozen-lockfile
pnpm check   # format + lint + typecheck + tests
pnpm build
```

## 提交与门禁

- 每次修改聚焦一个位置；垂直切片完成后运行 `pnpm check && pnpm build`，门禁全绿才算交付。
- 不自动 commit、push 或发布，除非维护者明确要求。
- 禁止提交构建产物、`.vsix`、真实凭据、用户路径、`DSH_VSCODE_*PLAN*.md` 和 `LOCAL_*.md`。

## Webview 打包预算

`pnpm build` 会重新生成 `apps/extension/media/`（入口 `webview.js` 与 `assets/` 下的懒加载分块）。Vite 默认的
500 kB 告警阈值保持不变，超过它的分块必须能解释清楚：

- 入口 `webview.js`（约 1.41 MB，gzip 约 397 kB）内联全部应用表面。VS Code 可能在扩展更新期间用缓存文档
  恢复 Webview，此时根级动态 `import()` 会指向上一构建的哈希分块并在 `React.lazy` 内 reject，把整个会话替换成
  错误边界（见 `apps/webview/src/App.tsx`）。只有 Shiki 这种“非首屏、可失败”的资源才使用动态 `import()`。
- 语法高亮只打包 `apps/webview/src/features/chat/shiki.ts` 中 `languageLoaders` 列出的语言（当前 18 种）与
  `SHIKI_THEMES` 的两个主题；每个条目都是一个懒加载分块，未命中的语言回退为纯文本。新增语言时同时更新
  `languageLoaders` 和必要的 `LANGUAGE_ALIASES`，不要退回 Shiki 全量 bundle（会重新产生 300+ 个分块）。
- `shiki/core`、`shiki/engine/javascript`（`oniguruma-to-es`，约 61 kB）与两个主题各自独立分块，只在首次渲染
  代码块时请求。Webview 的 `script-src` 不含 `wasm-unsafe-eval`，浏览器会直接拒绝 `WebAssembly.instantiate`，
  所以 Shiki 的 Oniguruma 引擎在真实 Webview 里永远起不来；不要改回 `shiki/engine/oniguruma` + `shiki/wasm`。

打包 VSIX 时 `apps/extension/.vscodeignore` 使用“包含清单”写法（`**` 加逐条 `!` 反选）：vsce 的
`package.json.files` 无法表达排除项，且不能与 `.vscodeignore` 同时使用。`media/**` 的 sourcemap 靠扩展名
白名单排除，本地构建产物仍保留 map 供 DevTools 使用；随包发布的只有 `dist/extension.cjs.map`。

## Pull Request 必填证据

- 对应 `docs/capability-matrix.md` 行和状态变化；
- 使用的上游 RPC/Event 固定链接（见 [docs/dsh-contract.md](docs/dsh-contract.md)）；
- 新增或更新的测试；
- `pnpm check` 与 `pnpm build` 结果；
- 若涉及真实 DSH：版本、平台、复现步骤和实际结果；
- 若涉及 UI：窄视图、键盘、亮色/暗色与高对比度检查。

## 文档联动

- 面向用户的能力或行为变化：同步 `apps/extension/CHANGELOG.md`，必要时同步 `README.md` 与
  `README.zh-CN.md`（两份内容保持平行）。
- 面向开发者的契约、架构或流程变化：同步 `docs/` 下对应文档及其
  [索引](docs/README.md)。

## 文档语言约定

- `README.md` 使用英文，`README.zh-CN.md` 使用简体中文，两份内容平行；一个文件只写一种语言。
- `apps/extension/README.md` 是 VS Code Marketplace 的 listing，使用英文。
- `docs/` 与 `AGENTS.md` 面向贡献者，使用中文。

## 兼容策略

当前承诺已发布的 DSH `0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3`、`0.1.0-rc.6` 至 `0.1.2-rc.1`、
`0.1.2-alpha.2` 至 `0.1.2-alpha.5`、`0.1.3-alpha.2`、`0.1.5-alpha.1/.2/rc.1/rc.2` 和 alpha 通道
`0.1.6-alpha.1/.2`；未发布的 `0.1.2-alpha.1`、`0.1.3-alpha.1` 保留源码级入口。完整版本缝、wire
family 与安装默认见 [docs/dsh-contract.md](docs/dsh-contract.md)，安装器精确安装 `0.1.5-rc.2`、
不解析 dist-tag。连接到其他版本时必须先由最新已验证 Adapter 进行只读兼容探测；成功后显示警告并保留
真实版本，候选失败时继续降级，禁止静默把未知版本当成精确支持。
