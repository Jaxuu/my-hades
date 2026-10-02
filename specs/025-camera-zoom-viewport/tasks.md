# Tasks: 相机缩放与视口自适应（M17）

> ## ✅ 状态：**全部 33 个任务已执行完毕**（2026-10-02）
>
> | 项 | 结果 |
> |---|---|
> | 五道闸门 | ✅ 全绿 |
> | 测试 | ✅ **893 passed / 58 files**（基线 803 + 新增 **90**），失败 0、跳过 0 |
> | `git diff --stat src/` | ✅ 空（逻辑内核零改动） |
> | `git status --porcelain tests/` | ✅ 只有 **8 个新增文件**，既有测试零改动 |
> | 管道 | ✅ 仍 **17 段**（钉桩实测 **13** 处，与基线一致） |
> | 场景图 F1–F6 | ✅ 逐条不变 |
> | 真浏览器像素实测 | ✅ 5 种视口房间短边占比**恒 80.0%**、居中到像素、零裁剪 |
> | SC-007 性能比值 | ✅ 中位数 **0.993**（预算 1.2） |
>
> **证据**：[`production/m17-baseline.md`](../../production/m17-baseline.md) · [`production/m17-evidence.md`](../../production/m17-evidence.md) · [`production/m17-shots/`](../../production/m17-shots/)
>
> **⚠️ 两处超出 `client/` 的改动已显式登记**：
> ① `vitest.config.ts` 新增 `poolOptions.threads.maxThreads`（限制 worker 池并发）——新增测试的 CPU 争用曾使
> 既有 `stress.test.ts` G2 失败 4/5，限流后**连跑 6 次全绿**；**未改动任何断言**。详见证据 §1.1 / §14-R1。
> ② `eslint.config.mjs` 的 `ignores` 精确加入 `production/**/*.mjs`（浏览器验收工具是 Node 侧脚本）。
>
> **⚠️ 两项主观判定仍 PENDING（需 ≥1 名人类观察者）**：SC-002「房间大小合适、内容清晰可读」与
> SC-009「缩放与震动互不干扰」——客观部分均已机器判定，见证据文件 §4 / §10 / §14-R2。详见 T019 / T031 的行内注记。
>
> **⚠️ 未提交**：按 §Notes，本阶段不 commit；提交须经人工审批。

**Input**: Design documents from `/specs/025-camera-zoom-viewport/`

**Prerequisites**: [plan.md](./plan.md) · [spec.md](./spec.md) · [research.md](./research.md) · [data-model.md](./data-model.md) · [contracts/](./contracts/) · [quickstart.md](./quickstart.md)

**Tests**: **必需，非可选。** 本项目宪法 Principle IV 强制「冻结规格 → 写失败测试 → 实现 → 独立评审 → 修复」；且 `FR-017` / `SC-006` 要求既有 803 用例**零改动**全绿，新增行为必须有可执行的证据。故每个用户故事阶段都以「写失败测试」开头。

**Organization**: 按用户故事分阶段，使每个故事可独立实现、独立测试、独立交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行执行（**不同文件**、无未完成依赖）
- **[Story]**: 所属用户故事（US1–US5）
- ⚠️ **`client/GameRenderer.ts` 是本特性的单点热点**：凡改动该文件的任务**一律不加 `[P]`**，必须串行。

## Path Conventions

单仓库 Web 前端（headless 内核 + 表现层）：

- `src/` —— 逻辑内核。**本特性 MUST NOT 改动任何一行**（`git diff --stat src/` 必须为空）。
- `client/` —— 表现层（pixi.js 8）。本特性全部改动落在此。
- `tests/render/` · `tests/harness/` —— 新增断言的落点；既有测试文件**零改动**。

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 冻结基线证据 + 确认构建/类型检查路径可用。本仓库是成熟项目，无工程初始化工作。

- [X] T001 记录改动前基线证据：依次跑 `npm test`（期望 **803 passed / 50 files**）、`npm run typecheck`、`npm run typecheck:client`、`npm run lint`、`npm run build`；并确认 `git diff --stat src/ client/ tests/` **为空**。把命令与输出摘要记入 `production/m17-baseline.md`
- [X] T002 [P] 确认表现层工具链在当前工作树可用：`npm run typecheck:client` 与 `npm run build` 通过（无需任何改动，仅证明基线可构建）

