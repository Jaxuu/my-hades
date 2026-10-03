# Contract · HUD / 卡片 / Tab 面板 / 覆盖层（DOM 界面契约）

**Owner**：表现层｜**关联**：FR-001…007、FR-020…026、FR-040…042、FR-050…052 · D5/D6/D7/D8/D9/D14 · 既有 `tests/ui/*`

---

## 1. 承载方式

- 全部界面为 **DOM + CSS**（`index.html` 内联样式 + `client/UIManager.ts` 建节点），**不进入 Pixi 场景图**（D5）。
- 因此本特性**不触碰**渲染场景图的 6 条冻结契约（`stage` 唯一子=camera / `camera.children[last]`=root / `root.children[last]`=fxLayer / `root.children[0]`=首个实体视图 / 无墙时 `camera.children` 长恰 1 / 空闲时 `fxLayer.children` 长恰 0）。

## 2. 冻结钩子（MUST 保留；变更 MUST 显式登记）

由 `tests/ui/ui_skin.test.ts` 逐字钉死：

| 类别 | 值 |
|---|---|
| **class** | `is-visible` · `is-death` · `is-win` · `is-hub` · `reward-button` · `talent-button` · `start-button` · `hub-currency` · `hub-talents` · `death-hint` |
| **id** | `app` · `ui-layer` · `hud` · `gold` · `keys` |
| **M16 skin 钩子** | `ui-card` · `ui-hint` · `ui-currency` · `ui-list` · `ui-button-primary` · `ui-heading` |

**规则**：视觉可自由替换；上述字符串 MUST 同时存在于 `index.html` 与 `client/UIManager.ts`。新增皮肤钩子 MUST **追加**，MUST NOT 替换冻结项（FR-042）。

## 3. 表面与优先级（至多一个在屏）

```text
#ui-layer（overlay root，互斥）
├── is-death           终局（最高优先级）
├── is-win             终局
├── is-hub             营地
├── is-status   ← 新增 Tab 局内状态面板（非阻塞）
└── （无 class）        三选一 draft
#hud-material ← 常驻材质 HUD：生命 + 冲刺（新增 id），不受 overlay 影响
#gold         ← 常驻材质金币牌（复用既有 id），不受 overlay 影响
#hud          ← 常驻诊断块（tick / counts），与材质 HUD 明确分离
#keys         ← 常驻按键提示
```

> **HUD 的 DOM 归属（A2 裁定）**：材质 HUD **拆为两个既有/新增 id** —— 新增 `#hud-material` 承载**生命 + 冲刺**，`#gold` 复用为**金币牌**，`#hud` **保留为诊断块**。三者读数 MUST NOT 重复或矛盾（FR-007）；5 个冻结 id **零删除**。

**优先级契约**：终局 > 营地 > draft / status。Tab 面板 MUST NOT 覆盖终局界面，也 MUST NOT 与 draft 同时呈现冲突内容（FR-026）。

## 4. HUD 契约（FR-001…007）

| 组件 | 表达 | 边界 |
|---|---|---|
| **生命** | 数值（`hp`/`maxHp`）+ 比例条 | `maxHp=0` ⇒ 比例 0；`hp=0` ⇒ 濒危态 |
| **冲刺充能** | 可用 / 冷却中 + 进度 | `cooldownRemaining=0` ⇒ 可用；`cooldownTicks=0` ⇒ 进度 1 |
| **金币** | 当前 run 金币数 | ≥ 0；极值不溢出 |

- 常驻：任何帧、任何 overlay 下 MUST 正确（FR-005）。
- 只读：MUST NOT 写世界（§ `readonly-probe-and-eventbus.md`）。
- 无变化时 MUST NOT 重建节点 / 闪烁（FR-006，值比较后短路）。
- `#hud-material` / `#gold` / `#hud` 三者 MUST NOT 产生重复或矛盾读数（FR-007）。

## 5. 祝福卡片契约（FR-010…017）

- 三要素：**品质颜色** + **图标** + **数值化描述**。
- 触发 / 数量沿用既有 draft（**不改**抽取与触发，FR-010）。
- 品质来自 `boons.json`（`ui-boon-data-table.md`），**纯外观**（FR-016）。
- 描述数值 MUST 与逻辑层一致（FR-014）。
- 点击 → `onSelect(id)` → 组合根 → 输入事件（不越权，FR-015）。
- 缺失元数据 ⇒ 降级（默认品质 + 占位图标 + 安全描述，FR-017）。

## 6. Tab 面板契约（FR-020…026）

