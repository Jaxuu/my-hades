---
description: "Task list for M18 · 高清 2D 美术与动画资产替换"
---

# Tasks: 高清 2D 美术与动画资产替换（M18）

**Input**: Design documents from `/specs/026-hd-2d-art-assets/`

**Prerequisites**: `plan.md` · `spec.md` · `research.md` · `data-model.md` · `contracts/` · `quickstart.md`

**Tests**: **必需（非可选）**。本项目宪法 Principle IV（测试先行与证据化验证）MUST 遵守，流程为「冻结规格 → 写失败测试 → 实现 → **独立评审** → 修复」。此外 `spec.md` FR-029 显式要求更新资产/渲染测试套件并保证总数 ≥ 893。因此每个用户故事阶段都包含测试任务，测试 MUST 先写、先失败，且流程 MUST 包含**独立评审**（见 T067）。

**Organization**: 按用户故事分组，每个故事可独立实现与独立验收。

**修订记录**: 本文件经 `/speckit.analyze` 审计后修订（2026-10-03），闭环了 1 项 CRITICAL（K1 独立评审缺失）与 4 项 HIGH（I1 门禁空窗、C1 局内特效无任务、A1 FR-006 不可测、D1 FR-028 重复）。详见 `research.md` §7。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（**US1–US8**，对应 `spec.md`）
- 每个任务都带**确切文件路径**

## Path Conventions

单仓库双层结构（见 `plan.md` §Project Structure）：

- **冻结层**：`src/` —— 本特性**改动文件数 MUST 为 0**
- **表现层**：`client/` —— 全部改动落点
- **资产**：`assets/art/hd/`（新增）· `assets/art/atlas|raw|tools/`（删除）· `assets/art/ui|audio/`（保留）
- **测试**：`tests/`
- **证据与一次性工具**：`production/`

## 全局硬约束（每个任务都必须遵守）

| 约束 | 来源 |
|---|---|
| `src/` 改动文件数 = 0；17 段管道不变；依赖方向单向 | FR-011 / FR-014 / FR-013 |
| 不新增任何运行时依赖（`client/` 仍只有 `pixi.js` + `howler`） | FR-031 |
| 唯一资产引用点 = `client/assets/manifest.ts`（构建期静态导入） | FR-019 |
| 覆盖范围 = 局内世界美术（玩家 · 敌人 · 地牢 · **局内特效与掉落物**）；`ui.*` / `sfx.*` 保持现状 | FR-030 |
| 基准 tile = 128；单文件 ≤3MB · 总量 ≤12MB · 图集 ≤4096²（目标 ≤2048²）· 图集数 ≤12 · gutter ≥4px | `research.md` D2/D3/D8 |
| 全局 `nearest` 保持 + HD 世界美术按纹理 `linear`+mipmap | `research.md` D7 |
| `fx.spark` 保持 `Graphics`；`AnimationState` 不扩展 | `research.md` D11/D12 |
| 场景图零新增节点；墙体深度内嵌既有 wall node | `research.md` D10 |
| 墙体像素 MUST NOT 外溢墙格 | `research.md` D9 |
| 契约断言（只读/确定性/降级/场景图/无专有资产）MUST NOT 放宽 | `research.md` R8 |

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 建立 HD 资产目录、录制基线、并生成**程序化占位 HD 图集**，使渲染层与真实美术可以并行推进。

- [x] T001 录制改动前基线：运行五道闸门（`npm test` / `npm run typecheck` / `npm run typecheck:client` / `npm run lint` / `npm run build`），记录用例总数（预期 893）、无损摘要（预期 `f52dfdd4`，seed `0x12345678`，601 tick）、以及 `?mode=stress` 的每帧耗时基线，写入 `production/m18-baseline.md`
- [x] T002 创建 HD 资产目录 `assets/art/hd/`，并写 `assets/art/hd/README.md` 说明目录约定、命名契约（`<spriteId>.<action>.<facing>`）、gutter ≥4px 与打包坐标要求（引用 `contracts/hd-spritesheet-schema.md`）
- [x] T003 [P] 编写一次性占位图集生成器 `production/m18-placeholder-atlases.mjs`（Node，零依赖，用 `node:zlib` 手工编码 PNG；**不放 `assets/art/tools/`**，避免与「移除像素生成工具」的语义冲突）
- [x] T004 用 T003 的脚本生成 **9 张世界 HD 占位图集** `assets/art/hd/{player,enemy-grunt,enemy-elite,enemy-raider,enemy-bomber,enemy-gunner,enemy-unknown,tiles,fx}.{png,json}`：帧尺寸 128²（elite 160²、小怪 96²）、相邻帧 gutter ≥4px、JSON 满足 `contracts/hd-spritesheet-schema.md` §2 的 schema 与命名契约、`meta.tilePx = 128`
- [x] T005 [P] 更新 `assets/art/LICENSES.md`：登记占位图集为「本仓库原创 · 程序化生成（`production/m18-placeholder-atlases.mjs`）」，并预置 HD 素材来源登记小节

**Checkpoint**: HD 目录与占位图集就位，渲染层可以开始接入。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 重定义资产结构、换算基准与许可口径。这些改动**阻塞全部用户故事**。

**⚠️ CRITICAL**: 本阶段完成前，任何用户故事都不得开始。

