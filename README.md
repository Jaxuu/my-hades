# my-hades

> 一个 **Headless 确定性动作肉鸽（Hades-like）内核**：全部玩法逻辑跑在无渲染、无 DOM、无墙钟的纯 TypeScript 里，PixiJS 只是它的一个**只读消费者**。

`1.0.0` · Node ≥ 22 · TypeScript `strict` · 零运行时依赖（`client/` 例外：pixi.js 8 + howler 2.2）

---

## 1. 四大支柱

| 支柱 | 含义 | 落地 |
|---|---|---|
| **Headless ECS** | 逻辑层不碰 DOM / Canvas / WebGL，也不读墙钟与随机。时间只由 `step()` 推进 | `src/`（零浏览器 API）· `eslint.config.mjs` 的 AST 门禁 |
| **PixiJS 表现层** | 渲染层是 `World` 的**纯消费者**：只读组件，从不调用任何写 API，也从不推进模拟 | `client/` · 单向依赖 `client → src` |
| **SDD（规格驱动）** | 每个里程碑先冻结规格、再实现、后评审；数值一律来自数据表 | `specs/00` … `specs/23` · `docs/architecture/ADR-*` |
| **Determinism（确定性）** | 同一输入 ⇒ 逐 Tick 同一状态。可重放、可对拍、可快照比对 | 固定步长时钟 · 单一 seeded PRNG · 深冻结快照 |

---

## 2. 架构总览

```
                 ┌──────────────────────── 表现层 client/ ────────────────────────┐
                 │  main.ts（组合根）                                              │
                 │    ├── GameLoop   真实时间 → 固定 Tick → 每帧一次 syncWorld     │
                 │    ├── GameRenderer  World → PixiJS 场景图（只读）              │
                 │    ├── UIManager    草稿 / 死亡 / 胜利 / 营地 四态覆盖层        │
                 │    ├── ClientEventBridge  旁观命中/死亡/冲刺事件（Tee 队列）     │
                 │    ├── VFXManager   受击火花（世界空间、惰性挂载）              │
                 │    └── AudioManager howler 合成占位音（静默降级）               │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 │  只读：World / snapshot / 事件
                                                 ▼
                 ┌──────────────────────── 逻辑层 src/ ───────────────────────────┐
                 │  core/  GameSimulator · FixedClock · Scheduler · LevelLoader    │
                 │         Random(seeded) · SaveState · MetaProgression           │
                 │  ecs/   World · Entity · Component(POD) · System                │
                 │         components/ · systems/ · prefabs/ · modifiers/          │
                 │  data/  DataManager · schemas（加载期大声校验）· bundled        │
                 └───────────────────────────────┬─────────────────────────────────┘
                                                 │  读：assets/data/*.json（Bootstrap 期一次校验）
                                                 ▼
                                     assets/data/*.json（唯一数值来源）
```

### 2.1 逐 Tick 管道（**硬契约，17 段，顺序不可重排**）

```
TransformSnapshot → PlayerController → Freeze → AI → Hazard → Movement → Dash → State
  → CombatAction → Collision → StatusEffect → Modifier → Death → Encounter → Reward
  → Pickup → Lifespan
```

- `TransformSnapshotSystem` 恒 **idx 0**（它是「本 Tick 开始时各实体在哪」的唯一权威，供渲染插值）。
- `LifespanSystem` 恒 **LAST**（一个判定圆必须活满自己的 `activeTicks` 才被回收）。
- 顺序即语义：例如 `Hazard` 在 `Movement` **之前**，所以延迟 AoE 落在「你此刻站的地面」，本 Tick 的位移就是你的闪避窗口。
- 改管道会打破 **9 处钉桩测试**（`grep -rl "'TransformSnapshotSystem'" tests/`），段数由 `toHaveLength(N)` 钉死。

### 2.2 单向依赖（机器可执行）

`src/**` **禁止** import `pixi.js`、`client/**`、`window`、`document`、`Math.random`、`Date.now`、`new Date()`、`localeCompare`、`toLocale*`、`Intl` —— 全部由 ESLint AST 门禁强制（`npm run lint`）。反向（`client → src`）永远允许。

---

## 3. 确定性

