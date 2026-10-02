---
description: "Task list for 真实 2D 美术与音效资产接入"
---

# Tasks: 真实 2D 美术与音效资产接入

**Input**: Design documents from `/specs/024-real-art-assets/`

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required for user stories), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: **包含**。项目宪法 Principle IV（测试先行与证据化验证，NON-NEGOTIABLE）强制要求：新增/变更行为 MUST 遵循「冻结规格 → 写失败测试 → 实现」。因此每个用户故事阶段都含测试任务，且测试 MUST 先写并**确认失败**再实现。

**Organization**: 任务按用户故事分组，每个故事可独立实现、独立测试、独立交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1…US6）
- 每条任务含确切文件路径

## Path Conventions

本项目为**单仓库前端**（headless 逻辑内核 + 表现层）：

- 逻辑内核 `src/`（**本特性零改动**）
- 表现层 `client/`（含新增 `client/assets/`）
- 界面标记与样式 `index.html`
- 资产 `assets/art/`、`assets/audio/`
- 测试 `tests/`（沿用既有 `tests/render/`、`tests/audio/` 等分区；新增 `tests/assets/`）

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 资产落盘、裁剪、图集化与许可登记。这是后续一切工作的物质前提。

- [x] T001 创建资产目录与许可骨架：`assets/art/`、`assets/art/atlas/`、`assets/art/raw/`、`assets/audio/`、`assets/audio/sfx/`、`assets/audio/raw/`，并初始化空文件 `assets/art/LICENSES.md` 与 `assets/audio/LICENSES.md`（表头：assetId / packName / author / sourceUrl / license / modifications）
- [x] T002 [P] 下载 Kenney **CC0** 美术包到 `assets/art/raw/`：Roguelike/RPG pack、Roguelike Character pack、Pixel UI pack、Particle Pack（来源见 [research.md](./research.md) D1）
- [x] T003 [P] 下载 Kenney **CC0** 音效包到 `assets/audio/raw/`：50 RPG sound effects、63 Digital sound effects、51 UI sound effects
- [x] T004 裁剪并打包图集为 `assets/art/atlas/{player,enemies,tiles,fx,ui}.png` + 同名 `.json`（PixiJS 兼容 spritesheet；若 TexturePacker 不可得则手写 JSON——**不得引入运行时依赖**）
- [x] T005 填写 `assets/art/LICENSES.md` 与 `assets/audio/LICENSES.md`：逐项记录 packName / author / sourceUrl / `CC0-1.0` / modifications，确保清单中每个 id 可反查（FR-020、SC-010）
- [x] T006 [P] 从音效包中挑选并导出约 8–12 条音效到 `assets/audio/sfx/`：`hit` / `dash` / `coin` / `enemy-death` / `hazard-blast` / `ui-click` / `reward-select` / `death` / `win`（文件名即 `sfx.<name>` 的 `<name>`）

**Checkpoint**: 资产就位、许可可追溯、图集可被 PixiJS 解析。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 表现层的资产接入层。**所有用户故事都依赖它**，必须整体完成后再开始故事实现。

**⚠️ CRITICAL**: 本阶段完成前，任何用户故事都不得开始。