**⚠️ 原子性要求（闭环 I1）**：T006 / T007 / T012 / T013 **MUST 在同一批变更中完成**。T006 把 source 重指向 HD 后，若 T012 未同步改写 `tests/assets/licenses.test.ts`，HD 帧矩形会被拿去与旧像素 PNG 尺寸比对而**立即越界失败**；T007 新增的 `fx.pickup.*` 若未同步登记，`manifest.test.ts` 的**可追溯断言也会立即失败**。分开做会让门禁在整个 Phase 2–7 持续为红，违反宪法「里程碑门禁全绿」与「先测后写」。

- [x] T006 `client/assets/manifest.ts`：把世界美术条目的 `source` 指向 `assets/art/hd/*`（`player.base`、6 个 `enemy.*`、`tile.floor`、`tile.wall`、`fx.*`）；**`ui.*` 与 `sfx.*` 条目保持原样不动**（FR-030）
- [x] T007 `client/assets/manifest.ts`：`SHEET_DATA` 改为**显式关联**（每个 spritesheet id 键控到其图集 JSON，不再依赖「同名即配对」）；新增掉落物条目 `fx.pickup.gold` / `fx.pickup.heal` / `fx.pickup.darkness`；**并同步在 `assets/art/LICENSES.md` 登记这三个新 id**（否则可追溯断言失败，见上方原子性要求）
- [x] T008 `client/assets/AssetCatalog.ts`：保留 `TextureSource.defaultOptions.scaleMode = 'nearest'` 于 `load()` 开头（**M17 断言必须继续成立**），并在解析后对每个 **HD 世界美术**纹理的 `TextureSource` 显式设 `scaleMode = 'linear'` 与 `autoGenerateMipmaps = true`（`research.md` D7）
- [x] T009 `client/GameRenderer.ts`：`TILE_NATURAL_PX` 由 `16` 改为 `128`（`research.md` D2）；确认 `PX_PER_UNIT` 仍为 `10`
- [x] T010 [P] `client/assets/sprite-map.ts`：`pickupIconId` 的三个返回值由 `ui.icon.*` 改为 `fx.pickup.*`（保持纯函数与「三 id 互不相同」的语义）
- [x] T011 [P] `tests/harness/art-fixtures.ts`：适配新的图集结构（`frameName` 仍遍历 `SHEET_DATA`，语义不变；`WHITE_LOADER` 不变）
- [x] T012 改写 `tests/assets/licenses.test.ts`（**合并原「新增结构断言」与「移除旧形态断言」两条，消除同文件跨阶段冲突**）：① **移除**「每个 spritesheet 源必须有 PNG + 同名 JSON 并存」与「`raw/` 包数 ≥5 且各带 `License.txt`」两条**已失去前提**的旧像素形态断言；② **保留**「帧矩形不越界」，并把比对基准从 `assets/art/atlas/` 改为 HD 图集目录；③ **新增**：图集数量 ≤12、单图集像素 ≤4096²、相邻帧 gutter ≥4px、`meta.tilePx` 与 `GameRenderer` 的 `TILE_NATURAL_PX` 一致；④ **保留**「每个 id 都在 `LICENSES.md` 中可追溯」。**断言强度 MUST NOT 下降**（`research.md` R8 / VR-24）
- [x] T013 `tests/assets/manifest.test.ts`：把「`license` MUST 恰为 `CC0-1.0`」改写为「MUST 命中**显式字面量白名单** `['CC0-1.0','Public Domain','CC-BY-4.0']`」；**保留**「不含商业游戏专有资产」断言并扩展为已知发行商名单（`research.md` D17）

**Checkpoint**: 资产结构、换算基准与许可口径就位，且五道闸门仍全绿 —— 用户故事可以开始。

---

## Phase 3: User Story 1 - 玩家角色呈现为高清动画形象 (Priority: P1) 🎯 MVP

**Goal**: 玩家替换为高分辨率、动作流畅的 4 向 × 6 动作动画形象（idle/move/dash/attack/hit/death），攻击有清晰起手—命中—收招。

**Independent Test**: 在一个空房间里操作角色，观察待机、四向移动、攻击、受击是否清晰流畅、朝向与移动方向一致，且放大显示下不出现马赛克或锯齿。**无需敌人或地牢美术即可完整验证。**

### Tests for User Story 1 ⚠️（先写、先失败）

- [x] T014 [P] [US1] 更新 `tests/render/player_art.test.ts`：断言 HD 图集下机身是 `AnimatedSprite`、帧标签映射为 `player.base.<action>.<facing>`、四向切换、以及**资产缺失时降级回既有 `Graphics` 圆点 + 朝向线**（FR-013 契约，MUST NOT 放宽）
- [x] T015 [P] [US1] 在 `tests/render/player_art.test.ts` 新增**循环语义**用例：`idle` / `move` 循环播放；`dash` / `attack` / `hit` / `death` **停在末帧**（不得回绕首帧）—— `research.md` D13
- [x] T016 [P] [US1] 在 `tests/render/player_art.test.ts` 新增**攻击相位**用例：`attack` 的命中帧（f2–f3）落在模拟层 `ATTACKING` 的命中窗口内（`contracts/hd-spritesheet-schema.md` §4.1）
- [x] T017 [P] [US1] 新增**动画连续性量化测试** `tests/render/player_animation_continuity.test.ts`（闭环 A1）：在连续 600 帧窗口内逐项计数并断言为 0 —— ① 相邻帧显示间隔 > 标称帧时长 ×1.5 的次数；② 空白帧次数；③ 除 `death` 外动作的连续显示时长 > 标称总时长 ×2 的次数（FR-006 / SC-015）
- [x] T018 [P] [US1] 确认 `tests/assets/manifest.test.ts` 的**玩家 24 个动画键**断言保持不动（键集合不因 HD 化而改变）