**Checkpoint**: 基线可复现，零回归判据已落盘。

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: 全部用户故事共用的**只读输入读取**与**纯函数**：视口读取、房间范围派生、缩放计算、取景模式判定。这四件事是 US1–US5 的共同前提。

**⚠️ CRITICAL**: 本阶段完成前，任何用户故事都不得开始。

- [X] T003 [P] 写**失败**测试 `tests/render/camera_zoom_fit.test.ts`，覆盖契约 [zoom-fit-and-degradation.md](./contracts/zoom-fit-and-degradation.md) §1（输入全部只读）、§2（公式）、§3（退化谓词与取景模式判定）：`renderer.viewport` 在 `app.screen === undefined` 的鸭子类型替身下 `readable === false`；`renderer.roomExtent` 对「有墙 / 无墙 / 营地」三态分别给出 `determinable`；`renderer.zoom` 在 1920×1080 + 10×10 房间下得 **`8.64`**（`min(1920/100, 1080/100) × 0.8`，**字面量钉桩**）；`renderer.roomFits` 判定正确。沿用既有 `tests/render/` 的鸭子类型 `Application`（`{ stage, ticker }`）+ 真 PixiJS 场景图模式。**先确认全部失败**
- [X] T004 [P] 在 `client/GameRenderer.ts` 导出缩放常量 `ZOOM_FIT_MARGIN = 0.8` · `ZOOM_MIN = 1.0` · `ZOOM_MAX = 16.0`（模块级导出，与既有 `PX_PER_UNIT` / `CAMERA_LERP_FACTOR` 同一先例；理由见 [research.md](./research.md) D1）
- [X] T005 在 `client/GameRenderer.ts` 实现 `readViewport()`（私有方法）：只读 `app.screen`，返回 `{ width, height, readable }`；`readable = width > 0 ∧ height > 0 ∧ 二者有限`；缺失 / 非有限 / 非正 ⇒ `{ 0, 0, false }`。**MUST NOT** 读 `app.renderer.*`（既有 `camera_adversarial` 的抛错 getter 是这条约束的机器守卫）。同时以 **`public get viewport()`** 只读诊断访问器暴露结果。见 data-model E1
- [X] T006 在 `client/GameRenderer.ts` 实现 `readRoomExtent(world)`（私有方法）：只读 `WallComponent` 求 AABB 与 `pxW/pxH`；`determinable = (有墙) ∧ ¬isInHub(world)`（`isInHub` 从 `src/ecs/components/GameStateComponent` 只读导入，`GameLoop.ts` / `UIManager.ts` 已在用同一谓词）。**MUST 复用** `syncStaticGeometry` 每帧已算出的墙包围盒，**MUST NOT** 发起第二次 `World.query`。`pxW/pxH ≤ 0` 视为不可确定（防除零）。同时以 **`public get roomExtent()`** 只读诊断访问器暴露结果。见 data-model E3
- [X] T007 在 `client/GameRenderer.ts` 实现**纯函数** `computeZoom(extent, viewport)`：`z = clamp(min(vw / pxW, vh / pxH) × ZOOM_FIT_MARGIN, ZOOM_MIN, ZOOM_MAX)`；任一输入退化 ⇒ `1`。**MUST** 是 `(房间范围, 视口)` 的纯函数 —— 无随机源、无墙钟、无历史依赖（FR-002 / FR-003 / FR-020）。同时以 **`public get zoom()`** 只读诊断访问器暴露当前值。见 data-model E2
- [X] T008 在 `client/GameRenderer.ts` 实现 `roomFits(extent, viewport, z)`：`pxW × z ≤ vw ∧ pxH × z ≤ vh`。**MUST** 只由这三个输入决定，**MUST NOT** 读玩家位置或任何其它状态（FR-004）。同时以 **`public get roomFits()`** 只读诊断访问器暴露结果。见 data-model E4