| 机制 | 说明 |
|---|---|
| **固定步长** | `FixedClock`；`elapsedSeconds = totalTicks × fixedDeltaSeconds`（**乘法**，禁硬编码 1/60） |
| **单一 PRNG** | `World.rng`（ADR-004）。所有随机消费者共享**一条**流；`src/` 只读不播种，选种子是调用方的事 |
| **确定性遍历** | 一律走 `World.query`（按 id 升序）；字符串排序用 UTF-16 码元序，禁 `localeCompare` / `Intl` |
| **快照** | `GameSimulator.snapshot()` 深拷贝 + 递归冻结，与活世界零共享引用；可对拍、可回归 |
| **无隐藏状态** | 系统禁跨 Tick 隐藏状态；组件是 POD（无方法），操作是自由函数 |

> 结果：**同输入 ⇒ 逐 Tick 同状态**。重放、回放对拍、快照回归全部成立。

---

## 4. 数据驱动（SDD 的落地形态）

所有业务数值都在 `assets/data/*.json`，工厂只做装配与查表：

| 文件 | 内容 |
|---|---|
| `enemies.json` | 敌人类型：`grunt` / `elite` / `raider` / `bomber` / `gunner` |
| `encounters.json` | **按 depth 索引**的房间序列（房间 `d` = 表项 `d`），超界**循环复用** |
| `rooms.json` | 地形库：二维整数网格（`0` 空地 / `1` 墙 / `2` 玩家点 / `3` 刷怪点） |
| `modifiers.json` | 祝福（boon）模板 |
| `projectiles.json` / `hazards.json` | 弹道与复合危险地形模板 |
| `meta_upgrades.json` | 局外天赋与价格 |

**加载期大声失败**：`Bootstrap` 阶段（`await bootstrapData()`）一次性校验全部表，含**跨表规则**（波次引用的敌人都存在、房间 id 都能解析、`onExplodeConfigId` 无环）。`step()` 内**零 IO、零校验、零抛错**。一个坏 JSON 会在启动时报出**具体字段路径**，而不是让敌人血量变成 `NaN`。

地形在加载期做**贪心矩形合并**：`rooms.json` 里 116 个 `1` 格 → 4 个 `WallComponent` AABB，合并**精确等价**（并集相同、面积守恒）。

---

## 5. 目录结构

```
assets/data/     配置表（唯一数值来源）
client/          表现层（组合根、渲染器、UI、音视频桥）
docs/            ADR-001 / ADR-002 / ADR-004
specs/00…23      规格（每个里程碑一份验收基线）
src/core/        模拟器、时钟、调度器、关卡加载、PRNG、存档
src/ecs/         World / Entity / Component / System + components / systems / prefabs
tests/           642 例：harness · combat · physics · render · world · data · meta · ai · audio · performance
```

---

## 6. 快速开始

```bash
npm install

npm run dev              # Vite 开发服务器（含 JSON 热重载：改数据表即时重开同一 run）
npm run dev              # → 然后打开 http://localhost:5173/?mode=stress  ← 极限压测房
npm run build            # 生产构建
npm run preview          # 预览构建产物

npm test                 # Vitest 全量（642 例）
npm run typecheck        # 逻辑层 + 测试 类型检查
npm run typecheck:client # 表现层类型检查（独立 tsconfig，含 DOM lib）
npm run lint             # ESLint 9（含 src/ 的 headless / 确定性 AST 门禁）
```

### 操作

`W A S D` 移动 · `J` 攻击 · `K` 冲刺 · `R` 终局后回营地

### `?mode=stress`

一个 URL 后门：把 `runSetup` 换成 `buildStressRun`，直接站进 **30×30 的 `stress_room`**，面对 `encounters.json` 在 `depth: 2` 声明的 **150 敌单波**（100 `grunt` + 50 `gunner` 远程精英）。

房间尺寸与波次构成**全在数据表里**——重调压测场景是改 JSON，不是改代码。除 `runSetup` 外，管道、存档、事件桥、渲染器全是生产接线，所以这个房间是一次**真实**压测。

---

## 7. 压测与性能（如实记录）

`tests/performance/` 有两个套件：

**`stress.test.ts`** — 无头吞吐 + 逻辑层内存守卫