### Implementation for User Story 1

- [x] T019 [US1] 产出玩家 HD 图集 `assets/art/hd/player.{png,json}`：4 向 × 6 动作 = 24 个动画键 / 148 帧、128² 画布、gutter ≥4px；`attack` 按 f0–1 起手 / f2–3 命中 / f4–5 收招切分
- [x] T020 [US1] `client/GameRenderer.ts`：玩家视图接入 —— `createPlayerView` / `buildAnimatedBody` 使用 HD 帧；`selectAnimation` / `advanceAnimation` 落实循环语义与帧时钟（`deltaMS` 驱动，`autoUpdate=false`）
- [x] T021 [US1] `client/GameRenderer.ts`：对齐**碰撞体锚定区域** —— 精灵缩放由 hurtbox 推导（`hurtboxSpriteScale`，`naturalPx = 128`），必要时调整 `anchor`，使「视觉尺寸 == 碰撞尺寸」（FR-008 / SC-004）

**Checkpoint**: 玩家 HD 动画可独立验收；US1 即为 MVP。

---

## Phase 4: User Story 2 - 敌人呈现为高清且可区分的怪物形象 (Priority: P1)

**Goal**: 六类敌人（`grunt`/`elite`/`raider`/`bomber`/`gunner`/`unknown`）各具专属 HD 形象，各含 4 向 × 4 动作，且**关闭颜色线索仍可区分**。

**Independent Test**: 在一个房间里依次生成每一种敌人，观察每一种是否有专属可区分形象、是否具备待机/移动/攻击/受击，且朝向与死亡表现正常。**不依赖玩家或地牢美术。**

### Tests for User Story 2 ⚠️（先写、先失败）

- [x] T022 [P] [US2] 更新 `tests/render/enemy_art.test.ts`：五类 + `unknown` 的**六个互不相同** sprite id、朝向随 `facingRadians` 旋转、hurtbox 缩放（精英可见更大）、**携带 `DeadTag` 时播放死亡表现**（闭环 C6 / FR-005）、以及**资产缺失时降级回既有方形**（契约，MUST NOT 放宽）
- [x] T023 [P] [US2] 在 `tests/render/enemy_art.test.ts` 新增 **`dash` 别名**用例：`enemy.<type>.dash.<facing>` 存在且其帧序列 **等于** `enemy.<type>.move.<facing>`（`research.md` D6）
- [x] T024 [P] [US2] 新增剪影区分测试 `tests/render/enemy_silhouette.test.ts`（闭环 I2）：**两组断言分开写** —— ① 数据表声明的 **5 类**两两在关闭颜色线索后可区分（FR-004 / SC-002）；② `unknown` **兜底形象**明显区别于上述 5 类（不与任何一类混淆）

### Implementation for User Story 2

- [x] T025 [P] [US2] 产出 `assets/art/hd/enemy-grunt.{png,json}` 与 `assets/art/hd/enemy-bomber.{png,json}`（各 4 向 × 4 动作 ≈92 帧、96² 画布、`dash` 别名 `move`）
- [x] T026 [P] [US2] 产出 `assets/art/hd/enemy-raider.{png,json}` 与 `assets/art/hd/enemy-gunner.{png,json}`（各 ≈92 帧、128² 画布）
- [x] T027 [P] [US2] 产出 `assets/art/hd/enemy-elite.{png,json}`（≈92 帧、160² 画布）与 `assets/art/hd/enemy-unknown.{png,json}`（兜底，形态明显区别于五类）
- [x] T028 [US2] `client/GameRenderer.ts`：敌人视图接入（`createEnemyView`）—— 类型在视图创建时解析一次（不逐帧），身体尺寸由 hurtbox 推导

**Checkpoint**: US1 与 US2 均可独立验收。

---

## Phase 5: User Story 3 - 关卡环境呈现为带深度感的高清地牢 (Priority: P1)

**Goal**: 房间升级为 HD 地牢 Tilemap：墙体具「格内三带」（顶面/立面/墙脚阴影）并**按邻接位掩码自动选件**，地面为精细多变体贴图。

**Independent Test**: 加载任意房间，观察墙体是否呈现立体深度、地面是否连续精细，且视觉墙边界与实际碰撞边界完全重合；遍历小型起始房、带柱子的竞技场、30×30 压测房确认无拉伸错位。

### Tests for User Story 3 ⚠️（先写、先失败）

