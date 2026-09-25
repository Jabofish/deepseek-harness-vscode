# Webview 界面规范

本文件规定 Webview 的视觉 token、内容尺寸、动效与可访问性。**具体 token 值以 CSS 为准**：`packages/ui/src/styles.css` 拥有基础字体、行高、图标、动效和宿主语义色；`apps/webview/src/styles/theme.css` 拥有显式亮色/暗色调色板。其余全局与 feature 样式只消费语义 token。界面样式不得改变 Host 协议或业务状态的含义。

## 颜色与主题

`system` 模式使用带回退值的 `--vscode-*` 宿主颜色，不定义 `--dsh-theme-*`；显式 `light`/`dark` 只覆盖 Webview 自己的 `--dsh-*`，绝不定义或修改 `--vscode-*`。主题属性同时位于 `document.documentElement` 和主应用容器，保证挂在 `body` 的菜单、对话框与 Toast 也获得相同调色板。

| 角色           | Token                            | 用途                                                         |
| -------------- | -------------------------------- | ------------------------------------------------------------ |
| 填充强调       | `--dsh-accent` / `--dsh-primary` | 主按钮、开关轨道、选中底色，文字由 `--dsh-primary-text` 配对 |
| 线条与文字强调 | `--dsh-accent-line`              | 边框、轮廓、图标、链接和状态标记                             |

填充色不能代替线条色：在暗色表面上，两者需要不同明度才能同时可读。字面颜色只允许在 `theme.css` 的调色板定义中出现；其他样式只用语义 token。每个 `--vscode-*` 引用必须有回退值。状态不能只靠颜色表达，须有对应的 `aria-*`、`data-*` 或类名语义。

`apps/webview/src/styles/theme.spec.ts` 是对比度自动守卫：承载文字的 `TEXT_PAIRS` 至少 4.5:1，控件和焦点边界的 `UI_PAIRS` 至少 3:1。新增颜色或承载文字的 token 必须同步纳入配对。`color`、边框、轮廓、阴影、文本装饰、`fill` 与 `stroke` 不使用填充强调 token；只有同一填充控件规则内的背景及其边框可例外。

## 排版与图标

字号、行高和图标尺寸只使用 `--dsh-font-size-*`、角色字号、`--dsh-line-height-*` 与 `--dsh-icon-size*`。字号角色依次为密集元信息、时间/状态、次级文字、正文、标题；同一角色跨页面保持同一 token。菜单、工具细节和 Markdown 标题使用已有角色别名；标题必须有角色规则或落到 `app.css` 的零特异性标题兜底，不依赖浏览器默认 `em` 刻度。

`.dsh-conversation` 按用户“字号”设置在局部重声明字号 token；新增 token 必须在该缩放块中同步声明。TSX 不写字号 `style`，CSS 不写裸数值字号或行高。`inherit` 与 Webview 根部的宿主字号是有说明的例外；图标字形用图标 token，不借文字字号实现。`apps/webview/src/styles/typography-scale.spec.ts` 守卫裸字号；真实渲染仍须检查设置档位、行高和图标大小。

## 内容宽度与溢出

外部标题、路径、URL、工具名和模型名都可能是不可断词的长串；任何内容不得把侧栏祖先撑出视口。

1. 普通文本默认 `overflow-wrap: anywhere`，降低 min-content 宽度；代码、diff 和终端等保留空白的内容在自己的盒子内横向滚动。
2. Grid 的弹性列使用 `minmax(0, 1fr)`，Flex 子项使用 `min-width: 0`；从文本到视口沿祖先链检查内容尺寸，不能只修叶节点。
3. 单行省略号只用于已定宽的有界标签，并同时写 `overflow: hidden`、`text-overflow: ellipsis`、`white-space: nowrap`；用户或模型文本标题优先用两行截断、`white-space: normal` 和完整文本提示。
4. 隐藏溢出不能掩盖祖先超宽或无提示裁切。窄侧栏、普通侧栏和编辑器宽度均须用超长 token 检查可见溢出、裁切和焦点可达性。

全局零特异性换行规则位于 `apps/webview/src/styles/app.css`，feature CSS 只约束自己的容器。布局验证使用仓库已有 UI 测试与真实 Webview；本地一次性探针可以辅助排查，但不把临时 `artifacts/` 脚本写成项目必需命令。

## 动效

动效只反馈状态、层级和操作结果，不用于装饰；TSX 只切换 class 或 `data-*`，不注入 `<style>` 或动画 `style`，不新增动画运行时。持续时间、缓动、缩放、共享 keyframes 和 Reduced Motion 降级都由 `packages/ui/src/styles.css` 拥有。小控件使用 fast、轻量披露和提示使用 standard、大表面使用 slow；退场比入场短一档。循环 token 只用于当前等待或进行中状态，完成和历史项保持静态。

轻量常驻内容可用 `dsh-disclosure` 的 grid 行过渡；其折叠区必须同步不可聚焦。工具详情、diff 和代码块等重量内容继续条件挂载。只动画 `transform`、`opacity`、`background-position`、`color` 和 `border-color`；小披露的 `grid-template-rows` 是唯一已评审的结构性例外。虚拟化行的定位 transform 不得被入场类覆盖，首屏、会话切换和历史回填不做逐行动画。

`prefers-reduced-motion: reduce` 关闭平滑滚动、把过渡缩短到可忽略时间并停止循环；JavaScript 的滚动行为在 `useScrollFollow` 同步降级。Esc、点击外部、焦点陷阱、焦点恢复与 `aria-live` 不等待动画。Drawer 退场时立刻停止交互并标记隐藏，视觉收尾不延迟语义关闭。

## 验收

在 240px 窄侧栏、普通侧栏和编辑器宽度分别检查亮色、暗色、高对比与 Reduced Motion；验证键盘操作、焦点归属与恢复、屏幕阅读器、菜单/弹层、长文本、流式尾部和大量历史节点。自动测试只能覆盖规则的一部分，能力矩阵中 UI 条目需要真实 VS Code Webview 的人工或端到端证据才能提升状态。