- [x] T007 创建资产清单 `client/assets/manifest.ts`：按 [contracts/asset-manifest.md](./contracts/asset-manifest.md) §1 定义 `AssetEntry`（`id` / `kind` / `source` / `license` / `fallback`），经 Vite 静态导入引用 `assets/art/**` 与 `assets/audio/**`，导出只读 `MANIFEST`。id 命名空间严格按 §2（`player.` / `enemy.` / `tile.` / `fx.` / `ui.` / `sfx.`）
- [x] T008 创建资产加载器 `client/assets/AssetCatalog.ts`：`Assets.load` 加载图集与音频；**逐条目** try/catch，失败 ⇒ 该条目进入 `degraded` 终态并回退到 `fallback`（`graphics` / `silent`），其余条目不受影响；暴露 `get(id)` / `isDegraded(id)`（[contracts/asset-manifest.md](./contracts/asset-manifest.md) §3 承诺 3、4）
- [x] T009 [P] 创建映射纯函数 `client/assets/sprite-map.ts`：`facingFromRadians(radians): Facing4`（对 `±PI` 接缝稳定）、`animationFromState(state: ActionState): AnimationState`（**总函数**，未知 ⇒ `idle`）、`enemyTypeFromSignature(world, id): EnemyType`（按 [contracts/renderer-asset-mapping.md](./contracts/renderer-asset-mapping.md) §4 冻结表，优先级 1→6）、`spriteIdFor(...)`。**不依赖 DOM、不 import pixi.js**
- [x] T010 [P] 写 `tests/assets/sprite-map.test.ts`：断言 (a) 用 `spawnCombatant` 生成 5 类敌人逐一分类正确（5/5）；(b) `spawnElite(world,'grunt')` ⇒ `elite`；(c) 未知签名 ⇒ 兜底且**不抛错**；(d) `facingFromRadians` 在 `±PI` 附近不抖动；(e) `animationFromState` 对全部 `ActionState` 有定义。**先确认失败再实现 T009**
- [x] T011 [P] 写 `tests/assets/manifest.test.ts`：断言 (a) `id` 全局唯一；(b) `kind==='audio'` ⇒ `fallback==='silent'`；(c) 每个 id 能在 `LICENSES.md` 反查到；(d) `license` ∈ {`CC0-1.0`,`public-domain`}，出现 `proprietary`/未知 ⇒ 测试失败（[contracts/asset-manifest.md](./contracts/asset-manifest.md) §4）
- [x] T012 在 `client/main.ts` 的 boot 流程中于 `new Application()` **之后**、首次 `runSetup` **之前** `await catalog.load()`；加载失败 MUST NOT 阻塞启动（降级后继续），并在控制台报告降级条目

**Checkpoint**: 接入层就绪 —— 任何用户故事现在都可以开始（可并行）。

---

## Phase 3: User Story 1 - 玩家角色以带动画的人物形象出现 (Priority: P1) 🎯 MVP

**Goal**: 玩家不再是圆点 + 朝向线，而是带动画、朝向正确、动作状态可辨的人物形象。

**Independent Test**: 空房间中操作角色，验证待机/移动/冲刺/攻击/受击/死亡各有可辨识表现，朝向始终与移动方向一致。

### Tests for User Story 1 ⚠️

> **NOTE: 先写测试并确认失败，再实现**

- [x] T013 [P] [US1] 写 `tests/render/player_art.test.ts`：(a) 玩家视图存在且为 `AnimatedSprite`（鸭子类型断言，沿用既有 node 渲染套件模式）；(b) `IDLE`→`idle`、`MOVING`→`move`、`DASHING`→`dash` 的动画选择钉桩；(c) 四向朝向钉桩；(d) 图集不可用时回退 `Graphics` 且视图仍存在

### Implementation for User Story 1

- [x] T014 [US1] 在 `client/GameRenderer.ts` 的 `createPlayerView` 中改为按 `player.base` 取 `AnimatedSprite`，替换圆点 + 朝向线；**保留**原 `Graphics` 分支作为 `fallback`（FR-001、FR-013）
- [x] T015 [US1] 在 `client/GameRenderer.ts` 新增玩家动画同步（在既有 `syncTransforms` 路径内或紧邻）：按 `sprite-map` 选动画与朝向，动画播放用**真实帧 delta**（与既有 `advanceFloatingTexts` 同模式），MUST NOT 读逻辑 tick、MUST NOT 回写 `World`（FR-002/003/004、宪法 II）
- [x] T016 [US1] 在 `client/GameRenderer.ts` 中把既有 `HIT_FLASH_TINT` 与死亡 FX（`DEATH_FADE_MS` / `DEATH_SHRINK`）接到 `AnimatedSprite` 上，保证受击闪烁与死亡淡出/缩小不回归

**Checkpoint**: US1 可独立演示 —— 玩家形象与动画完整，且 `tests/render/` 既有套件全绿。

---

## Phase 4: User Story 2 - 敌人以可区分的怪物形象出现 (Priority: P1)

**Goal**: 5 类敌人各有专属、形态可区分的形象（去色仍可辨），朝向与死亡表现正常。

**Independent Test**: 依次生成 5 类敌人（含精英），验证形象专属且可区分；`tests/render/` 既有套件全绿。

