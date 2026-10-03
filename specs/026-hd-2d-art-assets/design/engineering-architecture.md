# 渲染层接入架构与测试改写方案（M18 · 026-hd-2d-art-assets）

> **作者**：技术总监 程基岩（engineering-lead）
> **日期**：2026-10-02
> **权威来源**：`specs/026-hd-2d-art-assets/spec.md`（31 FR / 14 SC）、`.specify/memory/constitution.md`、`plan.md`、`data-model.md`、`contracts/{hd-asset-manifest,renderer-asset-mapping}.md`、`quickstart.md`。
> **定位**：本文件是 `plan.md` 的**工程深化**——把「改什么」落到「改哪个文件的哪一行、怎么改、测试怎么守」。所有决策均为**明确结论**，凡引用行号均已用 Read/Grep 核实。
> **边界**：本文件只读代码 + 写文档；**未修改任何 `src/`、`client/`、资产或测试**。

---

## 0. 结论摘要（TL;DR）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 图集文件形态 | **保留**「图像源 + 图集描述源」双件，但**关联显式化**（`SHEET_DATA[id]` 键控），不再依赖「同名即配对」。目录：世界 HD → `assets/art/hd/`；保留的 UI → `assets/art/ui/`；`assets/art/atlas/` 整体删除。 |
| D2 | `SHEET_DATA` schema | **保持不变**（`frames` / `animations` / `meta`），**新增可选** `meta.tilePx` / `meta.silhouettes`。命名契约 `<spriteId>.<action>.<facing>` + 帧名 `<anim>.<n>` **不变**。 |
| D3 | `AnimationState` | **不扩展**（仍是 6 个：idle/move/dash/attack/hit/death）。FR-001/FR-005 已由既有 6 动作满足。 |
| D4 | 图集切分 | **按「装载单元」切**：player 1 张、每个 enemy 类型 1 张（共 6）、tiles 1 张、fx 1 张 → 世界共 **9 张**；UI 1 张（保留）。`AssetCatalog` 按 `source` 去重逻辑**零改动**。 |
| D5 | 纹理过滤 | **全局默认保持 `'nearest'`**（M17 冻结测试 `camera_zoom_sharpness.test.ts` **零改动**）；HD 图集**按纹理**设 `scaleMode='linear'` + `autoGenerateMipmaps=true`。 |
| D6 | 墙体深度 | **自动选件（autotile）+ 立面仅在墙格内 / 仅向相邻墙格延伸**；**任何立面 MUST NOT 覆盖可通行格**（FR-010 构造性成立）。**不新增常驻节点**，深度落在既有 wall node 内部。 |
| D7 | 场景图 | **零新增节点**。`staticLayer.children.length === 1 + wallCount` 保持；F1–F6 逐条不变。 |
| D8 | 尺寸换算 | 精灵缩放**由纹理实际尺寸推导**（`texture.width`），`TILE_NATURAL_PX` 作为 HD 基准（提议 **64**）并**新增一致性断言**。 |
| D9 | 循环语义 | **新增**：`idle`/`move` 循环播放，`dash`/`attack`/`hit`/`death` 停在末帧（FR-006 要求）。 |
| D10 | 体积预算 | 单文件 **≤ 4 MiB**、总量 **≤ 32 MiB**、单图集 **≤ 4096²**、图集数 **≤ 12**（新增维度上限，抵补单文件放宽）。 |
| D11 | 性能口径 | 复用既有 `tests/performance/render_art_cost.test.ts` 的**交错比值**方法，**≤ 1.2**；不新增绝对墙钟阈值。 |
| D12 | 无损证明 | 基线摘要 **`f52dfdd4`**（seed `0x12345678`，601 tick）；两个 lossless 套件（`tests/harness/*`）**零改动**必须继续绿。 |

---

## 1. 技术上下文（供 plan.md 的 Technical Context 引用）

| 维度 | 取值 |
|---|---|
| 语言 / 版本 | TypeScript **5.7**（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）· Node **≥ 22** · ESM（`"type": "module"`） |
| 主要依赖 | 表现层：`pixi.js ^8.21.0` + `howler ^2.2.4`。**本特性 MUST NOT 新增任何运行时依赖**（FR-031；用户裁定逐帧位图序列）。逻辑内核 `src/`：**零运行时依赖**。 |
| 存储 | 本地文件资产；Vite 构建期静态导入（`?url` / JSON）。**无后端、无 CDN、无运行时 `fetch`**（FR-021 / SC-012）。 |
| 测试框架 | Vitest **2.1.8**，`pool: 'threads'`、`environment: 'node'`（无 jsdom）、`setupFiles: ./tests/harness/setup-config.ts`、`poolOptions.threads.maxThreads = ⌊核数/2⌋`。基线 **893 例全绿**；本特性后 **总数 ≥ 893**（FR-029）。 |
| 目标平台 | 桌面浏览器（WebGL · PixiJS v8）。视口可变，配合 M17（`specs/025`）相机缩放/自适应。 |
| 项目类型 | 单仓库前端游戏：**冻结 headless ECS 内核（`src/`）+ 独立表现层（`client/`）**，单向依赖 `client → src`。 |
| 性能目标 | ① 约 150 敌人同屏压测下，表现层**每帧耗时中位数**的「改动后/改动前」**比值 ≤ 1.2**（同机/同场景/同脚本/连续 3 次取中位数；禁绝对墙钟）。② HD 图集加载 **MUST NOT 阻塞游戏循环**（FR-022）。 |
| 约束 | `src/` 改动文件数 **= 0**（FR-011/SC-007）；17 段管道段数顺序不变（FR-014）；`GameRenderer` 导入图 **不含 `howler`**；唯一资产引用点（FR-019）；离线（FR-021）；6 条场景图冻结契约（FR-027）；根 `tsconfig` 不含 `client/`（`tsconfig.client.json` 覆盖）。 |
| 规模 / 范围 | 角色：`player.base` + 6 enemy id × 4 朝向 × 6 动作；场景：floor 多变体 + wall autotile 部件；特效：spark/dash-trail/hazard-ring + 掉落物图标。**不在范围**：`ui.*`、`sfx.*`（FR-030，条目与测试保留）。 |
| 五道闸门 | `npm test` · `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build`——全绿。 |

**建议分辨率基准（待美术总监确认，工程侧分辨率无关）**：`tilePx = 64`（HD 基准 `TILE_NATURAL_PX`）；角色单帧 `naturalPx = 64`（与基准一致，满足 `data-model.md` VR-9）。工程侧一律从**纹理实际尺寸**推导缩放，基准常量只作声明与断言。