- [x] T029 [P] [US3] 更新 `tests/render/tilemap_art.test.ts`：**保持** `staticLayer.children.length === 1 + wallCount`、`floorNode.children.length === 100`（10×10 房）、房间切换无残留；把 scale 断言重钉为 **128** 基准；wall node 内部构成断言随三带实现更新；**并加入「带内部柱子的竞技场」房间作为铺设验收场景**（闭环 C7 / SC-005）
- [x] T030 [P] [US3] **确认 `tests/render/tilemap_art.test.ts` 的 F1–F6 六条场景图冻结契约用例逐条保持不动**（MUST NOT 放宽、MUST NOT 删除）—— FR-027
- [x] T031 [P] [US3] 新增 autotile 完备性测试 `tests/render/tilemap_autotile.test.ts`：穷举全部可能邻接掩码，**每一个都解析到部件**（无空洞、无空白 tile）—— `contracts/tilemap-autotile.md` §3.2
- [x] T032 [P] [US3] 在 `tests/render/tilemap_autotile.test.ts` 新增**像素不外溢墙格**测试：对墙体部件图集做像素级越界检查，确认任何非透明像素都不越过所属墙格边界 —— FR-008 / SC-004 的**构造性**守护（`research.md` D9）
- [x] T033 [P] [US3] 在 `tests/render/tilemap_autotile.test.ts` 新增**立面不遮挡可通行格**测试（闭环 C2 / FR-010）：任一墙格的三带部件，其像素投影 MUST NOT 落在任何**可通行格**范围内 —— 与 T032 是两条独立性质，不可互相替代
- [x] T034 [P] [US3] 在 `tests/render/tilemap_autotile.test.ts` 新增**地面变体确定性**测试：同一房间连续两次构建，变体选择结果逐格相同；且不消费 `World.rng`

### Implementation for User Story 3

- [x] T035 [US3] 产出 `assets/art/hd/tiles.{png,json}`：8 个地面变体 + 47 个墙体部件（8 邻掩码），128²、gutter ≥4px、`meta.tilePx = 128`；墙部件按「顶面 ~55% / 立面 ~43% / 墙脚阴影 ~2%」三带构造
- [x] T036 [US3] `client/GameRenderer.ts`：`buildWallNode` 改为 **autotile + 三带内嵌** —— 每个 wall node 仍是一个 `Container`，深度作为其内部子精灵；**MUST NOT 新增任何节点或图层**
- [x] T037 [US3] `client/GameRenderer.ts`：`syncFloor` 实现**地面多变体的确定性选择**（按格坐标哈希，禁随机、禁墙钟）；`tileTexture` 保持「同名动画优先」语义

**Checkpoint**: US1 / US2 / US3 三条 P1 故事全部可独立验收。

---

## Phase 6: User Story 4 - 纯表现层替换，玩法与逻辑逐 Tick 不变 (Priority: P1)

**Goal**: 证明本特性只改变「看起来是什么样」，绝不改变「实际是什么」—— 用户明确写下的硬约束。

**Independent Test**: 固定种子 + 固定输入序列下，改动前后逐 Tick 状态序列与快照摘要逐位相同；源码差异中 `src/` 文件数为零。

### Verification for User Story 4

- [x] T038 [US4] 运行 `git diff --stat -- src/` 与 `git status --short -- src/`，确认**均为空**（SC-007）；结果记入 `production/m18-evidence.md`
- [x] T039 [US4] 运行无损对拍：seed `0x12345678` / 601 tick，比较 `listEntities() × listComponents()` 拼串过 FNV-1a 的摘要，MUST **逐位等于 `f52dfdd4`**（SC-006）；记入 `production/m18-evidence.md`
- [x] T040 [US4] 确认 `tests/harness/` 下两个 lossless 套件**零改动**且继续通过（改动它们即等于放宽证明，MUST NOT）
- [x] T041 [US4] 依赖方向与**只读契约**（FR-013 / FR-015，闭环 C5）：① `client/GameRenderer.ts` 的导入图**不含 `howler`**；② 全仓无 `src → client` 依赖；③ `tests/assets/sprite-map.test.ts` 的「never writes to the world」与「does not consume randomness」两例**零改动且通过**
- [x] T042 [US4] 验证 17 段管道段数与顺序不变（用既有钉桩实测：`grep -rl "'TransformSnapshotSystem'" tests/` 的 9 处；段数钉桩 `toHaveLength(N)` MUST NOT 放宽）
- [x] T043 [US4] **无新增运行时依赖**（FR-031，闭环 C4）：断言 `package.json` 的 `dependencies` 恰为 `{pixi.js, howler}`（字面量集合相等）；确认 `client/` 的导入图未引入任何第三方模块；结果记入 `production/m18-evidence.md`

**Checkpoint**: 「纯表现层」这一硬约束有了**机器可判定的证据**，而非口头声明。

---

## Phase 7: User Story 5 - 低分辨率像素资产与生成工具被彻底移除 (Priority: P2)

**Goal**: 仓库不再残留任何低分辨率像素美术、像素派生生成工具与像素源素材包；构建产物中亦无旧像素资产。

**Independent Test**: 在仓库中检索低分辨率像素资产与生成工具，残留数为零；构建成功且产物不含旧像素资产。

> **前置**：本阶段 MUST 在 US1 / US2 / US3 / US8 的世界美术全部就位后执行 —— 否则会删除仍在服务的资产。

### Implementation for User Story 5

- [x] T044 [US5] 删除 `assets/art/atlas/**`（`player/enemies/tiles/fx/ui.{png,json}`）
- [x] T045 [US5] 删除 `assets/art/tools/build-atlas.py`
- [x] T046 [US5] 删除/退役 `assets/art/raw/**`（像素源素材包）
- [x] T047 [US5] 更新 `assets/art/LICENSES.md`：移除像素源包登记；逐项登记 HD 素材的来源、作者、许可与**修改说明**（重绘/程序化派生须注明）
- [x] T048 [US5] 验证 `npm run build` 成功，且 `dist/` 中不含旧像素资产（`atlas/`、`raw/`）；同时验证**故意删除一个 HD 资产会让构建响亮失败**（唯一引用点契约，FR-019）
- [ ] T049 [US5] 删除一次性占位生成器 `production/m18-placeholder-atlases.mjs`（真实美术已就位后），并同步 `assets/art/LICENSES.md` 中占位图集的登记