### Tests for User Story 2 ⚠️

- [x] T017 [P] [US2] 写 `tests/render/enemy_art.test.ts`：(a) 5 类敌人各自的 `spriteId` 钉桩（字面量）；(b) 精英变体 ⇒ `enemy.elite`；(c) 未知签名 ⇒ 通用形象且不抛错；(d) 敌人朝向跟随；(e) 死亡动画触发（配合 `isDead`）

### Implementation for User Story 2

- [x] T018 [US2] 在 `client/GameRenderer.ts` 的 `createEnemyView` 中接入 `sprite-map.enemyTypeFromSignature`，按类型取 `AnimatedSprite`；`enemyType` **只在视图创建时计算一次**（能力组件运行期不增删，data-model E3）
- [x] T019 [US2] 在 `client/GameRenderer.ts` 中按 `HurtboxComponent.radius` 缩放敌人精灵，使视觉体型与既有碰撞半径一致；保留 `addHurtboxOutline`
- [x] T020 [US2] 保留 `createEnemyView` 的原 `Graphics` 方块分支作为 `fallback`（FR-013）

**Checkpoint**: US1 + US2 均可独立工作；敌人混战时仅凭形象即可分类（SC-002）。

---

## Phase 5: User Story 3 - 房间墙体与地面呈现为连贯的场景纹理 (Priority: P2)

**Goal**: 墙体与地面呈现为连贯 Tilemap 场景纹理，且视觉边界与碰撞几何完全一致。

**Independent Test**: 加载三种尺寸房间，验证纹理按尺寸铺设、无拉伸错位，且 `tests/render/` 全套（含 F1–F6）一行不改全绿。

### Tests for User Story 3 ⚠️

- [x] T021 [P] [US3] 写 `tests/render/tilemap_art.test.ts`：(a) 有墙时 `camera.children[0]` 仍是静态层且含瓦片节点；(b) **F1–F6 逐条断言**（`stage.children` 长 1；`camera.children[last]` = root；`root.children[last]` = fxLayer；`root.children[0]` = 首个实体视图；**无墙时 `camera.children` 长恰 1**；空闲时 `fxLayer.children` 长恰 0）；(c) 房间切换后瓦片重建、无残留

### Implementation for User Story 3

- [x] T022 [US3] 改造 `client/GameRenderer.ts` 的 `syncStaticGeometry` / `syncFloor` / `ensureStaticLayer`：把「地板矩形 + 墙矩形」替换为**瓦片精灵**，**沿用既有 `staticLayer` 节点与位置**（有墙时 `camera.children[0]`），MUST NOT 新增常驻节点（[contracts/renderer-asset-mapping.md](./contracts/renderer-asset-mapping.md) 承诺 7）
- [x] T023 [US3] 在 `client/GameRenderer.ts` 中按房间实际网格尺寸铺设瓦片（10×10 / 12×10 / 30×30），墙格用 `tile.wall`、可通行格用 `tile.floor`，MUST NOT 拉伸（FR-009）
- [x] T024 [US3] 在 `client/GameRenderer.ts` 中保持 `teardownStaticLayer` / `floorSignature` 的重建语义：房间变化时重建一次瓦片，**MUST NOT 每帧重建**（性能，D9）；瓦片不可用时回退既有色块

**Checkpoint**: 场景纹理完整，F1–F6 与既有渲染套件全部不变。

---

## Phase 6: User Story 4 - 打击、冲刺与拾取使用真实音效 (Priority: P2)

**Goal**: 命中/冲刺/拾取等事件播放真实音效资产，且与画面同步。

**Independent Test**: 触发命中/冲刺/拾取/UI 点击，确认播放真实音效且与画面同步；音频不可用时静默无报错。

### Tests for User Story 4 ⚠️

- [x] T025 [P] [US4] 写 `tests/audio/audio_assets.test.ts`：(a) 无 `window`/无 `Howl` ⇒ `isAvailable === false` 且每个方法 no-op、不抛（沿用既有静默降级契约）；(b) 事件 → `sfx.*` 映射钉桩；(c) `GameLoop` 新构造参数**可选**：`new GameLoop(sim, renderer, input)` 行为逐位不变