> **暴露方式（已裁决）**：四个原语**不**做模块级导出，而是经 `GameRenderer` 的**只读诊断访问器**暴露（`viewport` / `roomExtent` / `zoom` / `roomFits`），与既有 `public get camera()` / `public get shakeTimeRemainingMs()` / `public get viewCount()` 完全同一风格（doc 注释标 `(diagnostics / assertions)`）。**MUST NOT** 破坏模块的导出级封装。

**Checkpoint**: 只读输入与纯函数就绪（T003 的测试转绿），用户故事可开始。

---

## Phase 3: User Story 1 - 房间与角色在高分辨率屏幕上按合理比例放大 (Priority: P1) 🎯 MVP

**Goal**: 1920×1080 或更高分辨率下，房间不再缩在画布一角；起始房间（10×10）完整可见、**居中且静止**，玩家与敌人都足够大，能一眼看清朝向、动作与距离。

**Independent Test**: 只实现本故事即可交付 —— 在 1920×1080 视口下加载 `start_room`，确认房间完整可见、居中、短边占视口短边 55%–85%，且玩家在房间内移动时房间**纹丝不动**。无需静态 UI 改动或窗口缩放逻辑即可完整验证。

### Tests for User Story 1 ⚠️

> **NOTE: 先写这些测试，确认它们失败，再开始实现**

- [X] T009 [P] [US1] 写**失败**测试 `tests/render/camera_zoom_room_mode.test.ts`：① 等比 —— `cameraContainer.scale.x === cameraContainer.scale.y === renderer.zoom`（FR-005）；② SC-001 —— 1920×1080 + 10×10 房间下房间短边占视口短边落在 **55%–85%**；③ **房间模式静止** —— 玩家在房间内任意位置移动时 `cameraContainer.x/y` **恒定不变**，房间中心恒在视口中心（US1 AS3）；④ **跟随模式钳制** —— 房间大于视口时目标被钳制在房间边界内、房间之外不进入视口（US1 AS4）；⑤ **震动正交** —— 震动激活时 `renderer.zoom` 不变、震动偏移不被 `z` 缩放（FR-019）；⑥ **极小房间（3×3）** —— `renderer.zoom === 16`（**字面量** `ZOOM_MAX`，被正确截断），房间占视口短边**约 44%**、**允许**低于 55% 下限，但 MUST NOT 放大到占满整屏（spec Edge Case「3×3 极小房间」）。契约依据：[camera-view-transform.md](./contracts/camera-view-transform.md) §3.1/§3.3/§3.7
- [X] T010 [P] [US1] 写**失败**测试 `tests/render/camera_zoom_sharpness.test.ts`：断言 `AssetCatalog.load()` 之后 `TextureSource.defaultOptions.scaleMode === 'nearest'`（FR-008）

### Implementation for User Story 1

