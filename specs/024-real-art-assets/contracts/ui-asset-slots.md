# Contract · 界面资产槽位（UI Asset Slots）

**Feature**: `024-real-art-assets` · **Version**: 1.0.0 · **Date**: 2026-10-01

界面是 **DOM**（`index.html` 的 `<style>` + `client/UIManager.ts`）。本契约把「界面面 → 资产槽位」固定下来，使重皮可验证、可回退，且**不改变 `UIManager` 的逻辑**（FR-018 / FR-019）。

---

## 1. 界面面与类钩子（既有，不得改名）

| 界面面 | 容器/钩子 | 触发（只读） |
|---|---|---|
| HUD 数值 | `#hud` | 每帧 |
| 金币/暗影 | `#gold` | 每帧 |
| 奖励三选一 | `#ui-layer.is-visible` + `.reward-button` | `findRewardDraft` |
| 死亡 | `#ui-layer.is-visible.is-death` + `.death-hint` | `isRunFailed` |
| 胜利 | `#ui-layer.is-visible.is-win` | `isRunWon` |
| 营地 | `#ui-layer.is-visible.is-hub` + `.hub-currency` / `.hub-talents` / `.talent-button` / `.start-button` | `isInHub` |

## 2. 槽位表

| 槽位 | 资产 | 消费方式 |
|---|---|---|
| `ui.panel.hud` | HUD 背板 | CSS `background-image` |
| `ui.font.display` | 标题显示字体（可选，拉丁） | CSS `@font-face` + `font-family` |
| `ui.panel.reward` | 三选一面板 | CSS `background-image`（九宫格） |
| `ui.frame.reward-card` | 选项卡框 | `.reward-button` 背景 |
| `ui.overlay.death` | 死亡覆盖层 | `#ui-layer.is-death` 背景 |
| `ui.overlay.win` | 胜利覆盖层 | `#ui-layer.is-win` 背景 |
| `ui.panel.camp` | 营地面板 | `.is-hub` 背景 |
| `ui.frame.talent-card` | 天赋卡框 | `.talent-button` 背景 |
| `ui.button.primary` | 主按钮 | `.start-button` 背景 |
| `ui.icon.gold` / `ui.icon.heal` / `ui.icon.darkness` | 掉落物与货币图标 | `<img>` / 伪元素 |

## 3. 承诺（MUST）

1. **逻辑零改动**：`UIManager.ts` 的 `sync` / `render*` / `clear*` 分支与判断 MUST NOT 因重皮而改变；仅允许增/改 `className` 与静态标记。
2. **类钩子是超集**：既有类名（`is-visible` / `is-death` / `is-win` / `is-hub` / `reward-button` / `talent-button` / `start-button` / `hub-currency` / `hub-talents` / `death-hint`）MUST 全部保留，供既有与新增测试选择器使用。
3. **可点击性不回退**：按钮 MUST 保持原生 `<button>` 语义（可聚焦、可键盘触发）；MUST NOT 用不可聚焦的 `div` 替代。
4. **文字可读（FR-019）**：中文 MUST 清晰可读，MUST NOT 出现乱码/方块；不打包全量 CJK 字体（D7），依赖系统字体栈回退。
5. **降级**：任一界面资产缺失 ⇒ MUST 回退为纯 CSS 面板，按钮仍可点击、选项仍可辨识（SC-007）。
6. **不进 Pixi 场景图**：界面 MUST NOT 新增任何 PixiJS 常驻节点（保护 F1–F6，D5/D6）。
7. **状态即文案**：界面显示的数值/选项 MUST 仍来自对 `World` / `SaveState` 的只读读取；MUST NOT 在界面侧缓存出「第二份真相」。

## 4. 违例判定

| 场景 | 期望 |
|---|---|
| `git diff` 中 `UIManager.ts` 出现分支/判断变更 | 评审拒绝 |
| 断言既有类名仍存在于 `index.html` 的样式表中 | 通过（承诺 2） |
| 键盘 `Tab` + `Enter` 可触发三选一与营地按钮 | 通过（承诺 3） |
| 覆盖层上的中文在无网络、无自定义字体时可读 | 通过（承诺 4） |
| 移除 `ui.overlay.death` 资产后进入死亡界面 | 仍显示可读覆盖层（承诺 5） |
| 断言 `app.stage.children.length === 1` | 通过（承诺 6） |
