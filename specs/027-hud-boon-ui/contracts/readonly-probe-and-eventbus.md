# Contract · 只读探针与事件总线（表现层 → 逻辑内核）

**Owner**：表现层｜**关联**：FR-030/031/032/033 · D4/D5/D10 · 宪法 Principle I / II / V / VI

---

## 1. 依赖方向（不可协商）

```text
client/ ──允许──▶ src/        （import 类型与只读导出）
src/    ──禁止──▶ client/     （MUST NEVER）
```

- 表现层 MUST 只 import `src/` 的**类型**与**只读导出**。
- MUST NOT 在 `src/` 下新增任何文件或改动任何文件（FR-030 / SC-007）。

## 2. 读取白名单（本特性允许的全部逻辑层读取面）

| 用途 | 探针 | 形态 |
|---|---|---|
| 生命 | `HealthComponent` | 组件只读 |
| 冲刺充能 | `DashStatsComponent` | 组件只读 |
| 金币 | `readGold(world)` | 自由函数 |
| 已拥有祝福 | `ModifierComponent.modifiers` | 组件只读 |
| 三选一选项 | `findRewardDraft(world)?.pendingRewards` | 只读派生 |
| 显示名 | `getRewardDefinition(id)` | 纯查表 |
| 终局 / 营地 | `isRunFailed` / `isRunWon` / `isInHub` | 只读谓词 |
| 描述数值 | `DataManager.getModifierConfig` / `POISON_STATUS_SPEC` / `HP_UP_AMOUNT` / `DASH_UP_COOLDOWN_REDUCTION` | 只读导出 |
| 帧事件 | `ClientEventBridge`（`TeeEventQueue`） | 观察者 |

## 3. 写入黑名单（MUST NOT 出现）

| 禁止 | 原因 |
|---|---|
| `world.addComponent` / `removeComponent` | 写世界 |
| `applyDamage` / `addModifier` / `removeModifier` / `grantReward` | 改状态 |
| `sim.step` / `scheduler` 任何推进 | 推进模拟（FR-033） |
| `world.rng` 任何调用 | 消费随机 ⇒ 破坏确定性 |
| `selectReward` 直接调用 | 选择 MUST 经组合根转成输入事件 |
| `snapshot()` 的**写**路径 | — |

## 4. 意图回传路径（UI 不越权）

```text
用户点击卡片 → UIManager.onSelect(id) → 组合根(main.ts) → sim 输入事件(selectReward)
用户点击天赋 → UIManager.onPurchase(id) → 组合根 → sim.purchaseMetaUpgrade(id)
Tab 键       → UIManager 内部状态切换（**不**触碰 sim）
R 键         → UIManager.onEnterHub() → 组合根 → sim.enterHub()
```

**契约**：UI 只**声明意图**；逻辑层**重新校验**一切（例如买不起的天赋由模拟器拒绝，而不是靠 `disabled` 属性）。DOM 属性不是安全边界。

## 5. 事件总线（可选反馈）

- `ClientEventBridge` 是 `EventQueue<T>` 的子类（`TeeEventQueue`），`emit` 覆写后**先缓冲再委托** ⇒ 内核看到的是普通 `EventQueue`，**`src/` 零改动**（Liskov 兼容）。
- 本特性 MAY 用它驱动 HUD 的**瞬时反馈**（如受伤时生命条闪红、冲刺就绪时的提示）。若使用：
  - MUST 在 run 边界调用 `bridge.clear()`（`scheduler.reset()` 触不到客户端缓冲）；
  - MUST NOT 用事件驱动任何**状态**（状态一律来自只读探针），事件只做**瞬时动画**。

## 6. 无损与确定性的证明义务

| 要求 | 判据 |
|---|---|
| 无损 | 固定种子 + 固定输入，改动前/后快照摘要**逐位相同**（基线 `f52dfdd4`） |
| 零改动 | `git diff --stat src/` 为空 |
| 管道不变 | 逐 Tick 管道仍 17 段，顺序不变 |
| 随机不变 | `World.rng` 调用序列与改动前逐 Tick 相同 |

## 7. 不变式清单

1. 表现层是 `World` 的**只读消费者**：MUST NOT 写、MUST NOT 推进。
2. 所有数值读数 MUST 来自**单一来源**（逻辑层），表现层 MUST NOT 维护第二份数值。
3. `src/` 零改动、管道 17 段、依赖单向 —— 三者同时成立才算通过。