---

## 2. 宪法逐条合规检查（Constitution Check）

| 原则 | 判定 | 论证（一句） |
|---|---|---|
| **I. 逻辑内核零浏览器依赖** | **PASS** | `src/` 改动文件数 = 0，全部资产与渲染逻辑落在 `client/`；不触碰 DOM / `Math.random` / 墙钟（ESLint AST 门禁范围不变）。 |
| **II. 确定性模拟** | **PASS** | 不改组件/系统/`World`/`snapshot()`；以固定 seed + 固定输入序列证明状态序列与摘要逐位不变（SC-006，基线 `f52dfdd4`）。 |
| **III. 17 段固定管道** | **PASS** | 无段增删/重排；不新增事件，`createDefaultSystems` 签名不变（FR-014）。 |
| **IV. 测试先行与证据化验证** | **PASS（须落实）** | 性能用**比值**口径（SC-010）；无损用**快照摘要逐位自证**（SC-006，非「既有测试全绿」推断）；测试改写**只换形态、不降强度**（§5 逐条给出更强替代）。 |
| **V. 表现层隔离** | **PASS（须落实）** | 全部改动在 `client/`；渲染器仍为 `World` **只读**消费者（`tests/assets/sprite-map.test.ts` 守护）；`GameRenderer` 导入图**不含 `howler`**（node 渲染套件守护）；`client/` 变更过 `typecheck:client`。 |
| **VI. 既有核心不可重构** | **PASS** | 不重构组件/系统/预制体/管道；敌人类型仍由**能力签名**只读推断，不向实体写类型标签（否则进 `listComponents()` → 改摘要）。 |
| **技术栈约束** | **PASS** | 无新增运行时依赖；根 `tsconfig` 不含 `client/`；ESLint `src/` 门禁不放宽。 |
| **闸门结论** | **PASS** | 无未论证违规。Phase 1 设计完成后复核一次（本文件即复核输入）。 |

**关键点——`GameRenderer` 导入图不含 `howler`**：`GameRenderer.ts:106-141` 只 import `pixi.js` 与 `src/`、`./VFXManager`、`./assets/*`；`howler` 仅由 `AudioManager.ts` 引入。本特性**不新增任何 import 边**（只改数据/尺寸/采样），因此该约束自动保持。

**关键点——`src/` 零改动**：本特性所有需求（敌人分类、动作状态、身体尺寸、tile 选择）都在 `client/` 侧以**只读投影**解决，机制与 M16 完全相同（`selectSprite` / `hurtboxSpriteScale` / `tileTexture`），不新增内核字段。

---

## 3. 资产结构契约（新）

### 3.1 文件形态与目录（决策 D1）

```
assets/art/
├── hd/                         # 新增：世界 HD 图集（本特性唯一世界美术来源）
│   ├── player-hd.{png,json}
│   ├── enemy-grunt-hd.{png,json}   … enemy-unknown-hd.{png,json}   （共 6 类）
│   ├── tiles-hd.{png,json}
│   └── fx-hd.{png,json}
├── ui/                         # 保留：UI（不在范围，FR-030）
│   ├── ui.{png,json}           #   图标图集（从旧 atlas/ 迁入）
│   └── panel-*.png / frame-*.png / button-*.png / overlay-*.png / bar.png
├── LICENSES.md                 # 许可登记（逐 id 可追溯）
├── atlas/                      # ✖ 删除（旧像素图集）
├── raw/                        # ✖ 删除（像素源素材包）
├── raw-hd/                     # 新增：HD 上游源包（若以原始包留档）
└── tools/build-atlas.py        # ✖ 删除（像素派生生成器）
```

**为什么保留「PNG + JSON」双件**：① `AssetCatalog.resolveSource` 用 `new Spritesheet(texture, data)`，PixiJS 需要「纹理 + 图集描述」两件；② 唯一引用点契约（删文件即构建失败）要求二者都是**静态导入**；③ 但**关联由 `SHEET_DATA[id]` 显式承载**（`manifest.ts:188`），不再依赖文件名同名——满足 `contracts/hd-asset-manifest.md §7.1`。

**为什么 `atlas/` 整体删除**：旧像素图集（player/enemies/tiles/fx）被 HD 取代；UI 图集迁到 `ui/` 与既有 UI 贴图同处；`atlas/` 目录随之消失，`quickstart §4` 的残留检查自然通过。

### 3.2 `SHEET_DATA` schema（决策 D2）

```ts
export interface SpriteSheetData {
  readonly frames: Readonly<Record<string, SheetFrameData>>;   // key = "<anim>.<n>"
  readonly animations?: Readonly<Record<string, string[]>>;    // key = "<spriteId>.<action>.<facing>"
  readonly meta: {
    readonly app?: string;
    readonly format?: string;
    readonly image?: string;
    readonly scale: number | string;
    readonly size?: { readonly w: number; readonly h: number };
    readonly tilePx?: number;                                   // 新增（可选）：HD 基准 tile 尺寸
    readonly silhouettes?: Readonly<Record<string, { grid: string; rows: number[] }>>; // 既有，UI 用
  };
}
```

- **`frames` / `animations` / `meta` 语义不变** → `AssetCatalog`（`AssetCatalog.ts:236-246` 的 `adopt`）与 `Spritesheet.parse()` **零改动**。
- **新增 `meta.tilePx`（可选）**：声明该图集的 HD 基准 tile 尺寸；测试断言它与 `TILE_NATURAL_PX` 一致（新一致性契约）。
- `meta.scale` 必须存在（结构可赋值性，`manifest.ts:100-106`）。
- `meta.size` 必须等于 PNG 实际尺寸（新增断言）。

### 3.3 命名契约与回退链（决策 D3）

**沿用不变**：
- 动画键 `<spriteId>.<action>.<facing>`；帧名 `<anim>.<n>`。
- 回退链（`sprite-map.ts:236-245`）：`exact → <action>.down → idle.down`，去重。
- `AnimationState` 6 值、`Facing4` 4 值、`EnemyType` 6 值——**全部不变**。

**`AnimationState` 不扩展的理由**：FR-001 要求的动作（待机/移动/攻击/受击）+ 保留（冲刺/死亡）恰为既有 6 个。新增动作（如「蓄力」）会要求 `src/` 的 `ActionState` 同步扩展 → 违反 FR-003/FR-011，**本特性不允许**。

**`sprite-map.ts` 的改动面**：**零改动**（键构造、回退链、量化、分类表全部保留）。HD 图集只需按同名键提供动画即可被既有代码消费。