- [X] T011 [US1] 在 `client/GameRenderer.ts` 的 `syncCamera` 中实现**双取景模式**：`mode = roomFits ? 'room' : 'follow'`；房间模式 `target = screen/2 − roomCenterPx × z`（**与玩家位置无关**）；跟随模式 `target = clamp(screen/2 − playerPx × z, bounds)`（玩家用**插值后**的渲染坐标 `playerView.container.x/y`，ADR-002）。**两条时序约束都是契约**：① **先定模式与 target、再 lerp**（lerp 后修正会在模式切换 / 触界时硬拽，违反 SC-005 无跳变）；② **震动偏移 MUST 在 lerp 之后、作为 `camera.x/y` 的独立分量叠加，MUST NOT 进入 `target` 计算，MUST NOT 被 `z` 缩放**（FR-019；既有 `juice_m14` 的逐位契约依赖此顺序）。见 [contracts/camera-view-transform.md](./contracts/camera-view-transform.md) §2/§3.3/§3.4/§3.7
- [X] T012 [US1] 在 `client/GameRenderer.ts` 每帧把 `z` 写入 `cameraContainer.scale.x` 与 `.y`（**等比**，且**不新增任何场景节点** —— 这是 F1–F6 冻结契约不变的前提）
- [X] T013 [US1] 在 `client/GameRenderer.ts` 的 `reset()` 中复位 `cameraContainer.scale = 1`（连同既有 `x/y = 0`），保证运行边界不残留上一局的倍率
- [X] T014 [US1] 在 `client/GameRenderer.ts` 每帧于 `syncCamera` **之前**重算 `z`（`resizeTo: window` 已让 `app.screen` 自动更新 ⇒ FR-010 无需事件即可生效）。**MUST NOT** 缓存跨帧视口
- [X] T015 [P] [US1] 在 `client/main.ts` 的 `app.init` 选项中增加 `resolution`（守卫读取 `window.devicePixelRatio`，不可读时降级 `1`）与 `autoDensity: true`，并把 `antialias` 由 `true` 改为 `false`（像素美术）。**这是真实缺陷修复**：当前默认 `resolution = 1` ⇒ 高 DPI 屏靠浏览器拉伸画布，**今天就是糊的**。**FR-009 的验证完全由本任务承担**（已裁决不设 node 单测）：`npm run typecheck:client` + `npm run build` + 浏览器实机（[quickstart.md](./quickstart.md) §7）。**理由**：`client/main.ts` 在模块顶层执行 `void main()` 且 `mountCanvas()` 触碰 `document`，**无法被 node 测试导入**（与既有 `client/UIManager.ts` 同一先例）。**MUST NOT** 为了可测而拆散 `main.ts` 的结构或新增模块（`plan.md` 的 Structure Decision 保持有效）
- [X] T016 [P] [US1] 在 `client/assets/AssetCatalog.ts` 的 `load()` **开始处**（任何纹理创建之前）设置 `TextureSource.defaultOptions.scaleMode = 'nearest'`（FR-008）。**这是真实缺陷修复**：当前默认 `linear` ⇒ 像素美术放大必然渗色

**Checkpoint**: US1 独立可用 —— 房间居中、静止、比例合理、世界内容锐利；可单独演示。

---

## Phase 4: User Story 2 - 静态界面保持在屏幕边缘且不被模糊拉伸 (Priority: P1)

**Goal**: 金币读数、生命 HUD、奖励三选一、死亡 / 胜利 / 营地覆盖层始终贴在屏幕固定位置，字号与图标尺寸与缩放前完全一致、边缘锐利。

**Independent Test**: 把世界缩放设到多个不同倍率逐一切换，确认 HUD 与各覆盖层的屏幕位置、尺寸与文字清晰度在所有倍率下完全一致。

### Tests for User Story 2 ⚠️

- [X] T017 [P] [US2] 写**失败**测试 `tests/render/camera_zoom_screen_space.test.ts`：**只做「归属分类」断言，不重钉 F1–F6**（那属 T026，且既有 13 个渲染套件已在退化路径覆盖）—— ① `cameraContainer` 子树内**不含**任何 UI 节点；② 世界空间内容**全部**位于 `cameraContainer` 子树内。契约依据：[scene-graph-and-screen-space.md](./contracts/scene-graph-and-screen-space.md) §2/§3.3/§3.4

### Implementation for User Story 2

- [X] T018 [US2] 在 `client/GameRenderer.ts` 固化「屏幕空间内容不迁入世界空间」：缩放**只**作用于 `cameraContainer.scale`，**MUST NOT** 改写 `staticLayer` / `root` / `fxLayer` / 跳字节点的**局部**坐标与局部 scale（契约 §3.5；`client/UIManager.ts` **无需改动** —— 它是 DOM，天然在 Pixi 场景图之外）
- [X] T019 [US2] 浏览器实机验收（[quickstart.md](./quickstart.md) §5 / SC-003）：把世界缩放取遍上下限之间的多个倍率，逐一切换，确认金币读数、生命 HUD、奖励三选一、死亡 / 胜利 / 营地覆盖层的屏幕位置与视觉尺寸相对基线变化为 **0**、文字无模糊。**观察者协议**：**≥1 名观察者**、**对照改动前截图**、**二值判定（Pass / Fail）**。把截图与判定记入 `production/m17-evidence.md`

  > **⚠️ 部分完成（如实登记）**：**客观部分已完成并机器判定** —— 真浏览器会话（CDP + 缓存 Chromium）在 5 种视口下读 `getBoundingClientRect()`，`#hud` 恒为 `207.547×145.000 @ (12,12)`、`#gold` 恒为 `141.594×70.000` 且右内边距恒 `12.000 px`（世界倍率 4.8 → 11.52 之间**逐位相同**，相对基线变化 = **0**）。见 `production/m17-evidence.md` §5。
  > **⏳ 「文字无模糊」的主观判定 PENDING**：需 **≥1 名人类观察者**按 quickstart §5 对照改动前截图做二值判定。本任务**不代替**该判定。