**Checkpoint**: 仓库洁净度达成，构建仍是唯一的「悬空引用」安全网。

---

## Phase 8: User Story 8 - 局内特效与掉落物呈现为高清资产 (Priority: P2)

**Goal**: 命中火花、冲刺拖尾、危险预警环、伤害数字与三类掉落物全部 HD 化，且「应拾取」与「应躲避」两类视觉上不混淆。

**Independent Test**: 触发一次命中、一次冲刺、一次危险预警、一次拾取与一次击杀，观察每一类是否呈现为 HD 资产、风格统一，且两类掉落物不混淆。**不依赖玩家/敌人/地牢美术。**

> **说明**：本故事补上了 FR-030「局内世界美术」的第四个组成部分。它没有出现在最初的 7 条故事中，是 `/speckit.analyze` 发现的覆盖空洞（C1）—— 局内特效在规格范围内却无任何实现任务。本阶段置于 P2 组之首，以便**全部世界美术产出完成后再进入验证类故事**。

### Tests for User Story 8 ⚠️（先写、先失败）

- [x] T050 [P] [US8] 更新 `tests/render/fx_art.test.ts`：保持**冻结粒子契约** —— 每个 spark MUST 仍是 `Graphics`（MUST NOT 升级为 `AnimatedSprite`，`research.md` D11）；断言 provider 仍被请求 `fx.spark` / `fx.dash-trail`；断言资产缺失时降级回既有几何
- [x] T051 [P] [US8] 新增**掉落物视觉区分**测试（FR-030 / SC-016）：三类掉落物 id 互不相同、各具专属形象，且「应拾取」与「应躲避」两类在**关闭颜色线索**后仍不混淆

### Implementation for User Story 8

- [x] T052 [US8] 产出真实 `assets/art/hd/fx.{png,json}`：命中火花（供 `Graphics` 纹理填充）、冲刺拖尾、危险预警环、三类掉落物 `fx.pickup.{gold,heal,darkness}`、伤害数字字形；尺寸/帧数按 `design/art-direction.md` §B.4，gutter ≥4px
- [x] T053 [US8] `client/GameRenderer.ts` 与 `client/VFXManager.ts`：特效接入 HD 资产 —— 火花保持 `Graphics` 并以 HD 纹理填充；拖尾/预警环/掉落物/伤害数字改用 HD 帧；危险预警的进度**仍由组件引信驱动**（MUST NOT 改由美术时钟驱动）
- [x] T054 [US8] `assets/art/LICENSES.md`：登记 fx 图集各项来源、作者、许可与修改说明

**Checkpoint**: FR-030 的四个组成部分（玩家 / 敌人 / 地牢 / 局内特效）全部 HD 化。

---

## Phase 9: User Story 6 - 高清资产在放大显示与视口变化下保持锐利 (Priority: P2)

**Goal**: HD 资产在 M17 相机缩放放大后仍清晰：无像素块放大、无可见锯齿、无摩尔纹；视口变化与滚动时无撕裂错位。

**Independent Test**: 在多种视口尺寸与多个相机缩放倍率下观察角色、敌人与地牢纹理，确认放大仍清晰、无撕裂。

### Tests for User Story 6 ⚠️（先写、先失败）

- [x] T055 [P] [US6] 新增 HD 锐利度测试 `tests/render/hd_sharpness.test.ts`：断言 HD 世界美术纹理的 `TextureSource.scaleMode === 'linear'` 且 `autoGenerateMipmaps === true`；**同时断言全局默认仍为 `'nearest'`**（M17 契约不破）
- [x] T056 [P] [US6] 确认 `tests/render/camera_zoom_sharpness.test.ts` **零改动**且继续通过（该文件不在授权更新集内，`research.md` D7 / FR-028）

### Verification for User Story 6

- [x] T057 [US6] 真浏览器像素验收（**必须 CDP + 真实时间**，不得用 `--virtual-time-budget`；每个视口**独立重载**以避免 SwiftShader 丢画布）：在 1920×1080 / 2560×1440 / 32:9 / 9:16 / 800×600 下截图，检查无锯齿、无摩尔纹、无撕裂；复用 `production/m17-probe.mjs` 的模式，输出到 `production/m18-shots/`
- [x] T058 [US6] 摩尔纹专项：30×30 压测房（`assets/data/` 中的压测房间配置）在 `z=2.88`、DPR1（128px → 29px，缩小 4.4×）下确认 mipmap 生效、无摩尔纹（SC-009）；截图输出到 `production/m18-shots/moire-*.png`

**Checkpoint**: HD 化的收益在放大显示下真正兑现。

---

## Phase 10: User Story 7 - 既有回归基线零回归 (Priority: P3)

**Goal**: 逻辑与玩法测试 100% 保持通过；渲染侧非资产套件与场景图冻结契约不被破坏；凡因资产结构替换而调整的断言都显式登记。

**Independent Test**: 运行完整测试套件，确认逻辑与玩法测试 100% 通过；确认场景图冻结契约与渲染侧非资产套件在未修改的前提下继续成立。

### Verification for User Story 7