### 3.4 图集切分与去重（决策 D4）

| 图集 | 承载 id | 理由 |
|---|---|---|
| `player-hd` | `player.base` | 6×4×N 帧，单张足够 |
| `enemy-<type>-hd` × 6 | `enemy.{grunt,elite,raider,bomber,gunner,unknown}` | **每类一张**：独立可替换/可流式；避免单张 mega-atlas 撞 4096 上限 |
| `tiles-hd` | `tile.floor`（多变体）、`tile.wall`（autotile 部件集） | 场景贴图 |
| `fx-hd` | `fx.spark`、`fx.dash-trail`、`fx.hazard-ring` | 特效 |
| `ui`（保留） | `ui.icon.*` + image 条目 | 不在范围 |

**`AssetCatalog` 去重如何适配**：`load()` 已按 `entry.source` 缓存 `inFlight` Promise（`AssetCatalog.ts:139-160`）。新切分下**绝大多数 source 只对应 1 个 id**（去重退化为恒等）；`tiles-hd`/`fx-hd` 仍有多个 id 共享一个 source（去重继续生效）。**结论：去重逻辑零改动。**

> 若某类敌人图集超出 4096²，**应急切分**：按动作拆成 `enemy-<type>-<action>-hd`（`idle/move` 一组、`attack/hit/death/dash` 一组），并在 `manifest.ts` 中把该 id 的 `SHEET_DATA` 指向合并后的动画表。此路径保留但默认不启用。

### 3.5 纹理过滤（决策 D5）—— 与 M17 冻结测试的处置

| 对象 | `scaleMode` | 依据 |
|---|---|---|
| 全局默认 `TextureSource.defaultOptions.scaleMode` | **`'nearest'`（保持不动）** | M17 冻结测试 `tests/render/camera_zoom_sharpness.test.ts:34` 以**字面量** `'nearest'` 钉死，且**不在授权的 `tests/render/*_art` 集合内**。保持默认 ⇒ 该测试**零改动**继续绿。 |
| 世界 HD 图集纹理（`kind==='spritesheet'`） | **`'linear'` + `autoGenerateMipmaps=true`** | HD 美术在放大/缩小时需平滑插值才「清晰」（FR-025）；mipmap 解决 tile 缩小采样。 |

**落地方式**：在 `AssetCatalog.resolveSource`（`AssetCatalog.ts:217-233`）中，`loadTexture` 之后、`new Spritesheet(...)` **之前**，对 `kind==='spritesheet'` 的 `texture.source` 设置：

```ts
texture.source.scaleMode = 'linear';
texture.source.autoGenerateMipmaps = true;
texture.source.update();
```

**为什么按纹理而非全局**：全局默认由 M17 冻结测试守护；且保留的 UI 图集（`ui.png`，像素风）**仍需要 `'nearest'`**——所以「全局 nearest + 世界 HD 按纹理 linear」不仅满足 FR-025，还让 M17 测试**继续有意义**（它守护的是保留像素 UI 的采样）。

**连锁影响评估**：无其它消费者依赖全局 nearest；世界美术全部换 HD；`GameRenderer`/`VFXManager` 不读取 `scaleMode`。**净影响面 = 0 处额外改动。**

---

## 4. 渲染层改动清单

### 4.1 逐文件清单

| 文件 | 改动性质 | 为什么必须在 `client/` 解决 |
|---|---|---|
| `client/assets/manifest.ts` | 换 HD 导入（`hd/*.png?url` + `hd/*.json`；UI 迁 `ui/`）；`MANIFEST`/`SHEET_DATA` 键与 source 重指向 | 唯一资产引用点；`src/` 不引用资产 |
| `client/assets/AssetCatalog.ts` | `resolveSource` 增 3 行（HD 纹理设 `linear`+mipmap）；其余零改 | 加载/采样是表现层职责 |
| `client/assets/sprite-map.ts` | **零改动**（命名/回退/量化/分类表保留） | 纯映射，键不变 |
| `client/GameRenderer.ts` | ① 尺寸由纹理实际尺寸推导（去 `TILE_NATURAL_PX` 硬算）② `ANIM_FRAME_MS` 重调 ③ `advanceAnimation` 增循环语义 ④ `buildWallNode`/`syncFloor` 增 autotile + 多变体 | 像素↔世界换算、tile 铺设、动画时钟都是渲染器职责 |
| `client/VFXManager.ts` | 特效纹理尺寸改为分辨率自适应（`SPARK_ART_PX` 等不再写死） | 粒子是表现层 |
| `client/main.ts` | **零改动**（启动序列不变：`await catalog.load()` → `start()`） | — |
| `assets/art/**` | 删旧像素图集/生成器/源包；加 HD 图集/贴图 | 资产层 |

**为什么不能改 `src/`**：所有「看起来要改内核」的需求——敌人类型、动作、身体尺寸、tile 选择——都由既有**只读投影**满足（能力签名表 / `ActionState`+`DeadTag` / hurtbox 半径 / 房间网格）。任何 `src/` 改动都会改变 `listComponents()` → 改快照摘要 → 破坏 `f52dfdd4` 与冻结内核（FR-011/FR-012/Principle VI）。

### 4.2 `GameRenderer.ts` 接入点（函数名 + 行号，已核实）

| 关注点 | 函数（行号） | 改动 |
|---|---|---|
| 玩家精灵 | `createPlayerView` **L2149**、`buildAnimatedBody` **L2262** | 尺寸由 `frames[0].width` 推导（替换 `TILE_NATURAL_PX`） |
| 敌人精灵 | `createEnemyView` **L2208**、`buildAnimatedBody` **L2262** | 同上；`selectSprite`（sprite-map L210）不变 |
| 动画选择 | `selectAnimation` **L1385** | 键/回退链不变；`animLoop` 由 `action` 决定 |
| 动画推进 | `advanceAnimation` **L1433** | **新增循环语义**（D9） |
| 动画时钟 | `ANIM_FRAME_MS` **L428** | 重调 HD 值（§4.5） |
| tilemap 铺设 | `syncStaticGeometry` **L1046**、`buildWallNode` **L1099**、`ensureStaticLayer` **L1133**、`syncFloor` **L1167**、`tileTexture` **L1224** | 增 autotile 掩码 + floor 多变体（确定性） |
| 特效层 | `fxLayer` **L595**、`syncEffects` **L1522**、`createHazardView` **L1944**、`VFXManager.spawnSpark` **L209** | 纹理尺寸自适应；粒子仍 `Graphics` |
| 相机/缩放 | `syncZoom` **L1722**、`cameraTarget` **L1751** | **零改动**（不涉及） |
| 场景图 | `init` **L841**、`createMissingViews` **L1256** | **零改动**（不新增节点） |

