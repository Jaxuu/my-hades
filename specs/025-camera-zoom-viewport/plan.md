# Implementation Plan: 相机缩放与视口自适应（M17）

**Branch**: `025-camera-zoom-viewport` | **Date**: 2026-10-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/025-camera-zoom-viewport/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command; its definition describes the execution workflow.

## Summary

解决「高分辨率屏幕下 10×10 房间缩在画布一角、小到看不清」这一原始问题：在**表现层 `client/`** 引入一个**全局、统一的相机等比缩放因子** `z`，作用于**全部世界空间内容**（地板 / 墙体 / 玩家 / 敌人 / 投射物 / 危险预警 / 掉落物 / 命中特效 / 伤害跳字），使房间按一个舒适比例居中且完整可见；同时**不改变**屏幕空间内容（HUD / 奖励三选一 / 死亡 / 胜利 / 营地覆盖层，全部是 DOM）。

技术路线（详见 [research.md](./research.md)）：`z` 由**当前房间范围**（墙 AABB 并集，只读 `World`）与**当前视口尺寸**（`app.screen` 的守卫式读取）共同决定 —— `z = clamp(fitZoom × 0.8, 1, 16)`，`fitZoom = min(视口宽/房间宽px, 视口高/房间高px)` —— 直接施加在既有 `cameraContainer.scale` 上（**不新增任何场景节点**），并按「房间能否被完整容纳」把 `syncCamera` 的取景分为**两种且仅两种模式** —— **房间模式**（房间可容纳：房间居中于视口且**静止**，不随玩家漂移；这是全部现有房间的默认取景）与**跟随模式**（房间大于视口：保留 `screen/2 − playerPx × z` 的「以玩家为中心」跟随并**钳制在房间边界内**）。退化时目标 = 旧公式 `screen/2 − playerPx`（`z === 1` 时与旧公式**逐位相同**）。

三条硬边界：**模拟内核 `src/` 零改动**（`git diff --stat src/` 空输出）；**17 段管道不变**；**既有 803 个测试用例与 6 条渲染场景图冻结契约零改动**。既有渲染测试全部走「退化路径」（视口不可读 或 无房间范围 ⇒ `z = 1`），因此零改动继续通过 —— 这是本设计的枢纽。

## Technical Context

**Language/Version**: TypeScript 5.7（`strict`）· Node ≥ 22 · ES2022（`client/` 额外含 DOM lib；根 `tsconfig` 不含 `client/`）

**Primary Dependencies**: pixi.js **8.21.0**（渲染；已对本机 `node_modules/pixi.js` 的 `.d.ts` 实测核对：`ApplicationOptions` 支持 `antialias` / `resolution` / `autoDensity` / `resizeTo`；`AbstractRenderer.screen` 是**逻辑（CSS 像素）**尺寸；`TextureSource.defaultOptions.scaleMode` 可设、`SCALE_MODE = 'nearest' | 'linear'`）· vite 5.4（构建）· vitest 2.1.8（`pool: 'threads'`）。`src/` 保持**零运行时依赖**；`howler` 仍只被 `client/AudioManager.ts` 导入，**`GameRenderer` 导入图不含 howler**。

**Storage**: 无后端、无数据库、无落盘。本特性**不改** `assets/data/*.json`、**不新增**任何资产；房间范围来自运行时只读读取 `WallComponent`，非配置表。

**Testing**: vitest（node，`pool: 'threads'`）。既有 **803 例 / 50 文件零改动**；本特性新增的断言沿用「鸭子类型 `Application`（`{ stage, ticker }`）+ 真 PixiJS 场景图」的既有 node 渲染套件模式（`tests/render/*`），并复用 `camera_adversarial` 已有的**带 `screen` 的替身**（其 `renderer` getter 会抛错，用于证明渲染层绝不读 `app.renderer.*`）。五道闸门：`npm test` · `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build`。

**Target Platform**: 桌面浏览器（`vite dev` / `vite build` 产物）。离线可用、无外部服务。

**Project Type**: 单仓库 Web 前端（headless 逻辑内核 `src/` + 表现层 `client/`），非前后端分离。

**Performance Goals**: 压测场景（30×30 `stress_room` · 约 150 敌 · ~174 实体）下，表现层**每帧 CPU 耗时**的「改动后 / 改动前」**比值 ≤ 1.2**（同机、同场景、同脚本、连续 3 次取中位数）。缩放重算为 `O(1)` 且复用 `syncStaticGeometry` 已算出的包围盒 ⇒ 预期比值 ≈ 1.0。判定 MUST 用比值，MUST NOT 用绝对墙钟（宪法 Principle IV）。