- [x] T059 [US7] 运行五道闸门（`npm test` / `typecheck` / `typecheck:client` / `lint` / `build`），确认 **0 失败**且全部用例总数 **≥ 893**（SC-011）
- [x] T060 [US7] 用 `git diff` 逐条核对并确认**均未被修改**：`tests/render/tilemap_art.test.ts` 的 F1–F6 六条冻结契约断言 · 两个 lossless 套件 · **`tests/render/` 中不属于 `*_art` 的套件**（`camera_zoom_*.test.ts` / `interpolation.test.ts` / `renderer_bridge.test.ts` / `juice_*.test.ts`）—— FR-028 / SC-011
- [x] T061 [US7] 审查全部测试变更，逐条分类为「**结构断言**（已授权更新）」或「**契约断言**（MUST 保持原强度）」，把分类结果与理由写入 `production/m18-evidence.md`；确认**不存在未登记的放宽或删除**

**Checkpoint**: 回归基线可信 —— 通过是因为真的通过，而不是因为断言被削。

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事的收尾、独立评审、证据归档与治理更新。

- [x] T062 [P] 性能比值验收：约 150 敌人同屏（`?mode=stress`）下每帧耗时中位数「改动后 / 改动前」**比值 ≤ 1.2**（同机、同场景、同脚本、连续 3 次取中位数）；复用 `tests/performance/render_art_cost.test.ts` 的**交错比值**方法；记入 `production/m18-evidence.md`
- [x] T063 [P] 体积验收：构建产物实测 单文件 ≤3MB · 总量 ≤12MB · 单图集 ≤4096²（目标 ≤2048²）· 图集数 ≤12；记入 `production/m18-evidence.md`
- [x] T064 [P] 离线与降级验收：断网启动并走完「开局 → 战斗 → 清房 → 三选一 → 终局 → 营地 → 再开局」，确认外部请求数 = 0；再**人为损坏单个 HD 资产**，确认优雅降级、崩溃 0 次、黑屏 0 次（SC-007 / SC-012）
- [x] T065 [P] 变异实验（门控类改动必做）：对 `client/GameRenderer.ts`（autotile 选件、循环语义）与 `client/assets/AssetCatalog.ts`（纹理过滤分支）三处条件分支各做「临时破坏 → 确认预期断言**确实失败** → 从**备份**还原」；**MUST NOT 使用 `git checkout --`**；失败用例数与证据记入 `production/m18-evidence.md`
- [x] T066 [P] 更新 `README.md` 的资产管线说明（像素管线 → HD 管线），并更新规格索引中 M18 的条目
- [x] T067 **独立评审（宪法 Principle IV 强制环节）**：由**未参与实现**的一方（独立 QA 或另一名成员）按 `contracts/` 四份契约 + `spec.md` 的 16 条 SC **逐条**核对实现，出具 **PASS / CONCERNS / FAIL** 判定与具体阻塞项；评审证据写入 `production/m18-evidence.md`。**MUST NOT 由实现者自审替代**
- [ ] T068 修复 T067 独立评审提出的 CONCERNS / FAIL 项（若判定为 PASS 则空操作并记录）；修复后重跑五道闸门
- [x] T069 完整执行 `quickstart.md` 的 V1–V11 验收剧本，逐条勾选并把结果记入 `production/m18-evidence.md`
- [x] T070 更新 `.workbuddy-ai/memory/INVARIANTS.md`：新增 M18-T01 条目（硬契约、基准 tile、预算、场景图与管道的「未变」声明）
- [x] T071 登记主观判定：把 SC-001 / SC-002 / SC-009 等含主观成分的判定如实标注为 **PENDING（需 ≥1 名人类观察者）**，不得以机器结果冒充主观通过
- [ ] T072 提交（**须人工审批**）：docs 提交与 feat 提交分离；确认 `src/` 零改动、五道闸门全绿后再提交；默认**不 push**

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Phase 1 —— **阻塞全部用户故事**；且 T006/T007/T012/T013 **MUST 原子完成**（见该阶段说明）
- **User Stories (Phase 3–10)**: 均依赖 Phase 2 完成
  - US1 / US2 / US3 / US8 相互独立，可并行
  - **US4 依赖 US1 + US2 + US3 + US8**（没有全部改动就无法证明「改动后仍无损」）
  - **US5 依赖 US1 + US2 + US3 + US8**（全部世界美术就位后才能删除像素资产，否则构建断裂或删掉仍在服务的资产）
  - US6 依赖 US1（需要 HD 纹理才谈得上锐利）
  - US7 依赖全部前序故事
- **Polish (Phase 11)**: 依赖全部用户故事完成

### User Story Dependencies

| 故事 | 优先级 | 依赖 | 可独立验收？ |
|---|---|---|---|
| US1 玩家 HD | P1 | 仅 Phase 2 | ✅ 空房间内操作角色即可 |
| US2 敌人 HD | P1 | 仅 Phase 2 | ✅ 依次生成六类敌人即可 |
| US3 地牢 HD | P1 | 仅 Phase 2 | ✅ 加载任意房间即可 |
| US4 纯表现层 | P1 | US1 + US2 + US3 + US8 | ✅ 摘要对拍 + `git diff src/` |
| US5 移除像素资产 | P2 | US1 + US2 + US3 + US8 | ✅ 文件检索 + 构建 |
| US8 局内特效 HD | P2 | 仅 Phase 2 | ✅ 触发命中/冲刺/预警/拾取/击杀 |
| US6 放大锐利 | P2 | US1 | ✅ 多倍率截图 |
| US7 回归基线 | P3 | 全部 | ✅ 五道闸门 + 断言分类审查 |