### 4.3 墙体深度 / 透视如何在 Pixi 落地（决策 D6/D7）

**模型**：**自动选件（autotile）+ 格内 3/4 视角构成**。

1. **构建只读格集**：`syncStaticGeometry` 已在遍历 `WallComponent`（L1063-1076）。在同一遍里构建 `Set<"cx,cy">`（`cx = Math.round(wall.x + col)`），供掩码查询。
2. **每格选件**：对每个墙格算 4 邻接掩码 `N/E/S/W`（按格集查询），从 `tiles-hd` 的 wall 部件表取对应部件（顶面 / 立面 / 转角 / T 形 / 端点 / 内侧角）。掩码→部件的映射**必须完备**（`data-model.md` VR-13），缺项有显式兜底部件。
3. **深度表达**：部件图**在一格内**同时画出顶面（上）+ 立面（下），并带 1–2px 环境遮蔽阴影。立面**仅在墙格内**；**仅当相邻格也是墙**时，立面可向该相邻墙格延伸（延伸量 `depthExtentPx`）。**当相邻格可通行时，立面 MUST 收在墙格内，绝不越界。**
4. **节点结构**：**仍是每格一个 sprite**，挂进既有 wall node（`buildWallNode` L1099，`wall.x/y` 定位不变）。`staticLayer.children.length === 1 + wallCount` **不变**。

**为什么这样不破坏 6 条冻结契约**：
- **零新增节点**（F1–F6 全部构造性保持）：深度只改 wall node **内部**内容与 sprite 尺寸，不改节点数/顺序。
- **F5**（无墙时 `camera.children` 恰 1）：`staticLayer` 仍是惰性挂载（`ensureStaticLayer` L1133 / `teardownStaticLayer` L1241），无墙即不存在。
- **F4**（`root.children[0]` 为首个实体视图）：实体视图仍插在 `root` 中 `fxLayer` 之下（`createMissingViews` L1269），未动。

**FR-010 / SC-004 的构造性保证**：
- **FR-010（立面不遮挡可通行地面）**：由「立面仅向相邻**墙格**延伸」直接保证——立面永远不会进入可通行格，可通行地面永不被覆盖。
- **SC-004（视觉墙边界 == 碰撞边界）**：墙格的可通行边界（朝可通行邻格的一侧）由**格内**立面 + 阴影表达，与碰撞几何逐像素对齐。
- **被否决的替代**：统一向上悬挑（uniform overhang）——会把立面画进相邻可通行格，或（若改为把地板画在立面之上）覆盖顶面，二者必违 FR-010 或 FR-009，故否决。

**为什么不用 `zIndex` / `sortableChildren`**：`staticLayer` 的固定序（floor=child 0，walls=children 1..n）+ 实体在 `root`（相机最后子节点，渲染在 `staticLayer` 之上）已给出正确的俯视层序；引入 `sortableChildren` 会带来每帧排序成本，且有重排 `root` 子节点、撞坏 F4（升序 id）之虞。**决策：不使用。**

### 4.4 floor 多变体的确定性选择（FR-009）

- `tiles-hd` 的 floor 动画声明多个变体（如 `tile.floor.0..k`）。
- 每格变体索引 = 格坐标的**确定性哈希**：`idx = ((cx * 73856093) ^ (cy * 19349663)) >>> 0 % k`。**不消费 `World.rng`、不读墙钟**（渲染层禁随机）。
- 结果：同一格在每一帧得到同一变体（无抖动），且大面积地板不重复单调。

### 4.5 动画时钟与循环（决策 D9）

- `ANIM_FRAME_MS`（L428）重调为 HD 值（提议，美术总监可微调）：`idle 200 / move 90 / dash 60 / attack 80 / hit 90 / death 100`。
- **循环语义**（新增）：`advanceAnimation`（L1433）改为——
  - 循环动作（`idle`/`move`）：`index = floor(elapsed / frameMs) % total`；
  - 一次性动作（`dash`/`attack`/`hit`/`death`）：`index = min(total-1, floor(elapsed / frameMs))`（保持现状「停在末帧」）。
  - `animLoop` 在 `selectAnimation`（L1385）赋 clip 时按 `action` 缓存。
- **依据**：FR-006 明确「待机与移动为循环动作，攻击与受击有明确的起止」。

---

## 5. 测试改写方案（逐文件）

> 原则：**只换形态，不降强度**。结构性断言（图集形态/体积/白名单）随 HD 更新；**契约性断言**（只读、确定性、降级、6 条冻结契约、无专有资产）**一律保持原强度**。

### 5.1 `tests/assets/manifest.test.ts`

| 断言 | 处置 | 改后强度说明 |
|---|---|---|
| 冻结/唯一 id/前缀白名单/`source` 非空 | **保持不动** | — |
| audio→`silent`、visual→`graphics`、kind 三值 | **保持不动** | — |
| `LICENSE_WHITELIST = ['CC0-1.0','public-domain']` | **扩白名单**为 `['CC0-1.0','public-domain','CC-BY-4.0','CC-BY-SA-4.0']`（`contracts §5` 授权） | 白名单仍是**显式字面量**，非空真 |
| `expect(entry.license).toBe('CC0-1.0')`（L105-109） | **替换**为：① license ∈ 白名单；② **新增**逐 id 交叉核对——manifest 的 `license` 必须与 `LICENSES.md` 中该 id 行的许可列**一致**；③ 白名单本身不含专有层级 | **净增强**：旧断言只查单一常量；新断言增加「登记表与清单一致」这条独立证据 |
| 每 id 出现在 `LICENSES.md`（`` `id` ``） | **保持不动** | — |
| 无 `/Supergiant/i` | **保持不动**（`contracts §5.3` 允许 SHOULD 扩展） | — |
| `player.base` 全 24 项交叉（L156-165） | **保持不动**（HD 必须提供全 24 键） | — |
| `enemy.<type>.idle.down` 存在（L167-173） | **保持不动** | — |
| 每图集 ≥1 动画、帧名存在 | **保持不动**，并**增强**为「每条动画的每个帧名都在 `frames` 中」 | — |
| 全量覆盖清单（L176-215） | **保持不动** | — |

### 5.2 `tests/assets/licenses.test.ts`