### Implementation for User Story 4

- [x] T026 [US4] 改造 `client/AudioManager.ts`：把 `synthHit/synthDash/synthCoin` 的 `data:` URI 换成经 `AssetCatalog` 取得的真实音效 URL（仍用 `Howl`）；保留 try/catch 构造与 `isAvailable` 静默降级；**howler 仍只被本文件 import**（D8、宪法 V）
- [x] T027 [US4] 在 `client/AudioManager.ts` 中按 Q2=C 加性扩展事件：`playEnemyDeath` / `playHazardBlast` / `playUiClick` / `playRewardSelect` / `playDeath` / `playWin`
- [x] T028 [US4] 在 `client/GameLoop.ts` 的 `AudioSink` 接口中**尾部追加**可选方法并在事件扇出处调用；构造参数保持**加性可选**（既有三参调用行为不变）
- [x] T029 [US4] 在 `client/main.ts` 装配新音效：UI 按钮点击、奖励选择、终局（死亡/胜利）等由既有回调点触发（纯观察，不新增逻辑耦合）

**Checkpoint**: 音效全部为真实资产，静默降级与导入图隔离不变。

---

## Phase 7: User Story 5 - 资产全部本地化，缺失时优雅降级 (Priority: P3)

**Goal**: 全资产本地分发、离线可用；任一资产缺失/损坏时局部降级、不崩溃。

**Independent Test**: 离线打开页面全部可用且零外部请求；损坏单个资产后游戏仍可玩。

### Tests for User Story 5 ⚠️

- [x] T030 [P] [US5] 写 `tests/assets/degradation.test.ts`：(a) 清单中每个 `source` 都是本地构建产物路径（无 `http`/`https` 前缀）；(b) 注入一个加载失败的条目 ⇒ 只有该条目 `isDegraded === true`，其余仍 `ready`；(c) 降级后相关视图仍存在（回退生效）
- [x] T031 [P] [US5] 写 `tests/assets/licenses.test.ts`：断言 100% 资产可追溯到 `LICENSES.md`，且不含任何 `proprietary`/未知许可、不含 Supergiant Games 资产（SC-010）

### Implementation for User Story 5

- [x] T032 [US5] 补齐 `client/assets/AssetCatalog.ts` 的降级路径：确保 `graphics` 回退在 `GameRenderer` 全部视图类型（player/enemy/pickup/hazard/tile/fx）上可达，`silent` 回退在音频上可达（FR-013、SC-007）
- [x] T033 [US5] 在 `client/main.ts` 中把资产加载失败降级为**非阻塞**并输出可诊断信息（哪个 id 降级、原因），保证启动流程不因单点失败而中断

**Checkpoint**: 离线与降级验收（quickstart §6）全部通过。

---

## Phase 8: User Story 6 - 全部屏上元素与界面统一到同一美术风格 (Priority: P3)

**Goal**: 掉落物、危险预警、命中火花、冲刺拖尾、伤害数字，以及 HUD / 三选一 / 死亡 / 胜利 / 营地界面全部风格化，无任何占位几何或默认控件。

**Independent Test**: 完整走「开局 → 战斗 → 拾取/受伤 → 清房 → 三选一 → 通关/死亡 → 营地 → 再开局」，全程找不到占位几何或默认控件。

### Tests for User Story 6 ⚠️

- [x] T034 [P] [US6] 写 `tests/render/fx_art.test.ts`：(a) 火花/拖尾取自 `fx.*` 图集；(b) 危险预警的**进度仍由 `HazardComponent.delayTicks / totalDelayTicks` 驱动**（逻辑不变）；(c) 掉落物三类 `kind` → 三个不同 `ui.icon.*`；(d) 去色后三类图标仍两两可区分（FR-017）
- [x] T035 [P] [US6] 写 `tests/ui/ui_skin.test.ts`：断言 `index.html` 中既有类钩子（`is-visible`/`is-death`/`is-win`/`is-hub`/`reward-button`/`talent-button`/`start-button`/`hub-currency`/`hub-talents`/`death-hint`）**全部保留**（[contracts/ui-asset-slots.md](./contracts/ui-asset-slots.md) 承诺 2）

