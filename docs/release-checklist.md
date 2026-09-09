# 发布检查清单

只有全部必需项满足才可发布。

当前发布版本是 `0.1.7`（稳定版），运行时契约覆盖已发布 DSH `0.1.0-rc.6` 至 `0.1.2-rc.1`、`0.1.2-alpha.2` 至 `0.1.2-alpha.5`、`0.1.3-alpha.2` 和最新上游 tag/npm `0.1.5-alpha.1`，并包含 `0.1.2-alpha.1`、`0.1.3-alpha.1` 的源码级适配；`0.1.3-alpha.1/.2` 使用 alpha13/alpha132 的 Session v2，`0.1.5-alpha.1` 使用 alpha151 的 Session v3，只有 alpha132 发送 alpha.2 新增的 subagent `delivery` 字段。预发布版本不作为安装默认。任何非空未知版本标签仅由可安全复用已验证 wire 的 Adapter 进行兼容探测，alpha13/alpha132/alpha151 的版本专属 Session wire 只接受精确版本，未知运行时回退到 alpha5 v0，成功后保留真实版本并显示警告。能力矩阵仍有 `PARTIAL`，以下未勾选项代表真实缺口，不应被“构建成功”替代。

## 功能

- [ ] `docs/capability-matrix.md` 所有核心能力为 DONE，并有代码/自动/live 证据。
- [x] 无用户可达路径抛出 `TodoImplementationError`。
- [ ] 未知 DSH 版本按可安全复用的已验证 wire 优先探测，候选失败继续降级，成功后只显示兼容性警告并保留真实版本；alpha13 v2 不得用于未协商的未知运行时。
- [ ] 已运行 DSH 自动连接且不重复 spawn。
- [ ] 缺失 DSH 底部操作完整，安装不自动执行。
- [ ] 外部/受管进程所有权测试通过。

## 质量

- [ ] clean checkout 执行 `pnpm install --frozen-lockfile && pnpm check && pnpm build`。
- [ ] Windows、Linux、macOS 三平台 CI（Node `22.19`）通过。
- [ ] VS Code 最低支持版本 E2E 通过。
- [ ] 真实 DSH rc.6/rc.7/rc.8/rc.1/rc.2 smoke matrix 通过，且未知版本的安全 wire Adapter 优先、失败继续尝试、警告降级路径通过。
- [ ] 未发布 alpha.1 对应 npm/运行包发布后完成真实 Connection、Cookie、remote.mux、Session/Workspace follow smoke；在此之前只能保留源码契约证据。
- [ ] 已发布 `0.1.2-alpha.2` 完成真实 Connection、Cookie、remote.mux、Session/Workspace follow smoke，并把结果记录到能力矩阵；当前适配仍不作为安装默认。
- [ ] 已发布 alpha.3 完成真实 Connection、Cookie、remote.mux、Session/Workspace follow smoke，并把结果记录到能力矩阵；当前适配仍不作为安装默认。
- [ ] 已发布 alpha.4 完成真实 Connection、Cookie、remote.mux、Session/Workspace follow smoke，并把结果记录到能力矩阵；当前适配仍不作为安装默认。
- [ ] 已发布 alpha.5 完成真实 Connection、Cookie、remote.mux、Session/Workspace follow smoke，并把结果记录到能力矩阵；当前适配仍不作为安装默认。
- [ ] 已发布 `0.1.3-alpha.2` 完成真实 Connection、Cookie、remote.mux、Session v2、Workspace follow 和 subagent queue/steer smoke，并把结果记录到能力矩阵；当前适配仍不作为安装默认。
- [ ] 最新 `0.1.5-alpha.1` 完成真实 Connection、Cookie、remote.mux、Session v3、Workspace follow、surface replacement、system-message 隔离和 PTC smoke，并把结果记录到能力矩阵；当前适配仍不作为安装默认。
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
- [ ] `vsce ls` 只包含 dist/media/resources/必要文档，无源码 fixture、计划、Secret 或本机路径。
- [ ] VSIX 在全新 VS Code Profile 安装、启用、卸载正常。
- [ ] Sourcemap 发布策略已明确；若发布，确认不含敏感 fixture/path。
- [ ] Tag、Marketplace 版本和 Changelog 一致，有回滚/下架方案。