| 断言 | 处置 | 改后强度说明 |
|---|---|---|
| `ATLAS_DIR = assets/art/atlas`（L30） | **改为多目录**：`ATLAS_DIRS = ['assets/art/hd','assets/art/ui']`，按 basename 定位 | 形态重定义 |
| 「每个 spritesheet source 有 PNG **且同名 JSON**」（L51-66） | **改为**：① basename 在 `ATLAS_DIRS` 之一存在且非空；② `SHEET_DATA[id]` 已定义（描述存在）；③ 每条 `frames` 矩形落在该 PNG 尺寸内（L68-83 **保持**） | **净增强**：旧断言只查「同名 JSON 文件存在」；新断言查「解析后的描述存在**且**其帧矩形真的落在图内」——验证内容而非文件存在性 |
| 体积：`largest < 1MB`、`total < 6MB`（L85-100） | **数值重定**：`largest ≤ 4 MiB`、`total ≤ 32 MiB`，**并新增**：① 每张 PNG 尺寸 `w,h ≤ 4096`（`data-model.md` VR-25）；② spritesheet source 数 `≤ 12`（VR-24 的等价强度约束） | **净增强**：单文件放宽，但新增**两个**独立上限（尺寸、数量），覆盖旧断言缺失的失效模式（WebGL 上限、atlas 爆炸） |
| `RAW_DIRS` 含 `assets/art/raw`（L31-34） | **改为** `['assets/art/raw-hd','assets/audio/raw']` | 像素源包前提消失 |
| 每包 `License.txt` 含 `cc0`（L104-120） | **保持**（对 `raw-hd` 生效） | — |
| `packs.length >= 5` 反空真（L119） | **替换**为：① 每个 `RAW_DIRS` 中**实际存在的**包目录都受审（无静默跳过）；② `assets/art/raw-hd` 至少贡献 1 个包；若 HD 全部为原创/程序化，则该包为 `original/`，其 `License.txt` 声明 CC0 + 「本仓库原创」 | 强度等价（仍是「审计确有对象」的硬断言），且**不依赖旧的魔数 5** |
| 包名出现在 LICENSES.md（L136-151） | **保持** | — |

### 5.3 `tests/assets/sprite-map.test.ts`

**处置：零改动。** 理由：全部断言都是**分辨率无关的纯函数契约**——`facingFromRadians` 量化/接缝/总函数、`animationFromState` 枚举全覆盖、`enemyTypeFromSignature` 签名表、`animationCandidates` 回退链、`selectSprite` 只读/不消费随机、`pickupIconId`、`hurtboxSpriteScale` 公式（`hurtboxSpriteScale(0.5,16,10)` 等字面量是**显式传参**，与资产分辨率无关）。本特性不改 `sprite-map.ts`，故该套件**逐字保持**。

### 5.4 `tests/assets/degradation.test.ts`

**处置：几乎零改动。** 全部断言（零外部请求、逐条目隔离、终态不重试、`url` 可用、全降级仍可玩、audio 静默）与资产**内容**无关，只与**加载契约**有关。`ui.panel.hud` 仍是 `image` 条目且独占其 source，故「只坏一个」的断言（L92-111）继续成立。**保持不动。**

### 5.5 `tests/render/player_art.test.ts`（`*_art`，允许更新）

| 断言 | 处置 |
|---|---|
| 机身是 `AnimatedSprite`、`totalFrames > 0` | **保持不动** |
| `anchor == (0.5,0.5)` | **保持不动** |
| `scale.x ≈ 0.625`（L89，写死 16px） | **改为分辨率无关**：`expect(body.scale.x * body.texture.width).toBeCloseTo(radius*2*PX_PER_UNIT, 9)`——断言**绘制尺寸 == hurtbox 直径**（FR-008 的真契约），比写死常数**更强** |
| 动作映射字面量 `player.base.<action>.right.0`（L97-120） | **保持不动** |
| 朝向字面量 / 接缝稳定（L139-187） | **保持不动** |
| 反向旋转 `body.rotation == -facing`（L189-207） | **保持不动** |
| 帧时钟「130ms × 9 帧 → frame 1」（L210-233） | **更新算术**为 HD `ANIM_FRAME_MS.move` 与新帧数；**保持**「由真实 `deltaMS` 驱动、`sim.tick` 不变」的语义断言 |
| 「停在末帧不循环」（L235-255） | **改为两条**：① `attack/hit/death` 停在末帧（保持）；② **新增** `idle/move` **循环**（FR-006） |
| 降级回 `Graphics`（L258-294） | **保持不动** |

### 5.6 `tests/render/enemy_art.test.ts`（`*_art`）

| 断言 | 处置 |
|---|---|
| 5 类各自 sprite id（L60-125） | **保持不动**（HD 每类独立图集，`displayedFrame` 仍返回 `enemy.<type>.idle.right.0`） |
| 朝向 / 死亡 / 不可见-永不（L128-270） | **保持不动** |
| `scale ≈ (radius*2*10)/16`（L185-186） | **改为分辨率无关**：断言 `scale.x * texture.width == radius*2*PX_PER_UNIT`（同 §5.5，FR-008 真契约，**更强**） |
| hurtbox 轮廓在 art 路径保留（L289-303） | **保持不动** |
| 降级回方形（L272-287） | **保持不动** |

### 5.7 `tests/render/tilemap_art.test.ts`（`*_art`）

| 断言 | 处置 |
|---|---|
| `staticLayer` 在 camera 索引 0、含 tile sprite（L52-77） | **保持不动** |
| wall node 定位 `wall.x*PX_PER_UNIT`（L79-99） | **保持不动** |
| 平铺不拉伸：`node.children.length == cols*rows`（L101-126） | **保持不动**（每格仍 1 个 sprite；autotile 选件不改变每格 sprite 数） |
| floor 每格 1 tile（100/120，L128-141） | **保持不动** |
| **F1–F6**（L144-205） | **保持不动（MUST NOT 放宽）** |
| 房间切换重建一次 / 无残留（L207-268） | **保持不动** |
| 缺图集降级回 `Graphics`（L270-287） | **保持不动** |

> **HD 新增**：见 §5.9 的 `hd_tilemap_depth.test.ts`（autotile 完备性、floor 变体确定性、FR-010 不遮挡）。

### 5.8 `tests/render/fx_art.test.ts`（`*_art`）