### Implementation for User Story 6

- [x] T036 [US6] 改造 `client/VFXManager.ts`：火花与冲刺拖尾改用 `fx.spark` / `fx.dash-trail` 图集精灵，保留既有粒子生命周期与**惰性挂载**语义（不新增常驻节点，D6）；图集不可用时回退既有绘制
- [x] T037 [US6] 在 `client/GameRenderer.ts` 的 `createPickupView` 中把三类掉落物换成 `ui.icon.gold` / `ui.icon.heal` / `ui.icon.darkness`；`createHazardView` 换成 `fx.hazard-ring`（进度动画不变）；均保留 `Graphics` 回退
- [x] T038 [US6] 重写 `index.html` 的 `<style>`：为 HUD / 三选一 / 死亡 / 胜利 / 营地各面加美术面板与图标（`ui.panel.*` / `ui.overlay.*` / `ui.button.primary` / `ui.frame.*`），按钮 MUST 保持原生 `<button>` 可聚焦语义
- [x] T039 [US6] 在 `client/UIManager.ts` 中**仅**新增/调整 `className` 钩子以对接新皮肤；MUST NOT 改动任何 `sync` / `render*` / `clear*` 分支与判断（[contracts/ui-asset-slots.md](./contracts/ui-asset-slots.md) 承诺 1）
- [x] T040 [US6] 落实 FR-019（中文文字可读性）：确认 `index.html` 与 `client/UIManager.ts` 的文字**不依赖任何打包的 webfont**，字体栈 MUST 含 CJK 回退（`system-ui` / `PingFang SC` / `Microsoft YaHei` / `sans-serif`）；写 `tests/ui/text_readability.test.ts` 断言样式表中不存在指向字体文件的 `@font-face`（可选的拉丁显示字体除外），保证字体资产缺失时中文仍清晰可读、无乱码或方块
- [x] T041 [US6] 落实 FR-021（风格一致性评审）：逐元素（玩家 / 5 类敌人 / 瓦片 / 特效 / 图标 / 界面）核对所用素材包来源，确认全部同属「希腊神话 · 俯视动作肉鸽」一套视觉语言、无跨风格拼接；评审结论写入 `assets/art/LICENSES.md` 末尾的「风格一致性」小节

**Checkpoint**: 全流程无占位残留（SC-009），且中文可读与风格统一均已举证。

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事的收口、合规自证与验收。

- [x] T042 [P] 运行五道闸门并全部转绿：`npm test` · `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build`
- [x] T043 [P] 合规自证：`git diff --stat src/` **空输出**；`grep -rl "'TransformSnapshotSystem'" tests/ | wc -l` == **9**；管道仍 **17 段**（FR-014/015、宪法 III/VI）
- [x] T044 [P] 无损自证：同 seed 跑同一 601-Tick 脚本，改动前后**快照摘要逐位相同**、实体数相同（宪法 IV、SC-004）
- [x] T045 [P] 性能验收：`?mode=stress`（30×30 房间 + 约 150 敌）下，表现层每帧耗时中位数的**改动后 / 改动前比值 ≤ 1.2**；判定 MUST 用比值，MUST NOT 用绝对墙钟（FR-016、SC-006）
- [x] T046 [P] 冻结契约验收：`npm test -- tests/render/` 全套一行不改、全绿（F1–F6）
- [x] T047 [P] 资产体积与许可审查：总量 ≤ **6 MB**、单文件 ≤ **1 MB**（SC-011）；`assets/**/LICENSES.md` 逐项可追溯、零专有资产（SC-010）
- [x] T048 按 [quickstart.md](./quickstart.md) §4 逐条执行视觉验收 V1–V9 与 §6 离线降级 O1–O4，记录结果
- [x] T049 [P] 更新 `README.md`：新增「美术与音效资产」小节（来源、许可、体积、如何替换/扩展）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Setup（清单要引用真实文件）—— **阻塞所有用户故事**
- **User Stories (Phase 3–8)**: 均依赖 Foundational；彼此**相互独立**，可并行（若人力允许）或按优先级串行
- **Polish (Phase 9)**: 依赖全部所需用户故事完成

### User Story Dependencies