**Constraints**:
- **模拟内核冻结**：`git diff --stat src/` 必须为空；`src/` 不新增任何 import；不新增 / 不重排管道段（恒 17 段）。
- **6 条渲染场景图冻结契约**（F1–F6）不得破坏：`stage` 唯一子节点 = camera；`camera.children[last]` = root；`root.children[last]` = fxLayer；`root.children[0]` = 首个实体视图；无墙时 `camera.children` 长**恰 1**；空闲时 `fxLayer.children` 长**恰 0**。⇒ **禁新增任何常驻场景节点**；缩放施加在既有 `cameraContainer.scale` 上。
- **既有 803 例零改动**：既有渲染断言（`toBeCloseTo(..., 6)` 钉的跟随收敛、`camera.children` 长度、视图/墙块的**世界像素**坐标）不得修改。⇒ 退化路径必须**逐位**等价旧行为。
- **单向依赖**：`client → src` 允许；`src → client` 永不出现（ESLint AST 门禁，仅 `src/**`）。
- **退化契约**：视口不可读 / 非有限 / 非正，或房间范围不可确定 ⇒ `z = 1`、不进入任何取景模式、目标 = 旧公式，逐位一致，不抛错、不阻塞渲染。取景模式由 `roomFits = roomPxW×z ≤ vw ∧ roomPxH×z ≤ vh` 判定（**只**由房间能否被完整容纳决定，MUST NOT 依赖玩家位置）。
- **确定性**：`z` 是 `(房间范围, 视口尺寸)` 的纯函数，无随机、无墙钟（FR-020）。

**Scale/Scope**: 1 个全局缩放因子 · 3 类真实房间（`start_room` 10×10 / `arena_room` 12×10 / `stress_room` 30×30）· 主要验收视口 1920×1080 与 2560×1440（另覆盖 800×600 → 3840×2160 与 32:9 / 9:16 极端宽高比）· 世界空间内容 9 类随缩放，屏幕空间内容 4 个界面面不变。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 宪法条款 | 本特性的合规判定 | 结论 |
|---|---|---|
| **I. 逻辑内核零浏览器依赖** | 全部改动落在 `client/**`（`GameRenderer` / `main.ts`）+ `specs/**`；`src/` **零新增 import**、零行为变更。渲染层只**读** `World`（`WallComponent` / `TransformComponent` / 既有组件）。 | ✅ PASS |
| **II. 确定性模拟** | 缩放是**纯表现层**映射：不进 `snapshot()`、不读墙钟、不消费 `World.rng`；`z` 是 `(房间范围, 视口)` 的纯函数（无随机）。同种子同输入下模拟状态序列与改动前逐 Tick 一致（SC-004 对拍）。 | ✅ PASS |
| **III. 17 段固定管道** | 不新增 / 不重排任何系统段；`TransformSnapshotSystem` 仍 idx 0、`LifespanSystem` 仍 LAST。9 处管道钉桩零改动。 | ✅ PASS |
| **IV. 测试先行与证据化验证** | 流程为「冻结规格 → 写失败测试 → 实现 → 评审 → 修复」；测试用真 `GameSimulator` + 真 `GameRenderer`，不 mock 模拟层；浮点容差 `1e-9`；退化路径用**字面量**钉桩（`z === 1`）；无损以**同种子状态序列对拍**自证；性能用**比值**非绝对墙钟。 | ✅ PASS |
| **V. 表现层隔离** | 改动仅在 `client/`；`client → src` 单向；渲染器仍只读 `World`、不推进模拟；`GameRenderer` 导入图不含 `howler`（本特性只新增对 `src/ecs/components/GameStateComponent` 的**只读** import，无浏览器全局）。 | ✅ PASS |
| **VI. 既有核心不可重构** | 组件 / 系统 / `World` / 预制体 / 管道**零改动**；「房间范围」由既有 `WallComponent` 只读派生，**不改** `LevelLoader` / `RoomLoadResult`；缩放是叠加在既有换算（`PX_PER_UNIT = 10`）之上的视口因子，**不替换**该换算。 | ✅ PASS |

**关键合规风险（已消解，见 research.md）**：spec 19 §1.3 与 spec 20 §2.1（I11）把相机**显式冻结为「只平移、不缩放」**。本规格是**唯一**授权扩展该条目的治理文档（扩展为「平移 + 等比缩放」）。扩展**严格保留** I11 其余语义（实体/墙体视图仍持有**世界像素**坐标，只有相机节点承载视图变换）、I12（视口不可读时安全降级）、I13（场景图契约）、I14（相机为表现层独有）。另有一处**必须显式登记的延伸**：`syncCamera` 的取景由「单一以玩家为中心跟随」扩展为**双取景模式**（房间可容纳时以**房间为中心静态取景**；房间大于视口时保留玩家跟随并钳制在边界内）。spec 20 §1.3 曾把「房间边界钳制」与「以房间为中心」分别列为**独立里程碑 / 排除项** —— M17 正是该里程碑，且 FR-004 / SC-001 / SC-005 要求「房间完整可见**且居中静止**」在数学上**只能**由房间模式达成（详见 Complexity Tracking 与 research.md D3）。