| 断言 | 处置 |
|---|---|
| 火花来自 fx 图集（`askedTextures` 含 `fx.spark`/`fx.dash-trail`） | **保持不动** |
| **火花仍是 `Graphics`**（L124-145，冻结粒子契约） | **保持不动（MUST NOT 放宽）** |
| 危险预警由**组件引信**驱动（L164-232） | **保持不动** |
| 掉落物 3 类图标不同 + 灰度可区分（L235-302） | **保持不动**（`ui.*` 保留像素，`meta.silhouettes` 不变） |
| 降级回圆盘（L304-315） | **保持不动** |

> **HD 特效的落点**：火花粒子**保持 `Graphics`**（纹理填充，M16 既有机制，`VFXManager.ts:209-245`）；HD 质感落在**拖尾/危险预警**的纹理与粒子绘制参数上。这既满足「局内特效高清化」，又不撕毁冻结粒子契约。

### 5.9 新增测试清单（确保总数 ≥ 893）

| 新文件 | 用例数（估） | 守护的 FR/SC |
|---|---|---|
| `tests/assets/hd_structure.test.ts` | 9 | FR-019/FR-024、`data-model` E1/E2/E3、VR-1/2/5/6/9/13、VR-23/25 |
| `tests/assets/hd_distinctness.test.ts` | 4 | FR-004/FR-005、SC-002/SC-003（6 类敌人 `idle.down` 帧标签与纹理两两不同；player 不同） |
| `tests/assets/hd_budget.test.ts` | 4 | FR-024、SC-014、VR-24/25（单文件/总量/尺寸/数量四上限） |
| `tests/assets/hd_license_crosscheck.test.ts` | 3 | FR-023、SC-013、VR-20/21（manifest↔LICENSES.md 逐 id 一致；白名单显式；无专有发行商名） |
| `tests/render/hd_sampling.test.ts` | 3 | FR-025、`contracts §8`（HD 纹理 `linear`+mipmap；全局默认仍 `nearest`） |
| `tests/render/hd_tilemap_depth.test.ts` | 6 | FR-007/FR-009/FR-010、SC-004/SC-005（autotile 完备、变体确定、立面不越可通行格、F1–F6） |
| `tests/render/hd_body_size.test.ts` | 3 | FR-008、SC-004（绘制尺寸 == hurtbox 直径，player + elite + 边界退化） |
| **合计（新增）** | **≈ 32** | 总量 893 + 32 −（少量改写）**≥ 893** |

> **契约性断言不动清单**（评审红线）：① 渲染器只读（`sprite-map.test.ts`）；② 降级回 `Graphics`（4 个 `*_art` + `degradation.test.ts`）；③ 6 条场景图冻结契约（`tilemap_art.test.ts` + `camera_zoom_scene_graph.test.ts`）；④ 不得出现 Supergiant/专有资产；⑤ 火花粒子为 `Graphics`（`fx_art.test.ts`）；⑥ 两个 lossless 套件（`tests/harness/*`，**非授权集合，必须零改动绿**）。

---

## 6. 体积预算与性能验证方案

### 6.1 体积预算（决策 D10，与 `contracts §6` / `data-model` E7 对齐）

| 项 | 旧值 | 新值 | 理由 |
|---|---|---|---|
| 单文件（PNG） | < 1 MiB | **≤ 4 MiB** | 单张 2048² HD 图集压缩后约 1–3 MiB |
| 资产总量（世界 HD PNG） | < 6 MiB | **≤ 32 MiB** | 7 角色 + tiles + fx；`ui`/音频不计 |
| 单图集像素尺寸 | （无） | **≤ 4096×4096**（新增） | WebGL `MAX_TEXTURE_SIZE` 保证下限；超限必须切分 |
| 图集数量 | （无） | **≤ 12**（新增） | `VR-24` 等价强度约束，抵补单文件放宽 |
| 解码显存（估算） | — | **≤ 256 MiB** | 8 张世界图集 × 典型 2048²×4B ≈ 128 MiB，留余量 |

**判定口径**：以**构建产物实测**为准（`dist/` 内文件字节数 + PNG 头尺寸）。

### 6.2 约 150 敌人同屏压测的比值口径（SC-010 / FR-026）

- **复用** `tests/performance/render_art_cost.test.ts` 的**交错比值**方法：同一进程内交替计时「几何基线」与「HD 路径」，`ROUNDS=12`×`FRAMES_PER_ROUND=40`，取**聚合每帧比值**。
- **判定**：`ratio = artTotalMs / baselineTotalMs ≤ 1.2`（同机/同场景/同脚本）。
- **为何比值能守住**：HD 化**不增加每帧 CPU 工作量**——每格仍 1 个 sprite（tile 数不变）、每实体仍 1 个 `AnimatedSprite`、动画重选仍是「三输入变更才重选」（`syncTransforms` L1329-1352），tile 重建仍由签名守卫（`floorSignature` L1175）挡住。HD 只增大**纹理字节**（GPU 侧），不进入 CPU 每帧路径。
- **额外验证**：`tests/performance/stress.test.ts`（M15，绝对墙钟）**零改动**须继续绿——需注意其受 CPU 争用影响，`vitest.config.ts` 已将 worker 池压到核数一半（`maxThreads=⌊核数/2⌋`）以留出余量。

### 6.3 HD 纹理的显存 / 加载时间风险与验证

| 风险 | 验证手段 | 判据 |
|---|---|---|
| 显存超限 | `hd_budget.test.ts` 断言单图集 ≤4096²、图集数 ≤12；估算解码字节 | ≤ 256 MiB |
| 加载时间 | `AssetCatalog.load()` 为 `async`、逐条目隔离、`main.ts:242` 在**循环启动前** `await` | 首帧可交互 |
| **加载不阻塞游戏循环** | 结构性证明：`load()` 只在 `main.ts` 启动序列中被 `await` 一次（`main.ts:242-246`），`start()` 之后才建 ticker；**游戏循环期间零 IO**。测试侧：`degradation.test.ts` 断言 `load()` 从不抛错；`render_art_cost.test.ts` 证明 `syncWorld` 为同步、不 await | 循环期无阻塞 |
| 解码抖动 | 使用 PixiJS `Assets.load`（`ImageBitmap` 解码，浏览器侧尽量 off-main-thread） | — |

### 6.4 `src/` 零改动的无损证明（SC-006/SC-007）

- **方法**：固定 seed `0x12345678`、601 tick 固定脚本（`tests/harness/render_art_lossless.test.ts:52-79` 的 FNV-1a 摘要：`listEntities() × listComponents()` 拼串过 FNV-1a）。
- **既有基线摘要值**：**`f52dfdd4`**（`tests/harness/camera_zoom_lossless.test.ts:60` 以字面量钉死；M15/M16/M17 同值）。
- **本特性的证明链**：
  1. `git diff --stat src/` **空输出** → 改动文件数 = 0（SC-007）；
  2. `tests/harness/render_art_lossless.test.ts` 与 `tests/harness/camera_zoom_lossless.test.ts` **零改动**继续绿 → 摘要仍为 `f52dfdd4`（SC-006）；
  3. 两套件均**不在**授权改写集合（`tests/assets/*`、`tests/render/*_art`）内 → 其「未修改」本身即证据。
