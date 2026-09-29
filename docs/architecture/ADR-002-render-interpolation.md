# ADR-002 · 渲染层采用「上一帧状态 + Lerp」的插值策略

| 字段 | 值 |
|---|---|
| **ADR ID** | ADR-002 |
| **标题** | 渲染层插值：记录上一帧状态 + 渲染层 Lerp |
| **状态** | ✅ **Accepted**（2026-10-12） |
| **决策者** | 游承峰（主理人）· 程基岩（技术负责人） |
| **相关 Spec** | `specs/09_renderer_bridge_spec.md`（§1.3 Out of Scope / §10 取舍 2）、`specs/10_render_juice_spec.md`（本决策的落地规范） |
| **影响面** | `src/ecs/components/PreviousTransformComponent.ts`（新）、`src/ecs/systems/TransformSnapshotSystem.ts`（新）、`src/ecs/systems/pipeline.ts`、`client/GameRenderer.ts`、`client/GameLoop.ts` |
| **取代** | 无（补上 ADR-001 §8 中登记的候选 ADR-002） |

---

## 1. 背景与问题（Context）

M5-T01 交付了只读渲染桥，但它在 `specs/09_renderer_bridge_spec.md` §1.3 里**显式把「渲染插值 / 帧同步平滑」列为 Out of Scope**，并在 §10 取舍 2 记录了代价：**按拍硬同步**。

按拍硬同步的机制是——`GameRenderer.syncWorld` 每渲染帧直接把 `TransformComponent` 的当前值投影成像素。它在**逻辑帧率与显示器刷新率整除**时看不出问题；但两者不整除时（60Hz 逻辑 vs 144Hz / 75Hz 显示器，或浏览器 `requestAnimationFrame` 与固定 16.667ms 拍之间的天然相位漂移），同一段匀速位移会被**不均匀地**投影：

- 某些渲染帧之间没有 `step`，画面停在原地（重复同一个位置）；
- 某些渲染帧之间跨了 `step`，画面突然跳一段。

人眼看到的是**抖动 / 顿挫（judder）**——尤其在本项目这种"高速动作"品类里，抖动会被直接读成"手感廉价"。

**核心问题**：在保持 ADR-001 全部确定性铁律（逻辑步长恒定、状态只读、`src/` 无墙钟）的前提下，如何让画面在任何刷新率下都平滑？

> 注：本 ADR 是 ADR-001 §8 中登记的候选 **ADR-002「渲染层插值与帧同步策略」**的正式落地。

---

## 2. 决策驱动因素（Decision Drivers）

| # | 驱动因素 | 权重 |
|---|---|---|
| D1 | **平滑**：匀速位移在任何刷新率下都应视觉匀速 | 高 |
| D2 | **确定性零污染**：插值绝不得进入 `src/` 的模拟路径，回放必须逐位不变 | 最高 |
| D3 | **只读契约不变**：渲染层仍只读 `World`，不得写回 | 最高 |
| D4 | **延迟可接受**：动作游戏对输入延迟敏感，插值带来的延迟必须小且有界 | 高 |
| D5 | **增量成本低**：不重写既有系统，只加一个观察者 | 中 |
| D6 | **向后兼容**：M5-T01 的冻结测试（`renderer_bridge.test.ts`）必须原样通过 | 中 |

---

## 3. 备选方案（Alternatives Considered）

### 方案 A：按拍硬同步（M5-T01 现状）
- ✅ **零延迟**：画的就是当前逻辑拍。
- ✅ **零复杂度**：不需要额外组件、不需要 alpha。
- ❌ **抖动**：见 §1。逻辑帧率与刷新率不整除时肉眼可见不均匀步进。这正是要还的债。

### 方案 B（**采纳**）：固定延迟 1 Tick 的插值（记录上一帧 + 渲染层 Lerp）
- 逻辑层每 Tick **开头**把 `TransformComponent` 硬拷贝进 `PreviousTransformComponent`；渲染层拿到 `alpha ∈ [0,1]`，输出 `prev + (curr - prev) * alpha`。
- ✅ **逐帧平滑**：渲染层在两个已知的逻辑位置之间线性过渡，刷新率任意。
- ✅ **确定性零污染**：插值只发生在 `client/`；`src/` 只多了一次纯拷贝，模拟结果逐位不变（D2）。
- ⚠️ **代价 = 1 Tick 视觉延迟**（60fps 下约 16.7ms）：渲染的永远是"上一拍 → 当前拍"之间的一点，而不是当前拍本身。这是**已知且有界**的延迟（D4）。

### 方案 C：外推 / 预测插值
- 用 `prev → curr` 的速度外推 `curr` 之后的位置，理论上零延迟。
- ❌ **过冲**：速度突变（急停、冲刺、命中）时画面会"冲过头"再弹回。
- ❌ **预测错**：命中 / 死亡 / 被冻结的瞬间，预测出的位置是错的——动作游戏里这会把"我明明打中了"变成"我打空了"。可读性与确定性都受损。否决。

### 方案 D：可变步长逻辑
- 让逻辑步长等于真实帧时间，从根上消除"逻辑/渲染不对齐"。
- ❌ **直接违反 ADR-001 R2 / R3**：可变步长把模拟结果与硬件性能绑死，回放、平衡对局、自动化测试全部失效。**排除，不予讨论。**

---

## 4. 决策（Decision）

**采用方案 B：记录上一帧状态 + 渲染层 Lerp（固定延迟 1 Tick）。**

具体固化为：

