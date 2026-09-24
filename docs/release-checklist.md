# 发布检查清单

只有全部必需项满足才可发布。

当前发布目标是 `0.2.3`。运行时契约覆盖的 DSH 版本、版本缝、安装默认与未知版本的降级规则见
[dsh-contract.md](dsh-contract.md)；能力状态与证据见 [capability-matrix.md](capability-matrix.md)。
以下未勾选项代表真实缺口，不应被“构建成功”替代。

## 功能

- [ ] `docs/capability-matrix.md` 所有核心能力为 DONE，并有代码/自动/live 证据。
- [x] 源码中不存在 `unimplemented` 占位分支；用户可达路径要么是真实实现，要么是明确的不可用降级。
- [ ] 未知 DSH 版本按可安全复用的已验证 wire 优先探测，候选失败继续降级，成功后只显示兼容性警告并保留真实版本；alpha13 v2 不得用于未协商的未知运行时。
- [ ] 已运行 DSH 自动连接且不重复 spawn。
- [ ] 缺失 DSH 底部操作完整，安装不自动执行。
- [ ] 外部/受管进程所有权测试通过。

## 质量

- [x] `0.2.2` 代码提交 `99dc3ec` 执行了 `pnpm check` 和 `pnpm build`；主分支 CI `35841678559` 三平台检查通过。发布标签的构建与发布结果需另行核对。
- [x] Windows、Linux、macOS 三平台 CI（Node `22.19.0`）通过（主分支 CI run `35841678559`）。
- [ ] VS Code 最低支持版本 E2E 通过。
- [ ] 真实 DSH `0.0.1-rc.1/.2/.5`、`0.1.0-rc.2/.3`、`0.1.0-rc.6` 至 `0.1.2-rc.1` smoke matrix 通过，且未知版本的安全 wire Adapter 优先、失败继续尝试、警告降级路径通过。
- [ ] 已发布预发行版本分别完成真实 Connection、Cookie、remote.mux、Session/Workspace follow smoke 并更新能力矩阵状态与证据：`0.1.2-alpha.2`–`.5`（v0）、`0.1.3-alpha.2`（Session v2，含 subagent queue/steer）、`0.1.5-alpha.1/.2/rc.1/rc.2/rc.3` 与 `0.1.6-alpha.1/.2`（Session v3，含 surface replacement、`system/message` 隔离、PTC、`deliverables/presented`、`subagent/catalog` 和 rc.2/rc.3 消息反馈）、`0.1.7-alpha.1/.2` 与 `0.1.7-rc.1`（Session V4、projection control、pinned Workspace、Job Controller 和 turn-window 分页）；未完成 live smoke 的版本不得成为安装默认。
- [ ] `0.1.2-alpha.1`、`0.1.3-alpha.1` 的 npm 运行包尚未发布，只保留源码契约证据；上游发布对应运行包后补真实 smoke。
- [ ] 性能、长会话、断流恢复、资源泄漏基线通过。
- [ ] 键盘、屏幕阅读器、亮/暗/高对比、240px、Reduced Motion 通过。

## 安全和隐私

- [ ] Webview CSP 与消息负面测试通过。
- [ ] Secret/Prompt/Tool body 日志和协议扫描无泄漏。
- [ ] 无 shell 拼接、宽端口扫描、远程 Host 或私有 VS Code API。
- [ ] 附件/导出路径安全和取消清理通过。
- [ ] 权限、插件、安装、重启和删除均需明确用户操作。

## 包

- [ ] publisher、repository、license、privacy、icon、README 和 Changelog 已替换为正式值。
- [ ] `vsce ls --no-dependencies`（pnpm 工作区里不带该参数会先跑 `npm list` 并失败）只包含
      dist/media/resources/必要文档，无源码 fixture、计划、Secret 或本机路径。
- [ ] VSIX 在全新 VS Code Profile 安装、启用、卸载正常。
- [ ] Sourcemap 发布策略已明确；若发布，确认不含敏感 fixture/path。
      （策略已定：`media/**` 的 Webview sourcemap 不随包发布，见 `apps/extension/.vscodeignore`；随包发布的
      只有 `dist/extension.cjs.map`，其 `sources` 全为相对路径。未勾选是因为还没做逐包复核。）
- [ ] Tag、Marketplace 版本和 Changelog 一致，有回滚/下架方案。