**Gate 结论**：Phase 0 前 **PASS**；Phase 1 后复检 **PASS**（见文末）。

## Project Structure

### Documentation (this feature)

```text
specs/025-camera-zoom-viewport/
├── plan.md              # This file (/speckit.plan command output)
├── spec.md              # Feature specification (/speckit.specify)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── camera-view-transform.md
│   ├── zoom-fit-and-degradation.md
│   └── scene-graph-and-screen-space.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit.specify)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
client/
├── GameRenderer.ts              # 主战场（本特性唯一实质性改动点）：
│                                #   · 缓存「房间范围」（复用 syncStaticGeometry 已算的墙包围盒）
│                                #   · 新增纯函数式缩放重算（房间范围 × 视口 ⇒ z，夹取 [1,16]）
│                                #   · 把 z 写入 cameraContainer.scale（不新增节点）
│                                #   · syncCamera 取景改双模式：roomFits ⇒ 房间模式（目标 = screen/2 − 房间中心px×z，房间居中静止）；否则跟随模式（目标 = clamp(screen/2 − playerPx×z, 房间边界)）
│                                #   · reset() 复位 scale = 1
├── main.ts                      # 改 app.init 选项：resolution = devicePixelRatio、autoDensity = true、
│                                #   antialias = false（像素美术）；resizeTo: window 已存在（FR-010 免费）
├── assets/AssetCatalog.ts       # 改：加载前设 TextureSource.defaultOptions.scaleMode = 'nearest'（FR-008）
├── UIManager.ts                 # 不改（DOM，天然屏幕空间）
├── VFXManager.ts                # 不改（粒子坐标已是世界像素，随 cameraContainer 缩放）
└── assets/sprite-map.ts         # 不改

assets/data/                     # 不改（rooms.json / encounters.json 原样）

tests/
└── render/                      # 既有 6 套件零改动；新增缩放/退化断言（沿用鸭子类型 Application 模式）
```

**Structure Decision**: 沿用既有单仓库布局，**不新建工程、不新增目录**。本特性是**纯表现层**改动，且刻意收敛到 `client/GameRenderer.ts` 一个文件（外加 `main.ts` / `AssetCatalog.ts` 两处启动期选项）：`z` 只是既有相机容器的一个新变换分量，房间范围只是对既有 `WallComponent` 的一次只读派生 —— 二者都不需要新的模块、新的场景节点或新的数据结构。把改动压到最小面，是本特性「零回归」目标的结构性保障。

## Complexity Tracking

> 本特性**无宪法违规**（Constitution Check 全 PASS）。下表登记的是**对既有冻结规格的两处授权延伸** —— 按 spec 025 §Assumptions 与治理要求，必须正面写清「为何需要、为何更简单的替代被否决」。

