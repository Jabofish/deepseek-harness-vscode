# ADR 0003：默认贡献 Activity Bar，由用户移动到 Secondary Side Bar

- 状态：Accepted
- 日期：2026-08-16

## 决策

自定义 View Container 默认贡献到稳定支持的 Activity Bar。提供一次性引导和命令，帮助用户把 View 拖到 Secondary Side Bar；不使用 proposed/private API 强制默认右置。

## 理由

VS Code 稳定贡献点支持 `activitybar` 和 `panel`，不支持扩展声明 `secondarySidebar` 作为默认 View Container 位置。用户移动后 VS Code 会持久化布局。

## 后果

产品文案必须准确，不能承诺插件安装后自动位于右栏；E2E 验证 View 可移动且窄宽可用。