- **US1 (P1)**: Foundational 后可开始，无跨故事依赖 —— **MVP**
- **US2 (P1)**: Foundational 后可开始；复用 US1 建立的动画同步路径（**接口复用，非阻塞**）
- **US3 (P2)**: 独立；只触碰静态层
- **US4 (P2)**: 独立；只触碰音频链
- **US5 (P3)**: 依赖 Foundational 的 `AssetCatalog`；与 US1/US2/US3/US6 的回退路径**交叉验证**
- **US6 (P3)**: 独立于 US1–US4；触碰 VFX 与 DOM 界面

### Within Each User Story

- 测试 MUST 先写并**确认失败**，再实现（宪法 IV）
- 映射/纯函数 → 视图实现 → 集成接线
- 每个故事完成后再进入下一个优先级

### Parallel Opportunities

- Setup：T002 / T003 / T006 可并行；T004 依赖 T002，T005 依赖 T002+T003+T004
- Foundational：T009 / T010 / T011 可并行（不同文件）；T007 → T008 → T012 串行
- 各故事的**测试任务**（T013 / T017 / T021 / T025 / T030+T031 / T034+T035）可并行
- 各故事的**实现任务**跨故事可并行（不同文件；注意 US1/US2/US3/US6 都会改 `client/GameRenderer.ts` ⇒ 同一文件的改动**不可并行**，需串行或由同一人负责）

---

## Parallel Example: Foundational 阶段

```bash
# 三个不同文件的测试/纯函数可同时开工：
Task: "T009 [P] 创建映射纯函数 client/assets/sprite-map.ts"
Task: "T010 [P] 写 tests/assets/sprite-map.test.ts"
Task: "T011 [P] 写 tests/assets/manifest.test.ts"
```

## Parallel Example: 用户故事测试

```bash
# Foundational 完成后，各故事的测试可同时写：
Task: "T013 [P] [US1] 写 tests/render/player_art.test.ts"
Task: "T017 [P] [US2] 写 tests/render/enemy_art.test.ts"
Task: "T021 [P] [US3] 写 tests/render/tilemap_art.test.ts"
Task: "T025 [P] [US4] 写 tests/audio/audio_assets.test.ts"
```

---

## Implementation Strategy

### MVP First（仅 US1）

1. Phase 1 Setup → 2. Phase 2 Foundational（**关键，阻塞全部**） → 3. Phase 3 US1 → 4. **停下验证**：`tests/render/` 全绿 + 浏览器中玩家形象与动画正确 → 5. 可演示。

### Incremental Delivery

1. Setup + Foundational ⇒ 接入层就绪
2. +US1 ⇒ 验证 ⇒ 交付（MVP）
3. +US2 ⇒ 验证 ⇒ 交付
4. +US3 ⇒ +US4 ⇒ 各自验证交付
5. +US5 ⇒ +US6 ⇒ 全量覆盖达成（SC-009）
6. Polish ⇒ 五道闸门 + 自证 + 验收

### 关键风险与纪律

- **`client/GameRenderer.ts` 是热点文件**：US1/US2/US3/US6 都改它 ⇒ 这四个故事**不可并行**，且每次改动后必须复跑 `tests/render/` 全套以证明 F1–F6 未破。
- **`src/` 只读**：任何任务都不得产生 `src/` 的 diff。敌人类型识别**只能**走 `sprite-map.ts` 的能力签名分类器（[contracts/renderer-asset-mapping.md](./contracts/renderer-asset-mapping.md) §4），**严禁**为渲染在 `src/` 加类型标签。
- **禁新增常驻场景节点**：场景纹理必须替换 `staticLayer` 内容（D6）。
- **`howler` 导入图隔离**：只有 `client/AudioManager.ts` 可 import howler；否则无 DOM 的 `typecheck` 会报 TS2304。

---

## Notes

- [P] = 不同文件、无依赖
- [Story] 标签用于追溯任务 → 用户故事
- 每个用户故事应可独立完成与测试
- 实现前先确认测试**失败**
- 每个任务或逻辑组后提交（**默认不 commit，需人工审批**——见宪法 Governance）
- 避免：模糊任务、同文件冲突、破坏独立性的跨故事依赖
