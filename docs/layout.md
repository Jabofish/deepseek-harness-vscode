# Webview 版式与溢出规范

本文档约束 Webview 中「内容比容器宽」时的行为。会话标题、工作区路径、模型名、分支名、URL 和工具名都来自外部，单个不可断词的 token 比面板还宽是常态而不是异常；规范的目标是让这种内容换行、截断或滚动，而不是把祖先撑出视口。

## 所有权与边界

- `apps/webview/src/styles/app.css` 的零特异性基线（`:where(...)` 文本元素选择器）是全局换行策略的唯一所有者。
- feature CSS 只在自己的容器上声明尺寸纪律（网格轨道、`min-width`），不为外部文本重新声明 `white-space: nowrap`。
- `white-space: pre` 表面（代码块、diff、终端输出）继续横向滚动，不参与换行基线。
- 溢出规则不改变协议、store 或 Host 行为；是否换行只由内容的长度和容器宽度决定。

## 内容尺寸的三条规则

1. **默认换行**：`overflow-wrap: anywhere`。它同时降低元素的 min-content 宽度，flex/grid 子项因此不再把祖先推到视口之外；`overflow-wrap: break-word` 只换行、不降低 min-content，在内容尺寸的祖先链上无效。
2. **容器定宽**：任何 `auto` 网格轨道写 `minmax(0, 1fr)`，flex 子项写 `min-width: 0`。隐式 `auto` 轨道的最小值取自子项的 min-content，一条超长标签就足以让整个区块变宽。
3. **祖先闭合**：沿祖先链检查是否存在内容尺寸（shrink-to-fit）的盒子——`auto` 轨道、`inline-flex`、浮动、绝对定位的自动宽度。链上只要有一处不闭合，叶节点写得再正确也会被撑开。

## 截断与省略

`overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap` 只在**定宽容器内**安全：它不改动元素的 min-content，因此内容尺寸的祖先仍会被整串文本撑宽，只是本地看不到 `scrollWidth > clientWidth`（每个祖先都被撑到同样宽，溢出只在最外层显现）。

`text-overflow: ellipsis` 必须与 `overflow: hidden` 同时出现，否则省略号是惰性的；`.dsh-sr-only` 一类故意裁切的元素除外。

## 标题策略

承载模型或用户文本的标题用两行截断，而不是单行 nowrap：

```css
display: -webkit-box;
-webkit-box-orient: vertical;
-webkit-line-clamp: 2;
overflow: hidden;
overflow-wrap: anywhere;
white-space: normal;
```

当前消费者是 `.dsh-goal-bar__title`、`.dsh-goal-strip__title` 和 `.dsh-interaction__header h2`（Goal 标题、审批标题、问题题干）。理由：nowrap 会把整串文本变成 min-content，实测在 900px 面板中产生 1480px 的 min-content；两行截断把 min-content 降到单个字符，同时保留完整文本的可读范围，`title` 属性仍是完整文本的出口。

由固定标签构成的标题（`.dsh-drawer__header h2`、`.dsh-settings__header h2` 等）保持单行省略号：这些字符串由应用提供且有界，其容器已声明定宽。

## 验证

```bash
node artifacts/.ui-typography-check/nowrap-audit.mjs   # 按选择器合并层叠，列出未被 containment 覆盖的 nowrap
node artifacts/.ui-typography-check/overflow.mjs       # 3 档宽度 × 2 主题，注入超长 token 后统计
node artifacts/.ui-typography-check/chain.mjs "#selector" 420   # 某元素的祖先链与子项实测
```

`overflow.mjs` 的门槛是「可见溢出」保持 0（内容明显离开盒子的元素）和「无提示裁切」保持 0；「省略号截断」是预期结果，数量变化需要能解释。注入用例必须与产品结构一致：容器里如果是元素承载文本，就不要让夹具里出现裸文本，否则测量到的是夹具的匿名 flex 项而不是产品行为。