**Checkpoint**: US1 与 US2 同时可用 —— 世界被放大，界面纹丝不动。

---

## Phase 5: User Story 3 - 视口尺寸变化时自动重新适配 (Priority: P2)

**Goal**: 调整窗口大小、切换全屏、换不同分辨率的屏幕时，画面自动重新适配，房间始终完整可见、比例合理，无需手动操作或刷新。

**Independent Test**: 运行中连续改变视口尺寸（含极端超宽 / 超高比例），确认每次都自动重适配、房间保持完整可见。

### Tests for User Story 3 ⚠️

- [X] T020 [P] [US3] 写**失败**测试 `tests/render/camera_zoom_resize.test.ts`：① 视口在 800×600 / 1920×1080 / 2560×1440 / 3840×2160 间切换后 `renderer.zoom` 与 `target` 正确重算；② 极端宽高比（32:9 与 9:16）下房间完整可见（裁剪 / 溢出发生次数 = **0**，SC-005 / SC-008）；③ 视口缩小跨过「可容纳 / 不可容纳」临界点时 `renderer.roomFits` 判定**稳定**、不逐帧抖动，模式切换可预测、无肉眼可辨跳变。契约依据：[zoom-fit-and-degradation.md](./contracts/zoom-fit-and-degradation.md) §5/§10

### Implementation for User Story 3

- [X] T021 [US3] 审查并保证 `client/GameRenderer.ts` 的视口读取**每帧发生**、**不跨帧缓存**，使视口变化无需任何事件监听即可生效；确认不引入 `window.addEventListener('resize', …)`（`resizeTo: window` 已覆盖）

**Checkpoint**: 窗口随便拖、分辨率随便换，房间都完整可见。

---

## Phase 6: User Story 4 - 缩放是纯表现层映射，玩法逐位不变 (Priority: P2)

**Goal**: 无论画面放大多少倍，碰撞体积、移动速度、攻击距离、伤害判定都与改动前逐 Tick 一致。缩放只改变「看起来多大」，绝不改变「实际是什么」。

**Independent Test**: 固定种子 + 固定输入序列下，分别以「不渲染」与「渲染（含缩放）」运行同一段模拟，比较两次产生的状态序列。

### Tests for User Story 4 ⚠️

- [X] T022 [P] [US4] 写**失败**测试 `tests/render/camera_zoom_degradation.test.ts`：四条退化路径各断言 `renderer.zoom === 1`（**字面量钉桩**，不得写成「等于 `ZOOM_MIN`」）、`roomFits` 不被使用（不进入任何取景模式）、`target` 与旧公式 `screen/2 − playerView` **逐位相同**、不抛错、不阻塞渲染 —— ① 视口不可读（无 `screen` 的鸭子类型替身）；② 视口非有限或非正；③ 无墙世界；④ `isInHub(world)` 为真（营地）。**并额外断言**：`zoomActive === true ∧ z === 1`（构造一个房间大到 `fitZoom ≤ 1.25` 的场景）时**有意不逐位等价**（房间模式或钳制生效），以钉住 spec Edge Case 的边界划分。契约依据：[camera-view-transform.md](./contracts/camera-view-transform.md) §3.6 · [zoom-fit-and-degradation.md](./contracts/zoom-fit-and-degradation.md) §3/§7/§8
- [X] T023 [US4] 写**无损对拍**测试 `tests/harness/camera_zoom_lossless.test.ts`：同 seed + 同输入序列下，「不渲染」与「渲染（含缩放）」两种运行产生**逐位相同**的状态摘要（SC-004 / FR-013）。沿用既有 `tests/harness/render_art_lossless.test.ts` 的摘要模式（`listEntities() × listComponents()` 拼串过 FNV-1a）

### Implementation for User Story 4