- **纪律**：**既有测试全绿 ≠ 无损**；必须以摘要逐位自证。

---

## 7. 分阶段实施计划（Epic → Story 骨架）

> **并行策略**：Story A3 先落地一个**程序化占位 HD 图集**（纯色高分辨率、键与帧名正确、schema 一致），即可让 Epic B/C 与「真实 HD 素材制作」**并行推进**。占位图集满足全部结构契约，真实素材到位后仅需替换 `assets/art/hd/*.png`，**代码零改动**。

### Epic A — HD 资产契约与装载（打底）

| Story | 目标 | 涉及文件 | 验收 | 依赖 | 可占位？ |
|---|---|---|---|---|---|
| **A1** | 新目录与 schema 落地：`hd/`、`ui/` 迁移；`manifest.ts` 重指向；`SHEET_DATA` 键 | `assets/art/hd/**`、`assets/art/ui/**`、`client/assets/manifest.ts` | FR-019、`contracts §1/§7` | — | ✅ 占位 |
| **A2** | 纹理采样：HD 图集按纹理设 `linear`+mipmap；全局默认保持 `nearest` | `client/assets/AssetCatalog.ts` | FR-025、`contracts §8`、M17 测试零改动 | A1 | ✅ 占位 |
| **A3** | 占位 HD 生成器：程序化纯色 HD 图集（正确键/帧/schema/`meta.tilePx`） | `assets/art/tools/build-hd-atlas.py`（新）、`assets/art/hd/**` | 结构测试全绿 | — | ✅（本身即占位） |
| **A4** | 真实 HD 素材接入与 `LICENSES.md` 登记 | `assets/art/hd/**`、`assets/art/raw-hd/**`、`assets/art/LICENSES.md` | FR-023、SC-013 | A1、美术总监交付 | ❌ 需真实素材 |

### Epic B — 渲染层接入

| Story | 目标 | 涉及文件 | 验收 | 依赖 | 可占位？ |
|---|---|---|---|---|---|
| **B1** | 尺寸由纹理实际尺寸推导（去写死 16） | `client/GameRenderer.ts`（L2262/L1099/L1167）、`client/VFXManager.ts` | FR-008、SC-004 | A1 | ✅ |
| **B2** | HD tilemap：autotile 掩码 + floor 多变体 + 立面不越可通行格 | `client/GameRenderer.ts`（L1046/L1099/L1167/L1224） | FR-007/FR-009/FR-010、SC-004/SC-005 | B1 | ✅ |
| **B3** | 动画：`ANIM_FRAME_MS` 重调 + `idle/move` 循环 | `client/GameRenderer.ts`（L428/L1433/L1385） | FR-006 | B1 | ✅ |

### Epic C — 测试改写与新增

| Story | 目标 | 涉及文件 | 验收 | 依赖 |
|---|---|---|---|---|
| **C1** | `tests/assets/*` 改写（manifest/licenses；sprite-map/degradation 保持） | `tests/assets/*` | FR-029、SC-011 | A1/A2 |
| **C2** | `tests/render/*_art` 改写（尺寸分辨率无关、循环语义） | `tests/render/{player,enemy,tilemap,fx}_art` | FR-029 | B1/B2/B3 |
| **C3** | 新增测试 7 个（§5.9，≈32 例） | `tests/assets/hd_*`、`tests/render/hd_*` | 总数 ≥ 893 | B1/B2/B3 |

### Epic D — 移除与合规

| Story | 目标 | 涉及文件 | 验收 | 依赖 |
|---|---|---|---|---|
| **D1** | 删像素世界图集 + `build-atlas.py` + 像素源包 | `assets/art/atlas/**`、`assets/art/tools/build-atlas.py`、`assets/art/raw/**` | FR-016/017/018、SC-008 | A1、A4 |
| **D2** | 许可登记与白名单终稿 | `assets/art/LICENSES.md`、`tests/assets/*` | FR-023、SC-013 | A4 |

### Epic E — 证据与性能

| Story | 目标 | 涉及文件 | 验收 | 依赖 |
|---|---|---|---|---|
| **E1** | 比值测量 + 无损摘要 + 验证报告 | `tests/performance/render_art_cost.test.ts`（复核）、`production/*` | SC-006/SC-010、`quickstart V2/V7` | B/C/D |
| **E2** | 变异实验证据（每处门控改动） | `production/*` | Principle IV、`quickstart §11` | C |

**依赖顺序**：`A3 → A1 → A2 → {B1 → B2 → B3} → {C1, C2, C3} → D1 → D2 → E1 → E2`；`A4` 与 `B*/C*` **并行**。

---

## 8. 风险与开放问题

### 8.1 技术风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 单张 HD 图集超 WebGL `MAX_TEXTURE_SIZE` | 纹理创建失败 / 黑块 | 设计上限 4096²；超限按动作切分（§3.4 应急路径）；测试断言尺寸上限 |
| R2 | 显存 / 加载时间超预算 | 低端机卡顿 | 图集数 ≤12、总量 ≤32 MiB；`Assets.load` 异步解码；启动期一次性加载，循环期零 IO |
| R3 | `nearest→linear` 连锁影响 | 误伤 M17 冻结测试 | **决策 D5**：全局默认保持 `nearest`，仅 HD 图集按纹理 `linear` ⇒ M17 测试零改动且仍有意义 |
| R4 | 立面悬挑撞坏 FR-010 / SC-004 | 可通行地面被遮挡 / 视觉碰撞不一致 | **决策 D6**：立面仅在墙格内、仅向相邻墙格延伸 ⇒ 构造性不越界 |
| R5 | 场景图 6 条冻结契约被撞坏 | 大量冻结套件红 | **决策 D7**：零新增节点；深度落在既有 wall node 内部；`staticLayer` 惰性挂载不变 |
| R6 | 测试改写导致强度下降 | 假绿 | §5 逐条给「更强替代」；红线清单（§5.9 尾）逐条保持；新增 4 个维度/数量上限断言 |
| R7 | HD 素材可得性（CC0 四向逐帧稀缺） | 交付延期 | 占位 HD 图集打通管线（A3）；缺口以本仓库原创/程序化补齐；风格由美术总监统一 |
| R8 | 图集 JSON 帧矩形越界 / 缺帧 | 运行期撕裂/空白精灵 | `hd_structure.test.ts` 逐帧断言 `x+w`/`y+h` 落在 PNG 内（保留旧强度）+ 每条动画帧名存在 |
| R9 | 性能比值在 CI 争用下抖动 | 误报 | 复用交错比值 + worker 池半核；不引入绝对墙钟阈值 |
| R10 | 敌人图集切分后 `SHEET_DATA` 键错配 | 某类敌人退化/不可见 | `hd_distinctness.test.ts` 断言 6 类帧标签/纹理两两不同；`unknown` 兜底必有 `idle.down` |
| R11 | `advanceAnimation` 循环改动引入闪烁 | 动作读感退化 | 循环仅作用于 `idle/move`；一次性动作仍停末帧（FR-006 的「明确起止」）；新增测试分别守护 |