> **P2 组内的阶段顺序**：US5 → US8 → US6。前两条是**产出类**故事（移除旧管线、补齐世界美术），第三条是**验证类**故事；把产出做完再验证，避免重复跑验收。

### Within Each User Story

- 测试 MUST 先写、先失败，再实现
- 图集产出（资产）→ 渲染接入（代码）→ 锚点/尺寸对齐
- 故事完成并通过验收后，才进入下一优先级

### Parallel Opportunities

- Phase 1 的 T003 / T005 可并行
- Phase 2 的 T010 / T011 可并行（T006/T007/T012/T013 为原子批，不可并行拆分）
- **US1 / US2 / US3 / US8 四条故事在 Phase 2 完成后可完全并行**（分别由不同开发者承担）
- 每个故事内标记 `[P]` 的多个测试任务可并行编写
- US2 的 T025 / T026 / T027 三批图集可并行产出
- US3 的 T029–T034 六组测试可并行
- Phase 11 的 T062–T066 五组验收可并行
- **T067 独立评审 MUST NOT 与实现任务并行**（需实现冻结后进行）

---

## Parallel Example: Phase 2 Foundational（原子批不可拆）

```bash
# 原子批：必须一起完成，否则门禁在 Phase 2–7 持续为红
Task: "T006 manifest 重指向 assets/art/hd/*"
Task: "T007 SHEET_DATA 显式关联 + fx.pickup.* + 同步登记"
Task: "T012 改写 licenses.test.ts（移除旧形态断言 + 新增上限断言）"
Task: "T013 manifest.test.ts 许可白名单"
```

## Parallel Example: 四条可并行故事

```bash
# Phase 2 完成后可同时启动：
Task: "T014–T021 [US1] 玩家 HD 动画"
Task: "T022–T028 [US2] 敌人 HD 动画"
Task: "T029–T037 [US3] HD 地牢 Tilemap"
Task: "T050–T054 [US8] 局内特效与掉落物 HD 化"
```

## Parallel Example: User Story 2

```bash
# 三批敌人图集可并行产出（不同文件）：
Task: "T025 [P] [US2] enemy-grunt + enemy-bomber 图集"
Task: "T026 [P] [US2] enemy-raider + enemy-gunner 图集"
Task: "T027 [P] [US2] enemy-elite + enemy-unknown 图集"
```

---

## Implementation Strategy

### MVP First（US1 一条故事）

1. 完成 Phase 1（Setup）
2. 完成 Phase 2（Foundational —— **阻塞全部故事**，且 T006/T007/T012/T013 必须原子完成）
3. 完成 Phase 3（US1 玩家 HD 动画）
4. **STOP and VALIDATE**：独立验收 US1（空房间操作角色）
5. 此时已有可演示的 MVP

> **强烈建议的先行切片（`research.md` R1 缓解）**：在 US1 内先只做**「玩家 + 1 类敌人 + 环境」的垂直切片**打通全管线并验收，再批量补齐其余敌人 —— 因为高清 4 向多动作的 CC0 素材**极稀缺**，最大风险是素材而非代码。

### Incremental Delivery

1. Setup + Foundational → 基础就位（门禁仍全绿）
2. US1 → 独立验收 → **MVP**
3. US2 → 独立验收
4. US3 → 独立验收（三条 P1 齐备）
5. US4 → 无损证据（硬约束闭环）
6. US5 → 仓库洁净
7. US8 → 局内特效补齐（FR-030 四要素齐备）
8. US6 → 锐利度证据
9. US7 → 回归基线可信
10. Polish → **独立评审** + 证据归档 + 提交

### Parallel Team Strategy

- 4 名开发者：一人 US1、一人 US2、一人 US3、一人 US8（Phase 2 完成后同时开工）
- 第 5 人可专职产出美术资产（T019 / T025–T027 / T035 / T052），与代码接入解耦
- US4 / US5 / US6 在 P1 故事完成后由 1 人串行收口
- **独立评审（T067）MUST 由未参与实现的第 6 方或外部评审承担**

---

## Notes

- `[P]` = 不同文件、无未完成依赖
- **测试先写、先失败**（宪法 Principle IV）
- **流程 MUST 含独立评审**（T067）—— 实现者自审不算独立评审
- **契约断言 MUST NOT 放宽**：只读性、确定性、降级回几何、场景图 F1–F6、渲染侧非资产套件（`camera_zoom_*` / `interpolation` / `renderer_bridge` / `juice_*`）、无专有资产、17 段管道 —— 这些是本特性的「不许碰」清单
- 每个任务或逻辑组完成后提交；**提交须人工审批**，默认不 push
- 在任一 Checkpoint 停下即可独立验收该故事
- 避免：模糊任务、同文件冲突、破坏独立性的跨故事依赖

---

## 实现后记（2026-10-03 · `/speckit.implement` 执行结果）

**状态**：68 / 72 任务完成。**948 例全绿**（基线 893 ⇒ +55）；摘要 `f52dfdd4` **逐位不变**；
性能比值中位数 **0.970**；五道闸门全绿；`src/` 零改动、管道仍 17 段、无新增运行时依赖。
完整证据见 `production/m18-evidence.md`，不变量见 `.workbuddy-ai/memory/INVARIANTS.md` 的 M18-T01 段。