| # | 规则 | 理由 |
|---|---|---|
| R1 | 逻辑层新增 `PreviousTransformComponent`（POD，字段 `prevX` / `prevY` / `prevFacingRadians`），由 `TransformSnapshotSystem` **每 Tick 开头**硬拷贝 `TransformComponent` | 上一帧状态必须**早于任何位移写入**被捕获（见 R2） |
| R2 | `TransformSnapshotSystem` 是**管道第 0 段**（先于 `PlayerControllerSystem`） | 它必须是"上一帧位置"的唯一权威；任何位移系统都必须在它之后运行 |
| R3 | 渲染层接收 `alpha ∈ [0,1]`，输出 `prev + (curr - prev) * alpha`；`alpha` 越界必须 clamp | 渲染层只做只读投影；clamp 防止外推 |
| R4 | 角度按**最短弧**插值（差值归一化到 `[-π, π]`，两端都闭） | 朴素线性插值在跨 ±π 时会绕远路（见 `specs/10` §10 取舍 1） |
| R5 | `syncWorld(world, alpha = 1)`：`alpha` **默认 1** | `alpha = 1 ⇒ renderX = curr`，逐位等价 M5-T01 行为，冻结测试无需改动（D6） |
| R6 | 惰性挂载 `PreviousTransformComponent`（首次见到实体时以当前 Transform 播种） | 免去改动 `spawnCombatant` 的组件集合；运行中生成的判定圆自动覆盖 |

**为什么不把 `PreviousTransformComponent` 写进 prefab？** 若写进 `spawnCombatant`，则运行中由 `CombatActionSystem` 生成的判定圆、以及未来任何新增生成点都必须记得补上它，否则会出现"某些实体没插值"的隐性缺口。惰性挂载把这条不变式收敛到**一个系统里**，且不动 prefab 的组件契约（`spawn-helpers.ts` 零改动）。

---

## 5. 后果（Consequences）

### 5.1 正面
- ✅ **任何刷新率下都平滑**：渲染层在两拍之间过渡，逻辑仍是恒定 1/60。
- ✅ **确定性完全不变**：`TransformSnapshotSystem` 只读 `TransformComponent`、只写 `PreviousTransformComponent`，**没有任何游戏系统读它**。因此 M1–M4 的全部快照、回放、平衡对局逐位不变。
- ✅ **只读契约不变**：插值只在 `client/`；`src/` 仍不知道像素、不知道帧、不知道渲染。
- ✅ **增量成本低**：一个新 POD 组件 + 一个新系统 + 渲染层的一个乘法。

### 5.2 负面 / 成本
- ⚠️ **+1 Tick 视觉延迟（≈16.7ms @60fps）**：这是用"有界的小延迟"换"逐帧平滑"的显式取舍。动作游戏里 16.7ms 属于可接受区间（远低于一格输入延迟的体感阈值），且它**恒定**——恒定的延迟比抖动的零延迟更好读。
- ⚠️ **逻辑层多一个组件的内存与拷贝成本**：每 Tick 每个有 `TransformComponent` 的实体多一次 3 字段拷贝。当前规模（≤ 数十实体）可忽略；若未来剖析显示压力，可在 `src/` 侧评估（登记为候选）。
- ⚠️ **快照体积增大**：`snapshot()` 现在包含 `PreviousTransformComponent`。这是"多一个组件"的机械后果，回放比对不受影响（两遍都含它）。

### 5.3 中性
- `alpha` 的语义 = "累加器余数 / 拍时长"，即"已经走进下一拍的进度"。溢出清累加器时 `alpha` 自然为 0（渲染停在上一拍），与"掉速"语义自洽。

---

## 6. 合规与验证（Compliance & Verification）

| 规则 | 强制手段 | 位置 |
|---|---|---|
| R1 上一帧状态 | `TransformSnapshotSystem` 每 Tick 拷贝三字段 | `src/ecs/systems/TransformSnapshotSystem.ts` |
| R2 管道第 0 段 | 管道顺序断言（14 段） | `tests/combat/*` / `tests/ai/enemy_fsm.test.ts` 的 G4/G6/G7 顺序钉桩 |
| R3 插值 + clamp | `alpha ∈ {0, 0.5, 1}` 精确断言 + 越界 clamp 断言 | `tests/render/interpolation.test.ts` 用例 A / C |
| R4 最短弧 | 跨 ±π 的角度插值 | `client/GameRenderer.ts` 的 `shortestArcDelta` |
| R5 向后兼容 | `renderer_bridge.test.ts`（单参 `syncWorld`）原样通过 | `tests/render/renderer_bridge.test.ts` |
| D2 确定性零污染 | 快照回放逐位不变：M5-T02 落地前基线 **212** 用例，M5-T02 落地后 **234** 用例（**17** 个测试文件）全绿 | `npm run test` |
| 只读契约 | 渲染层源码不含写入符号 | `tests/render/*` + code review |

---

## 7. 相关链接
- `specs/09_renderer_bridge_spec.md` — 只读渲染桥（本 ADR 的前置；其 §10 取舍 2 是本决策要还的债）
- `specs/10_render_juice_spec.md` — 插值 + 跳字 + 受击闪烁的落地规范
- `docs/architecture/ADR-001-headless-ecs-foundation.md` — R1–R6 确定性铁律（本 ADR 不得违反任何一条）
- `src/ecs/systems/TransformSnapshotSystem.ts` — R1/R2/R6 的实现

---

## 8. 后续候选 ADR（已识别，未决）
| 候选 | 触发条件 |
|---|---|
| ADR-003 · ECS 存储布局：类式组件 vs 纯数据 SoA | M3 性能剖析显示 GC / 缓存压力时（沿用 ADR-001 §8） |
| ADR-004 · 随机数体系：种子派生与可回放 RNG | 首个程序化生成系统（房间/祝福）落地时 |
| ADR-005 · 系统执行顺序的显式声明（拓扑排序 vs 注册顺序） | 系统数超过 ~10 个、隐式顺序开始出错时（现为 14 段，已接近阈值） |
