# Webview 颜色与主题规范

本文档是 DSH VS Code Webview 颜色分层的唯一规范。颜色只服务于三件事：把宿主主题原样透传给界面、把语义状态和普通表面区分开、在两种显式主题下都保持可读。装饰性配色不属于本层职责。

## 所有权与边界

- `packages/ui/src/styles.css` 是宿主驱动的基座：每个语义 token 以 `var(--vscode-*, <回退>)` 形式取色，唯一所有者。
- `apps/webview/src/styles/theme.css` 是显式 `light` / `dark` 调色板（`--dsh-theme-*`）与语义别名的唯一所有者。
- `apps/webview/src/styles/{app,components,layout,compatibility}.css` 与 feature CSS 只消费语义 token，不写字面色值。
- `system` 模式被刻意留空：它不定义任何 `--dsh-theme-*`，因此界面对齐当前 VS Code 主题。显式模式只覆盖 Webview 自己的 `--dsh-*`，从不重定义 `--vscode-*`，也就不会把周围的 VS Code 界面一起改色。

## Token 分层

```text
宿主            --vscode-*                由 VS Code 注入，本仓库只读
基座            --dsh-*（含回退）          styles.css，system 模式的全部来源
调色板          --dsh-theme-*              theme.css，仅 light / dark
别名            --dsh-* = --dsh-theme-*    theme.css，仅 light / dark
```

主题属性由 `App.tsx` 写在两处：`document.documentElement` 与 `main.dsh-app`。前者让挂在 `body` 上的 portal（对话框、菜单、Toast）也能拿到调色板，删除任何一处都会让浮层落回宿主主题。

## 强调色的两个角色

强调色按**绘制方式**分裂成两个 token，不能互换：

| Token               | 解析为                                                                              | 用途                                         | 约束                                     |
| ------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------- |
| `--dsh-accent`      | `--dsh-primary`                                                                     | 填充面：主按钮、开关轨道、选中项底色         | 必须能让 `--dsh-primary-text` 达到 4.5:1 |
| `--dsh-accent-line` | `--dsh-link`（`--dsh-accent-line: var(--dsh-link)` 单点声明，跟随两种调色板与宿主） | 1px 边框、轮廓、图标字形、强调文字、状态标记 | 在全部七个表面上都要达到 4.5:1           |

暗色下这两个角色无法用同一个颜色满足：白字要求 `--dsh-theme-primary` 足够深，深到 1px 线在 `surface-hover` 上只剩 2.43:1。因此暗色按钮填充用深蓝，线条与文字用浅蓝。

**硬性规则**：`color`、`border-*`、`outline-*`、`box-shadow`、`text-decoration-*`、`fill`、`stroke` 中禁止出现 `var(--dsh-accent)` 或 `var(--dsh-primary)`，唯一例外是同一条规则内 `background: var(--dsh-primary)` 的填充控件（此时边框就是填充的一部分）。`accent-color` 属于填充角色，继续使用 `--dsh-primary`。

## 对比度契约

`apps/webview/src/styles/theme.spec.ts` 用真实调色板值计算对比度，是唯一的自动守卫：

- `TEXT_PAIRS`：承载文字的配对，AA 4.5:1，覆盖正文、弱化文字、占位符、图标、链接（对全部七个表面）、按钮文字、语义色与图表色；
- `UI_PAIRS`：识别控件与焦点的边界，3:1，覆盖输入边框、焦点环、警告与错误边框。

新增调色板项、改写任何 `--dsh-theme-*` 值或新增承载文字的 token 时，必须同步把它们加入对应数组；否则改动不会被守卫覆盖。

## 硬性规则

1. 字面色值只能出现在 `theme.css` 的调色板块内；其余样式表一律使用语义 token。
2. 每个 `--vscode-*` 引用都必须带回退值，否则宿主主题缺项时该属性会整条失效。
3. 不得定义或覆盖 `--vscode-*`。
4. `--dsh-theme-*` 只在 `light` / `dark` 下定义，`system` 必须继续由宿主驱动。
5. 状态边界（选中、展开、按下）与图标字形使用 `--dsh-accent-line`，不得使用填充色。
6. 只改颜色不改变布局语义：状态色必须同时对应既有的 `aria-*`、`data-*` 或类名状态，不能只靠颜色表达状态。