| Violation（冻结项延伸） | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| **对 I11 的授权扩展：相机由「只平移」扩展为「平移 + 等比缩放」**（spec 20 §2.1 I11 / spec 19 §1.3 冻结「只平移、不缩放」） | 这正是 M17 要解决的原始问题（10×10 房间在 1080p 下仅 100×100 px）。spec 20 §1.3 把「相机缩放」与「房间比屏幕小」显式登记为**独立里程碑**（INVARIANTS M16 的 L1 亦重申「不得借 M16 引入缩放」）；spec 025 是该里程碑的**唯一**授权文档。扩展严格保留 I11 其余语义 + I12/I13/I14。 | ①**改 `PX_PER_UNIT`（10 → 更大）**：否决 —— 它会改变逻辑→像素的**唯一常量契约**（spec 09 C8），且无法同时适配 10×10 与 30×30 两类房间（固定倍率必有一类不合适）；还会波及所有以 `PX_PER_UNIT` 为字面量的既有断言。②**把房间画大（放大静态层几何）**：否决 —— 只放大地板/墙而不放大实体，会破坏「视觉边界 = 碰撞边界」（spec 024 FR-007/008），且实体位置仍按旧换算。③**不缩放、只让玩家手动放大**：否决 —— 与 US1「自动适配」相悖，且固定倍率无法覆盖多尺寸房间。 |
| **对 spec 19 §1.3 / spec 20 §1.3『相机不缩放、不做世界原点重定位』的授权延伸：新增房间模式取景**（房间可容纳时以房间为中心静态取景） | FR-004（房间可容纳时房间 MUST **居中且静止**）、SC-001（1080p 下 10×10 房间**完整可见、居中**）、SC-005（视口连续变化时房间**始终完整可见**）共同要求「房间居中且不漂移」—— 起始房间玩家出生在 `(4.5, 8.5)`（非房间中心 `(5,5)`），任何**以玩家为中心**的取景都会使房间随玩家滑动或越界，故必须引入独立的房间模式取景。这是全部现有房间（10×10 / 12×10 / 30×30）的**默认取景**（见 research.md D3）。 | ①**纯玩家跟随（不钳制）**：否决 —— 出生点即垂直溢出 194 px（`z = 8.64`），直接违反 SC-001「不出现裁剪或溢出」；且要压低 `z` 使纯跟随不裁须 `z ≤ 5.4` ⇒ 房间仅占视口短边 50%，低于 SC-001 的 55% 下限（与 SC-001 数学矛盾）。②**纯跟随 + 钳制（永不裁剪但相机仍随玩家滑动）**：否决 —— 1080p 下 10×10 房间仅占视口宽度 864/1920，水平富余 1056 px ⇒ 房间随玩家左右滑动最多约 777 px，视觉上「房间在屏幕上飘」，与 FR-004「房间 MUST 居中且静止」及用户原话「让 10×10 的房间能在屏幕**居中**」相悖。 |

**双取景模式的合规边界（写清以免误解）**：房间模式与跟随模式都只改写 `syncCamera` 的**平移目标取值**，**不引入**新的变换类型（相机仍只有 `translate + scale`）、不引入旋转、不新增节点、不写 `World`。因此它仍在 I11「相机由「只平移」扩展为「平移 + 等比缩放」」的授权范围内，且严格保留 I11/I12/I13/I14 的其余语义。退化路径下（视口不可读 / 房间范围不可确定）**不进入任何取景模式**，逐位等价旧行为。

---

## Phase 0 / Phase 1 产物索引

| 产物 | 内容 |
|---|---|
| [research.md](./research.md) | D1–D11 决策：缩放公式与上下限、应用节点、双取景模式（房间模式 / 跟随模式）、退化策略、高 DPI 与保锐采样、视口自适应时机、HUD 免疫、跳字/VFX 归属、震动共存、性能、既有测试影响评估 |
| [data-model.md](./data-model.md) | 视口 / 缩放因子 / 房间范围 / 相机视图状态 / 世界-屏幕空间分类 的只读模型与不变量 |
| [contracts/camera-view-transform.md](./contracts/camera-view-transform.md) | 相机视图变换契约（缩放 + 平移；子节点屏幕位置；跟随目标；退化逐位等价） |
| [contracts/zoom-fit-and-degradation.md](./contracts/zoom-fit-and-degradation.md) | 缩放适配 / 退化契约（公式、上下限、退化触发条件） |
| [contracts/scene-graph-and-screen-space.md](./contracts/scene-graph-and-screen-space.md) | 场景图与屏幕空间边界契约（F1–F6 + 世界/屏幕空间分类） |
| [quickstart.md](./quickstart.md) | 端到端验证场景与命令（覆盖 SC-001/003/004/005/006/007） |

## Constitution Check（Phase 1 设计后复检）

| 条款 | 复检判定 | 结论 |
|---|---|---|
| I. 无头内核 | 设计产物未要求任何 `src/` 改动；缩放与房间范围派生全在 `client/`；`src/` 新增 import = 0 | ✅ PASS |
| II. 确定性 | `z` 是 `(房间范围, 视口)` 的纯函数；不进快照、不读墙钟、不消费 PRNG；SC-004 对拍为证 | ✅ PASS |
| III. 17 段管道 | 无系统增删 / 重排 | ✅ PASS |
| IV. 测试先行 | 退化路径以字面量 `z === 1` 钉桩；无损用同种子状态序列对拍；性能用比值；含变异实验 | ✅ PASS |
| V. 表现层隔离 | 只在 `client/` 扩充；缩放施加在既有 `cameraContainer.scale`（**不新增常驻节点**）；单向依赖不变；`GameRenderer` 导入图不含 howler | ✅ PASS |
| VI. 核心不可重构 | 房间范围只读派生自既有 `WallComponent`；不改 `LevelLoader` / `RoomLoadResult` / 组件 / 系统 / 管道 | ✅ PASS |

**复检结论**：PASS，无宪法违规需豁免；两处**冻结规格延伸**已在 Complexity Tracking 显式登记并给出理由与被否决的替代方案。
