# Webview 排版规范

本文档是 DSH VS Code Webview 字号与排版的唯一规范。目标是让同一角色在不同页面渲染出同一个尺寸，并让全部文本都跟随「字号」设置。

## 所有权与边界

- `packages/ui/src/styles.css` 是字号 token、行高 token 与图标尺寸 token 的唯一所有者。
- `apps/webview/src/styles/{app,compatibility,components,layout}.css` 及 feature 局部样式表只消费这些 token。
- TSX 不写 `font-size`，不通过 `style` prop 注入字号；它只负责类名与 `data-*` / `aria-*` 状态。
- 不新增字体资源、排版运行时或 CSS 预处理器。全仓使用 `--vscode-font-family` / `--vscode-editor-font-family`。

## 字号 token（数值刻度）

| Token                 | 值        | 参考像素 | 适用场景                                  |
| --------------------- | --------- | -------- | ----------------------------------------- |
| `--dsh-font-size-2xs` | 0.625rem  | 10px     | 密集标签、计数、指标、密集 meta           |
| `--dsh-font-size-xs`  | 0.75rem   | 12px     | 时间戳、状态、次要说明、菜单分组标题      |
| `--dsh-font-size-sm`  | 0.8125rem | 13px     | 正文邻近的次级文本、label、列表标题、计数 |
| `--dsh-font-size-md`  | 0.875rem  | 14px     | 正文、菜单项、代码块、面板正文            |
| `--dsh-font-size-lg`  | 1rem      | 16px     | 抽屉、面板、卡片、空态与错误页标题        |

参考像素按 `rem = 16px`（全仓不设置 `html { font-size }`）与 body `13px` 推导。

## 角色 token（既有别名）

| Token                         | 定义                               | 适用场景                  |
| ----------------------------- | ---------------------------------- | ------------------------- |
| `--dsh-menu-font-size`        | `--dsh-font-size-md`               | 浮层菜单项                |
| `--dsh-tool-detail-font-size` | `--dsh-font-size-xs`               | 工具卡片的细节正文与 `h4` |
| `--dsh-markdown-heading-1..6` | 1.35 / 1.15 / 1 / 0.9375 / md / sm | Markdown 标题层级         |

`h1`–`h6` 的兜底由 `app.css` 的 `:where(h1, h2, h3, h4, h5, h6)` 提供：任何没有角色规则的标题都落到 `--dsh-font-size-lg`。`:where()` 的特异性为 0，因此已有和新增的角色规则（`.dsh-markdown h2`、`.dsh-tool-row__section h4` 等）都优先于它；兜底只为消除浏览器默认刻度（`2em` / `1.5em` / `1.17em`），并让标题跟随「字号」设置。

## 非字号 token

| Token                       | 值       | 适用场景                     |
| --------------------------- | -------- | ---------------------------- |
| `--dsh-line-height-tight`   | 1.25     | 单行标签、状态药丸、行内控件 |
| `--dsh-line-height-body`    | 1.45     | 正文默认                     |
| `--dsh-line-height-relaxed` | 1.55     | 需要舒展阅读的段落           |
| `--dsh-icon-size`           | 1rem     | 图标与图标字形               |
| `--dsh-icon-size-sm`        | 0.875rem | 紧凑图标与图标字形           |

## 与「字号」设置的关系

`.dsh-conversation` 通过 `--dsh-conversation-font-scale`（小 0.9 / 标准 1 / 大 1.15）在局部重新声明字号 token，因此只有使用 token 的文本会跟随设置缩放。

新增字号 token 时必须同时在该块内以 `calc(<值> * var(--dsh-conversation-font-scale))` 重声明，否则该 token 会成为唯一不跟随设置的尺寸。

## 硬性规则

1. 禁止裸 `font-size`：CSS 中只允许 `var(--dsh-font-size-*)`、`var(--dsh-markdown-heading-*)`、`var(--dsh-menu-font-size)`、`var(--dsh-tool-detail-font-size)` 与下文列出的例外。
2. `em` 会让字号随父级复合，禁止用于字号；相对尺寸只在图标字形等确有父级语义时使用。
3. 图标与图标字形用 `--dsh-icon-size` / `--dsh-icon-size-sm`，不用字号模拟尺寸。
4. 行高用行高 token，不写裸 `1.2 / 1.35`。
5. 同一个视觉角色在不同页面必须用同一个 token；新页面不得引入新尺寸。
6. 标题必须有角色规则或落到 `:where(h1..h6)` 兜底；不得依赖浏览器默认刻度。

允许的例外（必须在注释中说明理由）：

- `inherit`：明确需要继承宿主或父容器字号的元素；
- `var(--vscode-font-size, 13px)`：Webview 根字号与 `body`；
- 文本字形（如 `↻`）改用 `--dsh-icon-size*` 后不再是例外。

## 验证

- `apps/webview/src/styles/typography-scale.spec.ts` 断言 CSS 中不再出现裸 `font-size` 数值。
- 真实浏览器探针（headless Chrome + CDP 注入）读取 `getComputedStyle` 校验：关键页面在实际渲染中的字号、行高与设置档位缩放一致。
- 修改字号或新增排版相关规则后，按 `docs/testing.md` 的门禁顺序全量执行。
