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
assets/art/      美术资产：hd/ 高清世界图集（M18）· ui/ 界面贴图 · LICENSES.md 许可登记
assets/audio/    音效资产（CC0）：sfx/ 成品 · raw/ 可复现的原始素材
client/          表现层（组合根、渲染器、UI、音视频桥、assets/ 资产接入层）
docs/            ADR-001 / ADR-002 / ADR-004
specs/00…25      规格（每个里程碑一份验收基线）· specs/024…026 为特性规格
src/core/        模拟器、时钟、调度器、关卡加载、PRNG、存档
src/ecs/         World / Entity / Component / System + components / systems / prefabs
tests/           947 例：harness · combat · physics · render · world · data · meta · ai · audio · assets · ui · performance
```

---

## 6. 快速开始

```bash
npm install

npm run dev              # Vite 开发服务器（含 JSON 热重载：改数据表即时重开同一 run）
npm run dev              # → 然后打开 http://localhost:5173/?mode=stress  ← 极限压测房
npm run build            # 生产构建
npm run preview          # 预览构建产物

npm test                 # Vitest 全量（1126 例）
npm run typecheck        # 逻辑层 + 测试 类型检查
npm run typecheck:client # 表现层类型检查（独立 tsconfig，含 DOM lib）
npm run lint             # ESLint 9（含 src/ 的 headless / 确定性 AST 门禁）
```

### 操作

`W A S D` 移动 · `J` 攻击 · `K` 冲刺 · `R` 终局后回营地

### 美术与音效资产（M18 / spec 026）

全部视觉与听觉素材都是**本地分发**的开放许可资产，运行期**零外部请求**（离线可用）。
来源、逐项许可与做过的处理见 [`assets/art/LICENSES.md`](assets/art/LICENSES.md) 与
[`assets/audio/LICENSES.md`](assets/audio/LICENSES.md)。

**M18 把局内世界美术从 16×16 像素整体换成 128 基准的高清逐帧图集**，像素图集、
像素派生生成器（`build-atlas.py`）与像素源素材包已**彻底移除**（FR-016…FR-018）。

| 用途 | 来源 | 形态 |
|---|---|---|
| 玩家（4 向 × 6 动作）、6 类敌人（4 向 × 5 动作 + `dash` 别名） | 本仓库原创 · 程序化生成（CC0-1.0） | 128² / 96² / 160² 逐帧图集 |
| 地牢墙体 / 地面 | 同上 | 128²；墙体含**格内三带**（顶面 55% / 立面 43% / 墙脚阴影 2%）+ **8 邻 47 部件 autotile**；地面 8 个变体（按格坐标确定性哈希选件） |
| 命中火花 / 冲刺拖尾 / 危险预警环 / 三类掉落物 | 同上 | 128² 贴花（火花运行时仍为 `Graphics` 纹理填充） |
| 界面面板 / 边框 / 按钮 / 覆盖层 / 图标 | Fantasy UI Borders · Pixel UI pack（Kenney，CC0） | **本特性不改动**（FR-030） |
| 音效 | RPG / Digital / UI Audio（Kenney，CC0） | **本特性不改动**（FR-030） |

**纹理过滤**：全局默认保持 `nearest`（M17 像素锐利契约），**HD 世界美术按纹理显式设
`linear` + mipmap** —— 放大不出现锯齿、缩小不出现摩尔纹（FR-025）。

**体积**：`assets/art/**` ≈ **634 KB**（预算 12 MB），单文件最大 ≈ 51 KB（预算 3 MB），
单图集最大 2000×700（上限 4096²），图集数 10（上限 12）。

**如何替换 / 扩展**：

1. 把新的 HD 素材导出为**逐帧图集**：`<spriteId>.<action>.<facing>.<n>` 命名，
   相邻帧留 ≥ 4px 透明 gutter，并在图集 JSON 里声明 `frames` / `animations` / `meta.scale`
   / `meta.tilePx`（契约见 `specs/026-hd-2d-art-assets/contracts/hd-spritesheet-schema.md`）；
2. 放进 `assets/art/hd/`（按**装载单元**切分：player 1 张 · 每类敌人 1 张 · tiles 1 张 · fx 1 张）；
3. 在 `assets/art/LICENSES.md` 登记新条目（`tests/assets/licenses.test.ts` 会核对）；
4. 在 `client/assets/manifest.ts` 里登记 id —— 它是**全仓唯一**直接 import 资产文件的地方，
   所以**漏文件会让 `npm run build` 直接失败**，不会留到运行期 404。

> 当前图集是**程序化生成的占位 HD 资产**，可用 `node production/m18-placeholder-atlases.mjs`
> 重新生成；真实 HD 美术就位后该脚本与占位图集一并退役。

**降级**：任一资产缺失或解码失败只影响它自己 —— 该元素退回高清之前的几何占位（或静默），
其余照常，游戏不崩溃、不黑屏（`tests/assets/degradation.test.ts`；真实浏览器实测见
`production/m18-evidence.md` 的 T064）。

### 界面重构（M19 / spec 027）

**M19 把界面从「角落纯文本读数 + 英文名文字按钮」升级为材质化 HD 界面**，且**完全不动逻辑内核**
（`src/` 零改动、逐 Tick 摘要逐位不变）。四块内容：

| 表面 | 内容 |
|---|---|
| 局内 HUD | 生命 = 数值 + 三态比例条；冲刺 = 可用/冷却 + 进度环；金币 = 读数牌（取代纯文本） |
| 三选一卡片 | 每卡三要素：**品质色**（蓝/紫/金）+ **CSS 字形图标** + **数值化描述** |
| Tab 状态面板 | 呼出/收起已拥有祝福与描述，**不暂停**（开/关两条轨迹逐 Tick 一致） |
| 死亡/胜利/营地覆盖层 | 纳入同一 HD 视觉语言，语义与交互契约不变（`R` 回营地 / 购买 / 开始逃离） |

- **品质是纯外观**：`common #3f6ea8` / `epic #8a5cd0` / `legendary #ffcd4a` 三色 +
  非颜色通道（中文标签 / 1·2·3 角标 / 方·切·冠轮廓），**不参与任何随机或数值**。
- **描述数值只读派生**：卡面数字取自 `modifiers.json` / `POISON_STATUS_SPEC` /
  `HP_UP_AMOUNT` / `DASH_UP_COOLDOWN_REDUCTION`，表现层**零数值字面量**。
- **数据**：`client/assets/boons.json`（5 条），经 `client/ui/boon-catalog.ts` 静态解析；
  `src/**` **不**引用它。
- **资产**：7 个 48×48 九宫格框体（`assets/art/ui/`，本仓库原创 · 程序化生成 ·
  `node production/m19-ui-frames.mjs`），经 `client/assets/manifest.ts` 的 `?url` 静态导入。
- **降级**：7 个 `--ui-*` 槽位默认 `none` ⇒ 各表面回退纯 CSS（实心条 / `conic-gradient` 环 /
  品质边框 / CSS 字形或 `◆`），**只去装饰，绝不去文字与状态色**，离线可用、零外部请求。

> 证据与判定见 `production/m19-evidence.md`（五道闸门、摘要 `f52dfdd4`、性能比值、三条源码扫描红线自证）。

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

**M15-T01** — 极限压测、无损性能优化与 **1.0 收官**。

**M16 → M18** — 无损快照摘要管线 · 相机缩放与瓦片地图 · 高清 2D 美术与动画资产（`specs/024`…`026`）。

**M19（本版本）** — 界面重构：材质化 HUD、三选一祝福卡片、Tab 状态面板与统一覆盖层视觉语言（`specs/027-hud-boon-ui`）。纯表现层，`src/` 零改动。

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

`1.0.0` — 逻辑内核、表现层、数据管线、局外成长与压测基线全部就位。**1126 例测试全绿**，`typecheck` / `typecheck:client` / `lint` / `build` 零告警。