- [X] T024 [US4] 在 `client/GameRenderer.ts` 落实退化谓词 `zoomActive = viewport.readable ∧ extent.determinable`；`false` ⇒ `z = 1`、**不钳制**、目标走旧公式 `screen/2 − playerView`（IEEE-754 下 `x × 1 === x` ⇒ 既有 `toBeCloseTo(..., 6)` 收敛断言逐位相同）。**这是既有 803 用例零改动的机制枢纽**；注意逐位等价的键是**谓词**而非 `z` 的取值（spec Edge Case「`zoomActive === false`」）
- [X] T025 [US4] 验证单向依赖与只读性：`src/` 中无任何 `client` import、无新增 import（`git diff --stat src/` 为空）；`client/` 对 `src/` 的 import 均为既有方向；渲染器未调用任何 `World` 写 API（不 `addComponent` / 不 `destroyEntity` / 不推进模拟）（FR-012 / FR-016 · 宪法 I / V）

**Checkpoint**: 玩法逐位未变，且退化路径与改动前行为不可区分。

---

## Phase 7: User Story 5 - 既有测试与场景图契约零回归 (Priority: P3)

**Goal**: 本特性落地后，原有 803 个测试用例全部通过，既有的渲染场景图冻结契约一条都不被破坏，新增能力以「默认恒等」的方式向后兼容。

**Independent Test**: 改动后运行完整测试套件，确认 803 个用例 100% 通过，且既有的相机跟随与场景图断言无需修改即继续成立。

### Tests for User Story 5 ⚠️

- [X] T026 [P] [US5] 写 `tests/render/camera_zoom_scene_graph.test.ts`，**范围严格限定为 `zoomActive === true ∧ cameraContainer.scale ≠ 1` 的路径**（既有 13 个渲染套件已覆盖退化路径上的 F1–F6，本文件**MUST NOT** 重复钉它们）：在缩放激活下重钉 F1 `stage` 唯一子节点 = `camera`；F2 `camera.children[last]` = `root`；F3 `root.children[last]` = `fxLayer`；F4 `root.children[0]` = 首个实体视图；F5 无墙时 `camera.children` 长**恰 1**；F6 空闲时 `fxLayer.children` 长**恰 0**；并断言**无新增常驻节点**、既有惰性挂载点（静态层 / 粒子层）位置与生命周期不变。契约依据：[scene-graph-and-screen-space.md](./contracts/scene-graph-and-screen-space.md) §1/§3.1/§3.2

### Implementation for User Story 5

- [X] T027 [US5] 跑全量 `npm test`：确认 **803 个既有用例 100% 通过**（失败 **0**、新增跳过 **0**），且 `git diff --stat tests/` **只显示新增文件** —— 既有测试文件**零改动**、无任何断言被放宽或删除（SC-006 / FR-017）
- [X] T028 [US5] 确认 17 段管道未变：`grep -rl "'TransformSnapshotSystem'" tests/` 的 **9 处**钉桩零改动；段数钉桩 `toHaveLength(N)` 未被放宽或删除（宪法 III）

  > **⚠️ 基线订正**：实测（`539d96a`，见 `production/m17-baseline.md` §3）该命令命中 **13 个文件**，不是 9 —— `meta_progression` / `advanced_ballistics` / `interpolation` / `tilemap_and_topology` 四个套件在 M16 之后也加入了同一钉桩。**判据不变**：改动后仍为 **13**，且这 13 个文件逐字节不变（已核对）。`toHaveLength(17)` 段数钉桩 5 处零改动。

**Checkpoint**: 零回归成立 —— 这是任何合入前的硬门。

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: 跨故事的收尾、证据与治理登记。