| 指标 | 实测 |
|---|---|
| 600 Tick × 150 敌（~174 实体，全 17 段管道） | **~460ms**（单跑，≈ 1300 逻辑 Tick/s，60Hz 下约 **22x 实时余量**）；全量 37 文件并发时 ~860ms |
| 300 / 50 敌 缩放比 | **~5.1**（6x 兵力：线性≈6、二次≈36；阈值 9） |
| 10 次房间切换后的实体数 | **持平**（`2 + wallCount`）；墙体 / 掉落物 / 危险区 / 判定圆全部回收 |

**`render_leak.test.ts`** — 表现层泄漏守卫

5 × (`restartRun` + `syncWorld` + `reset`) 后：`Graphics` / `Text` 计数为 **0**、`retired` 为空、场景图恰 3 节点；且每轮**先证有**再证无（防恒真断言）。另证明：**不调** `reset()` 时 `retired` 会无界增长，`reset()` 是修复。

### M15 的无损优化（快照摘要逐位一致）

| 位置 | 改动 | 效果 |
|---|---|---|
| `World.query` | store 查找提到实体循环外；去掉对**已升序**结果的冗余 `sort` | 单次查询 ~2.3x |
| `MovementSystem.separateBodies` | 每对的 6 次 `getComponent` 降为 0（槽位表预解析，位置仍就地改写） | 分离相位 ~18x |
| `CollisionSystem` | 目标侧 4 次 `getComponent` + `isDead` 预计算为每 Tick 一次 | ~2x |

**优化前后同一 seed 的 601-Tick 快照摘要逐位相同**（`2309042484`，174 实体）。

**变异实验（证明守卫不是恒真断言）**：把分离相位换回 M15 前实现，300/50 缩放比立刻从 **5.06** 冲到 **18.98** ⇒ 缩放测试**失败**；还原后复现。另：把 `factions` 误用 `Int32Array`（字符串枚举被数值化成 `0`）摘要立刻变为 `2992069332`（实体数 174 → 198）。

> ⚠️ **诚实声明**：M15 原文要求「600 Tick < 100ms」。**该目标未达成**（实测 ~460ms，差 ~4.6x）。剩余成本**不是算法问题**，而是 17 段管道 × ~174 实体的固定每实体开销（每 Tick ~26 次 `World.query` + ~5.5k 次 `World.getComponent`，每次 2 次 `Map` 查找）。要压到 100ms 必须重写 `World` 组件存储并改写每个系统的读取方式——那会改动**核心逻辑与测试契约**，超出「无损优化」的边界。详见 `specs/23_stress_and_release_spec.md` §7 T1。

---

## 8. 里程碑

M0–M14 已交付（ECS 地基 → 角色控制 → 冲刺/状态机 → 命中判定 → 打击反馈 → 祝福/修饰器 → 状态与持续伤害 → 敌人 AI → 遭遇与死亡 → 渲染桥 → 手感/插值 → 肉鸽循环 → 护甲与冲刺祝福 → 竞技场与弹道 → AoE 与 run 生命周期 → 经济与胜利 → 数据驱动管线 → 遭遇热重载 → 高级弹道与危险地形 → 房间拓扑与瓦片地图 → 引擎优化与相机 → 营地与局外成长 → 音频与打击感）。

**M15-T01（本版本）** — 极限压测、无损性能优化与 **1.0 收官**。

权威规格见 `specs/00` … `specs/23`；架构决策见 `docs/architecture/ADR-001`（headless ECS）、`ADR-002`（渲染插值）、`ADR-004`（确定性 PRNG）。

---

## 9. 测试哲学

- **真实系统，不用 mock**：跑真的 `GameSimulator` 与真的 17 段管道。
- **钉时序**：`step(1)` 钉单 Tick 时序，浮点位移容差 `1e-9`。
- **反恒真**：`字段 === 构造它的那个常量` 是恒真陷阱 ⇒ 必配**字面量钉桩**或**行为断言**。「状态被设置」≠「效果被施加」。
- **反空真**：断言「什么都没有」之前，先断言「曾经有过」。
- **变异实验**：门控类改动必须临时破坏、确认断言**真的会失败**，再备份还原。
- **node-only**：纯逻辑测试跑在 Node，无 jsdom；渲染套件用鸭子类型 `Application` 在 Node 下驱动真 PixiJS 场景图。

---

## 10. 状态

`1.0.0` — 逻辑内核、表现层、数据管线、局外成长与压测基线全部就位。**642 例测试全绿**，`typecheck` / `typecheck:client` / `lint` / `build` 零告警。