- **非阻塞**：打开 MUST NOT 改变 `sim.step` 的次数或结果（SC-006）。
- 内容 = 玩家当前 `ModifierComponent.modifiers` 的完整集合 + 每项描述（SC-005）。
- 空集合 ⇒ 明确空状态；大量 ⇒ 可滚动（FR-024）。
- Tab 监听生命周期：**激活即挂载、退出即移除**（沿用 `handleHubKey` 模式），终局 / 营地 / `destroy()` 后 MUST NOT 残留监听（FR-025）。

## 7. 覆盖层统一（FR-040/041）

- 沿用既有 `--ui-*` 槽位（`--ui-overlay-death` / `--ui-overlay-win` / `--ui-panel-camp` …），替换为同一 HD 语言贴图。
- 交互契约**零改动**：`R` 回营地 / 购买天赋 / 开始逃离 / 终局优先级。

## 8. 降级契约（FR-050）

- 全部 UI 贴图经 `--ui-*` 注入，默认 `none`。
- 任一资产缺失 / 解码失败 ⇒ 回退**纯 CSS** 表现，界面**仍可读可用**，MUST NOT 崩溃 / 黑屏 / 阻塞循环。
- 降级是**逐条目**的（沿用 `AssetCatalog` 契约）。

## 9. 可读性与可达性（FR-051/052）

- **无网络字体**：MUST NOT 出现 `@font-face` 或字体文件引用（`tests/ui/text_readability.test.ts` 冻结）。
- **中文回退**：字体栈 MUST 含 `PingFang SC` / `Microsoft YaHei` / `Noto Sans CJK SC`。
- **焦点环**：全部可交互元素 MUST 可聚焦且焦点可见（`.ui-card:focus-visible` 等既有规则 MUST 保留）。
- **品质多通道**：颜色之外另用边框纹样 / 角标 / 文字标签（D14 / SC-014）。

## 10. 源码文本扫描红线（⚠️ 由技术总监 / 质量总监复核发现）

`tests/ui/ui_skin.test.ts` 与 `tests/ui/text_readability.test.ts` **不是 DOM 测试，而是对 `index.html` 与 `client/UIManager.ts` 的源码文本扫描**。因此以下三条是**实现期极易踩中的硬红线**，违反即「948 例不再全绿」：

| # | 红线 | 依据 | 后果 |
|---|---|---|---|
| **R-a** | `client/UIManager.ts` MUST 保留 **≥3 处字面 `document.createElement('button')`**（**单引号**） | `ui_skin.test.ts` F4 以正则扫描该字面量 | 用双引号 / 抽工厂函数 / 改成模板字符串 ⇒ 正则失配，断言失败 |
| **R-b** | MUST NOT 新增任何 `--font-*` 变量 | `text_readability.test.ts` T4 断言字体栈 `stacks.length === 2` **精确相等** | 加第三个 `--font-*` ⇒ 计数不符，断言失败 |
| **R-c** | `index.html` 中 `#hud, #keys, #gold {` MUST 保持**连续且同序** | `text_readability.test.ts` T7 以该正则定位共享样式块 | 重排选择器顺序 / 插队 ⇒ 正则失配，断言失败 |

> ⚠️ **R-c 的连带风险（A2 引入 `#hud-material` 后）**：新增的 `#hud-material` **MUST NOT** 被插入 `#hud, #keys, #gold {` 这个选择器列表（会同时破坏 T7 正则与「连续同序」）。其样式 MUST **独立声明**（如 `#hud-material { … }`）。

**推论**：HUD 三组件的节点创建 MUST 走**新增的工厂/辅助函数**，**不得**替换或重写既有三处 `createElement('button')`；新增字体需求一律复用既有 `--font-body` / `--font-mono`。

## 11. 新增 `--ui-*` 槽位登记（追加，不替换）

本特性新增的 UI 贴图槽位 MUST 在 [`ui-asset-slots.md`](./ui-asset-slots.md) 登记（美术总监交付物附录 A 已列），且：

- 全部**默认 `none`**（降级契约）；
- **既有槽位名一律不变**（FR-042）；
- 槽位**只增不减**。

## 12. 不变式清单

1. 冻结钩子字符串 MUST 同时存在于 `index.html` 与 `UIManager.ts`。
2. 界面 MUST NOT 进 Pixi 场景图（6 条冻结契约零风险）。
3. HUD MUST 常驻且只读；overlay MUST 互斥。
4. 无资产时界面 MUST 仍可用（纯 CSS 回退）。
5. `client/` 变更 MUST 通过 `npm run typecheck:client`；`GameRenderer` 导入图 MUST NOT 含 `howler`。