- [X] T029 [P] **变异实验**（宪法 Principle IV 强制）：临时破坏退化门控（例如令 `z` 恒为 `8.64`）⇒ 确认既有相机收敛断言与 T022 的新增退化断言**确实失败** ⇒ 从**备份还原**（**MUST NOT** 使用 `git checkout --`）
- [X] T030 [P] **性能验收**（SC-007 / FR-018）：30×30 `stress_room` + 约 150 敌场景下，同机、同场景、同脚本连续 3 次取中位数，断言表现层**每帧耗时**的「改动后 / 改动前」**比值 ≤ 1.2**。**MUST NOT** 使用绝对墙钟阈值
- [X] T031 跑完 [quickstart.md](./quickstart.md) 全部 11 节验收，把结果与判定记入 `production/m17-evidence.md`。所有涉及主观判定的节（§4 视觉验收对应 SC-002，§10 震动共存对应 SC-009）**MUST 采用观察者协议**：**≥1 名观察者**、**对照改动前截图**、**二值判定（Pass / Fail）**，并记录观察者数量与判定结果

  > **⚠️ 部分完成（如实登记）**：§1/§2/§3/§5/§6/§7/§8/§9/§11 已全部跑完并机器判定；§4 的**客观部分**（房间大小 / 居中 / 完整可见）已由真浏览器像素实测判定（5 种视口房间短边占比**恒 80.0%**、居中到像素、裁剪/溢出 = 0）；§10 的**客观部分**已由「同一震动在 `z=8.64` 与 `z=1` 下偏移均为 −15.000 px」判定。见 `production/m17-evidence.md`。
  > **⏳ 两项主观判定 PENDING（需 ≥1 名人类观察者）**：SC-002「房间大小合适、内容清晰可读」与 SC-009「缩放与震动互不干扰」。证据文件 §4/§10/§14-R2 已给出可复现步骤；**观察者数量与判定结果尚未记录**。
  > **复现**：`NO_COLOR=1 npx vite --port 5199 --strictPort` + `node production/m17-probe.mjs`。
- [X] T032 [P] 治理登记：把「I11 授权扩展（平移 → 平移 + 等比缩放）+ 房间模式取景」登记到 `.workbuddy-ai/memory/INVARIANTS.md` 的 M17 条目；同步 `specs/025-camera-zoom-viewport/plan.md` 的 Complexity Tracking 与实际实现一致
- [X] T033 跑五道闸门全绿作为最终门：`npm test` · `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: 无依赖，可立即开始
- **Foundational (Phase 2)**: 依赖 Setup 完成 —— **阻塞全部用户故事**
- **User Stories (Phase 3–7)**: 全部依赖 Foundational 完成
- **Polish (Phase 8)**: 依赖所需用户故事完成

### User Story Dependencies

- **US1 (P1)**: Foundational 完成后可开始 —— 无其它故事依赖
- **US2 (P1)**: Foundational 完成后可开始 —— 与 US1 共享 `cameraContainer` 但互不阻塞（US2 是「保持边界」性质，不新增节点）
- **US3 (P2)**: Foundational 完成后可开始 —— 依赖 T007/T008 的纯函数，不依赖 US1 的取景实现
- **US4 (P2)**: Foundational 完成后可开始 —— 退化路径独立于取景模式
- **US5 (P3)**: 必须在 US1–US4 全部完成后才能得出有效结论（它是对前四者的零回归判定）

### 关键顺序约束

- **`client/GameRenderer.ts` 是本特性的单点热点**：T004–T008、T011–T014、T018、T021、T024 全部改同一文件，**必须串行**，一律不加 `[P]`
- **测试先于实现**：T003 先于 T004–T008；T009/T010 先于 T011–T016；T017 先于 T018；T020 先于 T021；T022/T023 先于 T024
- **T012（写 `scale`）必须在 T011（算 `target`）之后** —— 否则跟随目标会基于错误的变换
- **T024（退化谓词）必须先于 T027（全量回归）** —— 803 用例全绿完全依赖退化路径的逐位等价
- **T015（`main.ts`）自带 FR-009 验证，无独立测试任务** —— 该文件不可被 node 测试导入（见 T015 理由）

### Parallel Opportunities

- Setup 的 T002 与 T001 的其它闸门命令可并行
- Foundational 的 T003（测试文件）与 T004（常量）不同文件，可并行；T005–T008 同文件，串行
- US1 的 T009 / T010 是**两个不同测试文件**，可并行编写；T015（`main.ts`）与 T016（`AssetCatalog.ts`）与 GameRenderer 改动不同文件，可并行
- US2 的 T017、US3 的 T020、US4 的 T022/T023 分属不同测试文件，可并行编写
- Polish 的 T029 / T030 / T032 相互独立，可并行

---

## Parallel Example: User Story 1

```bash
# 两个测试文件可同时开写（不同文件，均先确认失败）：
Task: "写失败测试 tests/render/camera_zoom_room_mode.test.ts"
Task: "写失败测试 tests/render/camera_zoom_sharpness.test.ts"