**未勾选的 4 条，及其原因**：

| 任务 | 状态 | 原因 |
|---|---|---|
| **T049** | **延后（非本里程碑可完成）** | 前提是「真实 HD 美术已就位」。当前**没有**真实 HD 美术，占位图集**就是**本里程碑交付的 HD 资产，其可复现来源即 `production/m18-placeholder-atlases.mjs` ⇒ 两者保留。已在 `assets/art/LICENSES.md` §2 与 `assets/art/hd/README.md` 如实登记为「本仓库原创 · 程序化生成」。真实美术到位后执行。**见证据 §14 L1。** |
| **T067** | **已执行** | 独立评审由未参与实现的一方（独立 agent，无实现上下文）按 4 份契约 + 16 条 SC 逐条核对，自行 `git diff` 并运行五道闸门。**判定 = CONCERNS**（4 条阻塞项 + 4 条强度发现）。结论与逐条处置见证据 §13。 |
| **T068** | **部分完成，2 项升级为产品决策** | 4 条阻塞项中 **2 条已修**（B2 证据文档缺失 = 评审时序陈旧，现已落盘；B4 注释不准确 = 已改为「仅 `meta.app` 一个字段不同」）；**2 条如实保留为 OPEN**：**B1 占位美术 vs 真实美术**（需产品决策，见证据 §14 L1）、**B3 伤害数字未 HD 化**（FR-028 与 T053 的规格内冲突，已登记 DEV-1）。强度发现 S1（剪影元数据未与像素交叉校验）与 S2（`isTransparent` 越界空转）**均已修复**。评审后五道闸门已复跑（948 全绿）。 |
| **T072** | **待人工审批** | 提交属高影响动作，按 SOP 须人工审批；默认**不 push**。 |

**已登记的偏离（详见 `production/m18-evidence.md` §12）**：

- **DEV-1** T053 的「伤害数字改用 HD 帧」**未按字面实现** —— 冻结的 `tests/render/juice-verify.test.ts`
  （**不在**授权更新集内，FR-028）断言浮动数字是 `Text` 且 `.text === '-10'`。FR-028 优先于任务措辞，
  且契约 §2 本身允许「`fx.damage-font`（**或等价**）」⇒ 取等价分支（保留 `Text`，样式改 HD 调色板 + 描边），
  **不新增**无消费者的图集。
- **DEV-2** `ANIM_FRAME_MS.death` 由 `150` 改为 **`45` ms** —— 死亡剪辑必须能在 `DEATH_FADE_MS = 400 ms`
  的 FX 窗口内走完，否则 D13 / T015 的「停在末帧」物理上不可达（8×150 = 1200 ms > 400 ms）。
  同时把死亡剪辑的推进移出 `isDying` 短路，使剪辑真正播放。
- **DEV-3** 见上表 T049。
- **DEV-4** `atlas/ui.{png,json}` **字节未变**迁移到 `assets/art/ui/icons.{png,json}`，`ui.icon.*` 随之改指 ——
  这样 `assets/art/atlas/**` 才能被完整删除（T044）而**不删任何 id**（无需放宽「资产集合覆盖」断言）。
- **DEV-5** **Phase 2 的 checkpoint 无法独立达成**：T009 把 `TILE_NATURAL_PX` 16→128，**按构造**就会打破
  `tests/render/player_art.test.ts` 的缩放字面量（0.625 = 10/16），而修复它的 T014 属 US1。故 Phase 2
  的绿灯只能与 US1/US2/US3/US8 的测试更新**同批**达成（I1 真正要防的「`tests/assets/*` 长期为红」已由
  把 T012/T013 并入 Phase 2 原子批避免）。
- **DEV-6** `SHEET_DATA.animations` 声明为 `Record<string, string[]>` 而非契约 §2 片段的 `readonly string[]` ——
  同一契约的 **C1** 要求该接口**无需 cast** 即可赋值给 PixiJS `SpritesheetData`（其 `animations` 为 `Dict<string[]>`），
  二者不可兼得，取 C1 并在代码注释中说明。

**主观判定登记（PENDING，需 ≥1 名人类观察者）**：SC-001 · SC-002 · SC-009 · SC-016 的「清晰 / 可区分 /
无锯齿 / 不混淆」含人类观察成分；其**客观部分**已机器判定并记录（meanRun 2.06–3.36 px、颜色数 2311–12579、
六类剪影两两可区分且**由 PNG 像素重算验证**、仅危险环为空心），**不以机器结果冒充主观通过**。

**⚠️ 需要用户拍板的两项（不擅自闭合）**：

1. **B1 · 占位美术 vs 真实美术**：本里程碑交付的是**程序化占位 HD 美术**（结构完整、质量占位级）。
   是否接受「完整管线 + 占位美术」作为 M18 的交付边界？若不接受，需先取得真实 HD 素材
   （`research.md` R1 已列为最高风险：高清 4 向多动作 CC0 素材极稀缺）再执行 T049。见证据 §14 L1。
2. **B3 · 伤害数字未 HD 化**：这是 `FR-028`（冻结套件零改动）与 `T053`（伤害数字改用 HD 帧）之间的
   **规格内真实冲突**。当前按「FR-028 优先 + 契约允许『或等价』」处置并登记。若要真正满足，
   需先修订 FR-028 或显式豁免 `tests/render/juice-verify.test.ts`。见证据 §12 DEV-1 / §14 L2。

