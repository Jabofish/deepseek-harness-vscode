# Webview 动效规范

本文档是 DSH VS Code Webview 动效的唯一规范。动效服务于状态反馈、层级关系和操作结果，不用于装饰；内容可读性、键盘操作和窄侧栏可用性优先于视觉效果。

## 所有权与边界

- `packages/ui/src/styles.css` 是 motion token、共享 keyframes、Reduced Motion 降级和通用披露原语的唯一所有者。
- `apps/webview/src/styles/{app,components,layout,compatibility}.css` 只消费这些 token，并维护对应 feature 的布局与状态选择器。
- TSX 只切换类名或 `data-*` 状态，不注入 `<style>`，不通过 `style` prop 写动画。
- 不新增动画运行时依赖。CSS-only 方案符合 Webview CSP，也不会为虚拟化时间线增加逐行编排成本。
- 动效不改变协议、store、时间线归并或 Host 行为；所有语义仍由现有状态和事件决定。

## Token 参考

| Token                                | 值                                  | 适用场景                             |
| ------------------------------------ | ----------------------------------- | ------------------------------------ |
| `--dsh-motion-duration-fast`         | `120ms`                             | hover、chevron、按压、颜色/边框过渡  |
| `--dsh-motion-duration-standard`     | `180ms`                             | Toast、Popover、轻量披露、尾节点入场 |
| `--dsh-motion-duration-slow`         | `240ms`                             | Drawer 等大表面入场                  |
| `--dsh-motion-duration-loop-shimmer` | `1.4s`                              | 重试和加载骨架扫光                   |
| `--dsh-motion-duration-loop-pulse`   | `1.8s`                              | 进行中状态点                         |
| `--dsh-motion-duration-loop-breathe` | `2.8s`                              | 流式活动指示                         |
| `--dsh-motion-ease-standard`         | `cubic-bezier(0.2, 0, 0, 1)`        | 对称的小过渡                         |
| `--dsh-motion-ease-enter`            | `cubic-bezier(0, 0, 0, 1)`          | 普通入场                             |
| `--dsh-motion-ease-exit`             | `cubic-bezier(0.3, 0, 1, 1)`        | 退场                                 |
| `--dsh-motion-ease-emphasized-enter` | `cubic-bezier(0.05, 0.7, 0.1, 1)`   | 大表面入场                           |
| `--dsh-motion-ease-pop`              | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 小于 16px 的单次微弹                 |
| `--dsh-motion-scale-from`            | `0.97`                              | 弹层起始缩放                         |
| `--dsh-motion-scale-press`           | `0.98`                              | 可操作按钮按压                       |
| `--dsh-motion-scale-pulse`           | `0.75`                              | 进行中状态点脉冲                     |

选择顺序：先判断表面是否循环 → 循环只使用对应 loop token；再判断表面大小 → 小表面使用 standard，大表面使用 slow；最后根据方向选择 enter、exit 或 standard 缓动。退场始终比入场短一档：slow 入场配 standard 退场，standard 入场配 fast 退场。

位移复用现有 `--dsh-space-1` 和 `--dsh-space-5`，不另建第二套距离 token。

## 共享 keyframes

所有 `dsh-*` keyframes 都在 `packages/ui/src/styles.css` 定义。组件通过语义类消费：

- `dsh-surface-enter`：已有轻量内容入场基线；
- `dsh-overlay-fade-in` / `dsh-overlay-fade-out`：遮罩层；
- `dsh-slide-in-*` / `dsh-slide-out-*`：Drawer 双向进出场；
- `dsh-pop-in`：Popover、SelectMenu 等锚定表面；
- `dsh-rise-in`：尾部新节点和跳转按钮内容；
- `dsh-toast-in`：错误、连接、更新和欢迎横幅；
- `dsh-retry-shimmer` / `dsh-skeleton-sweep`：重试与加载态；
- `dsh-pulse-dot` / `dsh-breathe`：进行中语义；
- `dsh-pop-once`：小型一次性完成反馈。

同一表面不得叠加多个同语义入场动画。循环动画只给当前正在运行的语义，历史完成项和排队项保持静态。`ScrollToLatestButton` 只在用户离开尾部后入场，回到尾部时即时卸载，避免遮挡正文；待办完成图标使用一次性微弹，不使用循环动画。

## 通用披露原语

轻量、常驻内容使用 `dsh-disclosure`：

```css
.dsh-disclosure {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--dsh-motion-duration-standard) var(--dsh-motion-ease-standard);
}

.dsh-disclosure[data-open='true'] {
  grid-template-rows: 1fr;
}

.dsh-disclosure__inner {
  min-height: 0;
  overflow: hidden;
}
```

折叠内容必须保留 `aria-hidden="true"` 或等价的不可聚焦语义。工具详情、diff、代码块等重量内容继续条件挂载，不为了动画常驻 DOM。

## 可访问性策略

全局只保留一份 `prefers-reduced-motion: reduce` 降级：关闭平滑滚动、把动画/过渡缩短到可忽略时长、取消延迟，并将循环动画限制为一次。Esc、点击外部、焦点陷阱、焦点恢复和 `aria-live` 不等待动画。

CSS 无法约束 JavaScript 的 `scrollTo({ behavior: 'smooth' })`，因此 `useScrollFollow` 是唯一的 JS Reduced Motion 出口。显式“跳到最新”在 Reduced Motion 下直接定位，普通程序化跟随保持原有硬跳语义。

Drawer 退场期间仍保留 DOM 以完成视觉收尾，但立即设置 `aria-hidden`、停止交互并保持关闭语义；焦点恢复发生在关闭开始时，不等待退场结束。

## 性能与禁止清单

- 只动画 `transform`、`opacity`、`background-position`、`color` 和 `border-color`；不得动画 `height`、`width`、`top`、`margin` 等布局属性。
- 轻量披露的 `grid-template-rows` 是唯一经过评审的结构性例外；只用于小体量内容。
- 虚拟化时间线的定位行已有内联 `transform`，入场类必须下沉到行的子内容，不能覆盖定位。
- 首屏、会话切换和历史回填不播逐行入场；尾部追加最多一个节点入场。
- 不在组件中写裸 `ms`、`s`、`cubic-bezier`、位移或缩放值；全部消费 `--dsh-motion-*` 或现有空间 token。
- 不添加新的动画库、内联 `<style>`、动画 `style` prop 或 feature 私有 keyframes。
- 骨架、脉冲和呼吸只用于等待/进行中状态；静态历史内容不得挂循环动画。

当前 `GoalBar` 只有文字和操作控件，没有独立的进度轨道，因此不引入不存在的宽度动画；未来若增加真实的低频进度轨道，必须重新评估窄侧栏中的布局动画。

发布前检查：在 240px、常规侧栏和编辑器区宽度下分别检查亮色、暗色、高对比主题；开启系统 Reduced Motion；验证 Drawer/Popover/Toast、流式回答、工具运行、尾部追加、跳转、披露和会话切换；10,000 节点时间线首屏不应出现逐行入场类，也不应因动画产生布局抖动。