### 8.2 需要主理人 / 用户拍板的开放问题

| # | 问题 | 我的建议 | 影响面 |
|---|---|---|---|
| Q1 | **`ui.icon.*`（掉落物图标）是否纳入 HD 范围？** spec `Key Entities` 把「掉落物」列为在范围内，但主理人边界说「`ui.*` 保持现状」。二者张力。 | **保持现状**（不 HD 化 `ui.*`），并在规格中显式登记该边界解读；若用户要求掉落物高清，则把 `ui.icon.*` 的 source 指向 HD 图集（1 行改动 + `fx_art` 剪影断言随改）。 | `ui.*` 条目、`fx_art.test.ts` 剪影用例、SC-008 口径 |
| Q2 | **SC-008「像素资产残留=0」的范围**：保留的 `ui.png` 与 `assets/art/ui/*.png`（UI 贴图，FR-030 要求保留）仍是像素资产。 | **SC-008 解释为「在范围内的世界美术」**；保留 UI 显式登记为「FR-030 授权保留」。 | 验收口径、`quickstart §4` |
| Q3 | **HD 素材来源**（开放许可高清包 vs 本仓库原创/程序化） | 优先开放许可高清包（CC0/CC-BY）+ 原创补齐；决定 `raw-hd/` 与许可白名单最终形态 | `licenses.test.ts`、`LICENSES.md` |
| Q4 | **`camera_zoom_sharpness.test.ts` 是否允许改写？** 我按 D5 做到**零改动**；若评审坚持全局改 `linear`，则须把授权范围扩到该文件。 | **按 D5 零改动**（无需扩权） | M17 冻结测试 |
| Q5 | **HD 分辨率基准与体积预算数值** | `tilePx = 64`；单文件 ≤4 MiB、总量 ≤32 MiB、≤4096²、≤12 张 | 美术规格书、`licenses.test.ts` |
| Q6 | **`fx.spark` 是否升级为 `AnimatedSprite`？** 冻结粒子契约要求 `Graphics`。 | **保持 `Graphics`**（HD 质感落在纹理填充与绘制参数） | `fx_art.test.ts` 冻结断言 |

---

## 附录 A · 决策记录（ADR 摘要）

- **ADR-M18-01 图集形态**：保留双件、显式关联、世界 HD 入 `hd/`、UI 入 `ui/`、删除 `atlas/`。备选：单文件 atlas manifest —— 否决（PixiJS 需纹理+描述分离）。
- **ADR-M18-02 采样**：全局 `nearest` + HD 按纹理 `linear`+mipmap。备选：全局 `linear` —— 否决（撞 M17 冻结测试，且像素 UI 仍需 nearest）。
- **ADR-M18-03 墙体深度**：autotile + 格内 3/4 构成 + 立面仅向墙格延伸。备选：统一悬挑 —— 否决（违 FR-010/SC-004）。
- **ADR-M18-04 场景图**：零新增节点。备选：新增 wall-cap 层 —— 否决（撞 F5）。
- **ADR-M18-05 尺寸**：由纹理实际尺寸推导。备选：写死新常数 —— 否决（分辨率耦合、FR-008 易漂）。
- **ADR-M18-06 循环**：`idle/move` 循环、其余停末帧。依据 FR-006。
- **ADR-M18-07 预算**：≤4 MiB / ≤32 MiB / ≤4096² / ≤12 张。依据 `contracts §6` + WebGL 下限。

## 附录 B · 行号索引（已核实）

| 引用 | 位置 |
|---|---|
| 唯一引用点 / `MANIFEST` / `SHEET_DATA` | `client/assets/manifest.ts:28-60,134,188` |
| `AssetEntry` / `SpriteSheetData` | `client/assets/manifest.ts:69,92` |
| 全局采样默认 | `client/assets/AssetCatalog.ts:134` |
| `resolveSource`（HD 采样落点） | `client/assets/AssetCatalog.ts:217-233` |
| `adopt` / `animation` / `texture` | `client/assets/AssetCatalog.ts:236,191,204` |
| 命名/回退链/量化/分类/尺寸公式 | `client/assets/sprite-map.ts:42,49,66,133,149,177,210,236,265` |
| `ANIM_FRAME_MS` / `TILE_NATURAL_PX` | `client/GameRenderer.ts:428,418` |
| `syncStaticGeometry` / `buildWallNode` / `ensureStaticLayer` / `syncFloor` / `tileTexture` | `client/GameRenderer.ts:1046,1099,1133,1167,1224` |
| `selectAnimation` / `advanceAnimation` | `client/GameRenderer.ts:1385,1433` |
| `createPlayerView` / `createEnemyView` / `buildAnimatedBody` | `client/GameRenderer.ts:2149,2208,2262` |
| `createHazardView` / `VFXManager.spawnSpark` | `client/GameRenderer.ts:1944`、`client/VFXManager.ts:209` |
| 启动加载序列 | `client/main.ts:242-246` |
| M17 采样冻结断言 | `tests/render/camera_zoom_sharpness.test.ts:34` |
| 基线摘要 `f52dfdd4` | `tests/harness/camera_zoom_lossless.test.ts:60` |
| 无损摘要方法 | `tests/harness/render_art_lossless.test.ts:52-79` |
| 6 条冻结契约 | `tests/render/tilemap_art.test.ts:144-205`、`tests/render/camera_zoom_scene_graph.test.ts:109-176` |
| 体积/许可/形态断言 | `tests/assets/licenses.test.ts:30-34,51-100,104-151` |
| 许可白名单 / CC0 断言 | `tests/assets/manifest.test.ts:29,105` |