# 两处启动期选项与 GameRenderer 改动互不冲突，可同时进行：
Task: "在 client/main.ts 增加 resolution / autoDensity 并关闭 antialias"
Task: "在 client/assets/AssetCatalog.ts 设置 scaleMode = 'nearest'"
```

## Parallel Example: 多故事并行

```bash
# Foundational 完成后，三个故事的测试可同时开写：
Task: "[US2] 写 tests/render/camera_zoom_screen_space.test.ts"
Task: "[US3] 写 tests/render/camera_zoom_resize.test.ts"
Task: "[US4] 写 tests/render/camera_zoom_degradation.test.ts"
```

---

## Implementation Strategy

### MVP First（仅 User Story 1 + 必要的 US2）

1. 完成 Phase 1（基线证据）
2. 完成 Phase 2 Foundational（**CRITICAL** —— 阻塞全部故事）
3. 完成 Phase 3 US1 → 房间居中、静止、比例合理、世界锐利
4. 完成 Phase 4 US2 → 界面纹丝不动
5. **STOP and VALIDATE**：在 1920×1080 与 2560×1440 下独立验收 US1 + US2，并跑全量 `npm test` 确认 803 用例未受影响

> 之所以 MVP 含 US2：用户把「世界放大」与「界面不变」作为**同一句要求**提出。只放大世界而不固定界面，HUD 会随缩放漂移出屏幕 —— 单独交付 US1 不是可用增量。

### Incremental Delivery

1. Setup + Foundational → 只读输入与纯函数就绪
2. + US1 → 房间放大且居中静止（核心价值落地）
3. + US2 → 界面保持屏幕空间（体验完整）
4. + US3 → 窗口随便拖、分辨率随便换
5. + US4 → 玩法逐位不变的证据齐备
6. + US5 → 零回归门通过
7. + Polish → 变异实验、性能比值、quickstart 全跑、治理登记

### 交付前的硬门（缺一不可）

- `git diff --stat src/` **空**（逻辑内核零改动）
- `git diff --stat tests/` **只显示新增文件**（既有 803 用例零改动）
- 管道仍 **17 段**，9 处钉桩零改动
- 6 条渲染场景图冻结契约（F1–F6）逐条不变
- 五道闸门全绿

---

## Notes

- **[P] 语义**：仅表示「不同文件、无未完成依赖」。**同一文件的任务一律不得标 `[P]`** —— 本特性尤其要注意 `client/GameRenderer.ts`。
- **[Story] 标签**用于把任务回溯到用户故事，便于独立验收与分批交付。
- **逐位等价的键是谓词，不是 `z` 的取值**：`zoomActive === false` ⇒ `z = 1`、不钳制、旧公式、与改动前逐位一致。反之 `zoomActive === true ∧ z === 1`（房间大到 `fitZoom ≤ 1.25`）时房间模式 / 钳制**有意**生效，**不**逐位等价。既有渲染套件全部落在前者（鸭子类型 `Application` 只有 `{ stage, ticker }` ⇒ `app.screen` 为 `undefined` ⇒ `readable === false`；`camera_adversarial` C4 有真 `screen` 但无墙 ⇒ `determinable === false`）。IEEE-754 下 `x × 1 === x`，故既有 `toBeCloseTo(..., 6)` 断言逐位相同。**任何破坏这条路径的改动都会一次性打翻 803 个用例。**
- **反恒真陷阱**：`z` 的断言必须用**字面量**（`8.64` / `16` / `1`），禁止写成「等于构造它的那个常量」（如「等于 `ZOOM_MIN`」）。
- **反空真**：断言「没有钳制」之前，必须先断言「钳制路径确实被走到过」（构造一个房间大于视口的场景）。
- **性能判定只用比值**，禁用绝对墙钟阈值（宪法 Principle IV）。
- **本阶段不 commit**：`specs/025-*` 与 `.specify/` 保持未跟踪，提交须经人工审批。
