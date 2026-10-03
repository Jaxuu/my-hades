# Tasks: UI 层重构：材质化 HUD 与祝福交互面板（M19）

**Input**: Design documents from `/specs/027-hud-boon-ui/`

**Prerequisites**: `plan.md`（必需）· `spec.md`（必需，用户故事）· `research.md` · `data-model.md` · `contracts/` · `quickstart.md`

**Tests**: 本特性**包含测试任务** —— 项目宪法 Principle IV（测试先行与证据化验证）为强制；规格 SC-009 要求 948 例 100% 通过，且 `tests/ui/*` 的既有断言 MUST 零改动。

**Organization**: 按用户故事分组，每个故事可独立实现、独立验证。

**Revision**: v2 —— 依 `/speckit.analyze` 补全 5 条覆盖任务（C1 场景图契约 · C2 体积实测 · C3 写 API 黑名单 · C4 离线请求 · U1 draft 契约），ID 已重排为执行序（T001–T061）。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无未完成依赖）
- **[Story]**: 所属用户故事（US1…US6）；Setup / Foundational / Polish **不带**故事标签
- 每个任务含**确切文件路径**

## 全局硬约束（每个任务都必须遵守）

1. **`src/` 改动文件数 = 0**（`git diff --stat src/` 为空）；17 段管道不变。
2. **不新增运行时依赖**（`client/` 依赖集合 = `{pixi.js, howler}`）。
3. **三条源码扫描红线**（`tests/ui/*` 是**源码文本扫描**，非 DOM 测试）：
   - `client/UIManager.ts` 保留 **≥3 处字面 `document.createElement('button')`（单引号）**；
   - **禁止新增任何 `--font-*`**（`text_readability.test.ts` 断言字体栈恰 2 个）；
   - `index.html` 的 `#hud, #keys, #gold {` 保持**连续且同序**；⚠️ 新增的 `#hud-material` **MUST NOT** 被插进该选择器列表，其样式 MUST 独立声明。
4. **冻结钩子零删除**：10 class（`is-visible`/`is-death`/`is-win`/`is-hub`/`reward-button`/`talent-button`/`start-button`/`hub-currency`/`hub-talents`/`death-hint`）+ 5 id（`app`/`ui-layer`/`hud`/`gold`/`keys`）+ 6 M16 钩子。
5. 九宫格框体 MUST 用 `border-image`（`slice 12`）；**禁用** `background-size:100% 100%`。
6. `boons.json` 落 `client/assets/`；**`src/**` MUST NOT import 它**。
7. 品质 = **静态纯外观**；描述数值 MUST **只读派生**（禁表现层数值字面量）。
8. 无损 MUST 用**快照摘要逐位**自证；性能 MUST 用**比值**（≤1.2），禁用绝对墙钟。

## Path Conventions

- 表现层：`client/`（新增纯模型模块在 `client/ui/`）
- 数据：`client/assets/`（`boons.json` + `manifest.ts` 唯一引用点）
- 贴图：`assets/art/ui/`（+ `assets/art/LICENSES.md` 登记）
- 测试：`tests/`
- 生成器与证据：`production/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: 基线固化、目录与骨架就位

- [x] T001 固化基线并留证：运行 `NO_COLOR=1 npx vitest run`，确认 **948 例（947 通过 + 1 例负载敏感 `tests/performance/stress.test.ts` G2）**；单独复跑 `stress.test.ts` 确认空闲机器 5/5 通过；记录快照摘要基线 `f52dfdd4`。证据写入 `production/m19-baseline.md`
- [x] T002 [P] 建立纯模型模块 barrel：`client/ui/index.ts`（导出 `quality` / `boon-catalog` / `boon-presentation` / `hud-model` / `status-panel`）
- [x] T003 [P] 建立 `client/assets/boons.json`：5 条目 —— `zeus_strike`=`epic`·`lightning` · `dionysus_strike`=`epic`·`grape` · `poseidon_dash`=`legendary`·`trident` · `hp_up`=`common`·`heart` · `dash_up`=`common`·`boot`；`description` 只含 `{占位符}`、**不含字面数值**
- [x] T004 [P] `index.html`：声明 `--rarity-common|epic|legendary`（`#3f6ea8` / `#8a5cd0` / `#ffcd4a`）与 **7 个新增 `--ui-*` 槽位**（`--ui-frame-health` · `--ui-frame-dash` · `--ui-frame-boon-{common,epic,legendary}` · `--ui-panel-status` · `--ui-rule`），全部默认 `none`
- [x] T005 [P] `client/assets/manifest.ts`：登记 7 个新增 UI 框体资产（`?url` 静态导入，保持**唯一引用点**）
- [x] T006 生成 7 个 48×48 九宫格框体资产：`production/m19-ui-frames.mjs`（Node 零依赖程序化生成）→ `assets/art/ui/`，并在 `assets/art/LICENSES.md` 逐项登记（本仓库原创）

---

## Phase 2: Foundational (Blocking Prerequisites)

**⚠️ CRITICAL**: 本阶段完成前，**任何**用户故事都不得开工

- [x] T007 [P] `client/ui/quality.ts`：品质枚举 `common|epic|legendary` + 三色映射 + **非颜色通道**映射（pips 数 1/2/3、中文标签「普通/史诗/传说」、`boon-icon-frame--square|cut|crown` 类名）
- [x] T008 [P] `client/ui/boon-catalog.ts`：静态 import `boons.json` + 解析 + **缺失降级**（`rarity`→`common`、`icon`→`default`）+ 与 `REWARD_POOL` 的一致性视图（纯函数；无 DOM / 无 pixi / 无随机）
- [x] T009 [P] `client/ui/boon-presentation.ts`：描述模板占位符注入（数值**只读**取自 `DataManager.getModifierConfig` / `POISON_STATUS_SPEC` / `HP_UP_AMOUNT` / `DASH_UP_COOLDOWN_REDUCTION`）+ 卡面视图 `{id,label,rarity,iconGlyph,description}`；任一槽位无法解析 ⇒ 回退**不含数值**的安全文案（绝不 `undefined`/`NaN`）
- [x] T010 [P] `tests/ui/boon-data.test.ts`：V1 数据表 id **==** `REWARD_POOL` id（无悬空/无缺失）· V2 `rarity` ∈ 枚举 · V3 `icon` ∈ **CSS 字形 token 白名单** · V4 `description` 占位符全部可解析 · V5 `src/**` **不** import `boons.json` · V6 `src/data/bundled.ts` 加载列表不含 `boons.json`
- [x] T011 [P] `tests/ui/boon-description.test.ts`：**双通道**一致性 —— 通道 A 读 `assets/data/modifiers.json`（经 `DataManager`）与 `src` 导出常量交叉比对；通道 B **真打一次命中并量真实掉血 == 描述数值**（防「状态被设置 ≠ 效果被施加」恒真陷阱）
- [x] T012 `client/UIManager.ts`：追加新 DOM 钩子（`#hud-material` · `hud-health`/`hud-dash`/`hud-gold` · `boon-card` · `boon-rarity-common|epic|legendary` · `boon-icon` · `boon-desc` · `status-panel`/`status-row`/`status-empty`），**保留全部冻结 class/id 与 ≥3 处单引号 `document.createElement('button')`**
- [x] T013 [P] `tests/ui/ui_skin.test.ts`：**追加**新钩子断言（既有 **21 例零改动**）
- [x] T014 [P] `client/main.ts`：装配新增 UI 模块与 `--ui-*` 注入；秒换算 MUST 用 `sim.fixedDeltaSeconds`（**禁硬编码 `1/60`**）
- [x] T015 阶段门禁：`npm test` · `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build` 全绿，输出记入 `production/m19-evidence.md`

**Checkpoint**: 纯模型层与骨架就位，用户故事可并行开工

---

## Phase 3: User Story 1 - 局内 HUD 升级为材质化高清组件 (Priority: P1) 🎯 MVP

**Goal**: 生命 / 冲刺充能 / 金币三件常驻图形组件取代纯文本读数

**Independent Test**: 受伤 / 冲刺 / 拾取金币，观察三组件实时正确；任意覆盖层下仍正确；无需卡片或面板

### Tests for User Story 1 ⚠️ 先写、先失败

- [x] T016 [P] [US1] `tests/ui/hud-model.test.ts`：生命数值 + 比例（`maxHp=0` 不除零、`hp=0` 濒危）· 冲刺 `cooldownRemaining=0` 可用 / `cooldownTicks=0` 进度 1 · 金币 ≥0 与极值不溢出 · 玩家缺失时零值不崩溃
- [x] T017 [P] [US1] `tests/ui/hud-persistence.test.ts`：HUD 在 draft / death / win / hub 各覆盖层下均正确（FR-005）；`#hud-material` / `#gold` / `#hud` 三者**读数不重复、不矛盾**（FR-007）
- [x] T018 [P] [US1] `tests/ui/hud-boundaries.test.ts`：金币极大值不截断、冲刺满冷却清晰、生命条不反向、**读数未变化时该帧 DOM 写入次数 = 0**（FR-006 可测口径）

### Implementation for User Story 1

- [x] T019 [P] [US1] `client/ui/hud-model.ts`：HUD 视图派生纯函数（只读 `HealthComponent` / `DashStatsComponent` / `readGold`）
- [x] T020 [US1] `client/UIManager.ts`：渲染 HUD 三组件（生命 = 数值 + 比例条 → `#hud-material`；冲刺 = 可用/冷却 + 进度 → `#hud-material`；金币 = 读数牌 → `#gold`）+ **变更键守卫**（无变化零 DOM 写）
- [x] T021 [US1] `index.html`：HUD 三组件样式（`--ui-frame-health` / `--ui-frame-dash` 九宫格 `border-image` slice 12；生命三态 CSS 换色；`tabular-nums`）；**保持 `#hud, #keys, #gold {` 连续同序**，`#hud-material` 样式**独立声明**
- [x] T022 [US1] `client/main.ts`：HUD 经 `UIManager.sync` 只读接线（不写 world、不推进模拟）

**Checkpoint**: US1 独立可验（无需卡片 / 面板）

---

## Phase 4: User Story 2 - 房间清理后的三选一祝福卡片 (Priority: P1)

**Goal**: 三张卡片各具 品质颜色 + 图标 + 数值化描述

**Independent Test**: 清房后观察三卡三要素齐备，品质与 `boons.json` 一致，描述数值与逻辑层一致

### Tests for User Story 2 ⚠️

- [x] T023 [P] [US2] `tests/ui/boon-card.test.ts`：三要素携带率 100%（逐卡）· 品质 → `boon-rarity-*` class 映射 · **品质分配字面量钉桩**（`zeus_strike`=epic / `dionysus_strike`=epic / `poseidon_dash`=legendary / `hp_up`=common / `dash_up`=common，读 `boons.json` 与测试内字面量表**两独立来源**比对）· 缺元数据降级（默认品质 + 占位字形 + 安全描述）
- [x] T024 [P] [US2] `tests/ui/boon-glyph.test.ts`：`icon` 字形 token → CSS 字形/形状映射（5 + 默认 `◆`）；未知 token 回退 `◆`；**不查询 `MANIFEST`/`AssetCatalog`**（U3）
- [x] T025 [P] [US2] `tests/ui/boon-draft-contract.test.ts`：**draft 触发与数量沿用既有**（FR-010）—— 清房后恰好 3 个互不相同的选项、由既有 `findRewardDraft` 驱动、UI **不**自行抽取或改写数量

### Implementation for User Story 2

- [x] T026 [US2] `client/UIManager.ts`：卡片渲染 —— 品质 class + CSS 字形图标 + 数值化描述；**保留 `reward-button` 钩子与 `onSelect(id)` 契约**
- [x] T027 [US2] `index.html`：卡片样式（约 200×280、`clamp(160px,22vw,200px)` + `aspect-ratio:5/7` + `flex-wrap`）+ **品质三层载体**：① 框外 3px `box-shadow` 品质环 ② 品质 chip 背景 ③ `--ui-frame-boon-*` 框体图（品质色烘进线描）；③ 缺失 ⇒ `border-image:none` + `border-color` 实心品质边框
- [x] T028 [US2] `index.html`：非颜色通道落地（`.boon-rarity-tag` 文本 / `.boon-pips` 1·2·3 / `.boon-icon-frame--square|cut|crown`）
- [x] T029 [US2] `tests/ui/boon-select.test.ts`：选择链路 —— 卡片点击 → `onSelect(id)` → 组合根 → `selectReward` 输入；UI **不**直接授予祝福（FR-015）

**Checkpoint**: US1 与 US2 均可独立工作

---

## Phase 5: User Story 3 - 按 Tab 呼出的局内状态面板 (Priority: P1)

**Goal**: Tab 呼出/收起，陈列已拥有全部祝福及描述，**不暂停**

**Independent Test**: 拥有若干祝福后按 Tab，列表 == 实际持有集合；开关面板两条轨迹逐 Tick 一致

### Tests for User Story 3 ⚠️

- [x] T030 [P] [US3] `tests/ui/status-panel.test.ts`：集合一致性（== `ModifierComponent.modifiers`，SC-005）· 空集合明确空状态 · 大量可滚动 · 每行含品质/图标/描述
- [x] T031 [P] [US3] `tests/ui/status-panel-nopause.test.ts`：**面板开 / 关两条相同输入轨迹逐 Tick 状态完全一致（差异 0）**（SC-006 / FR-022）
- [x] T032 [P] [US3] `tests/ui/status-panel-lifecycle.test.ts`：Tab 监听仅在局内激活；进入终局 / 营地 / `destroy()` 后**无残留监听**（FR-025）

### Implementation for User Story 3

- [x] T033 [P] [US3] `client/ui/status-panel.ts`：面板视图模型纯函数（拥有祝福 → 行视图，复用 `boon-presentation`）
- [x] T034 [US3] `client/UIManager.ts`：Tab 面板渲染 + **Tab 键监听生命周期**（激活即挂载、退出即移除、`destroy()` 强摘）+ 与既有覆盖层互斥优先级（终局 > 营地 > draft/status）
- [x] T035 [US3] `index.html`：面板样式（`--ui-panel-status` 九宫格、`min(720px,94vw)` / `92vh`、行高 72px、**浅遮罩**表达非阻塞、滚动条、空状态）

**Checkpoint**: 三个 P1 故事全部独立可验

---

## Phase 6: User Story 4 - 纯表现层：零污染、零回归 (Priority: P1)

**Goal**: `src/` 零改动、依赖单向、948 例 100%、摘要逐位不变、性能比值 ≤1.2

**Independent Test**: 固定种子 + 固定输入下，改动前后状态逐 Tick 一致且摘要逐位相同

### Tests for User Story 4 ⚠️

- [x] T036 [P] [US4] `tests/ui/ui-purity.test.ts`：`src/**` 零改动（源码差异守卫）+ 无反向依赖（`src → client` 引用数 = 0）+ 管道仍 **17 段**（复用 9 处 `TransformSnapshotSystem` 钉桩）
- [x] T037 [P] [US4] `tests/ui/ui-write-blacklist.test.ts`：**UI MUST NOT 写世界**（FR-033）—— 断言 `client/**` 源码不含 `addComponent` / `removeComponent` / `applyDamage` / `addModifier` / `removeModifier` / `grantReward` / `sim.step` / `world.rng` 等写路径调用；意图一律经组合根回传
- [x] T038 [P] [US4] `tests/ui/scene_graph_contracts.test.ts`：**渲染场景图 6 条冻结契约**仍成立（FR-054 / SC-012）—— 复用 `tests/render/camera_zoom_scene_graph.test.ts` 口径：`stage` 唯一子 = camera · `camera.children[last]` = root · `root.children[last]` = fxLayer · `root.children[0]` = 首个实体视图 · 无墙时 `camera.children` 长恰 1 · 空闲时 `fxLayer.children` 长恰 0（DOM 方案应天然满足，此任务**证明**而非假设）
- [x] T039 [P] [US4] `tests/ui/lossless_m19.test.ts`：固定种子（如 `0x12345678`）601 tick，快照摘要**逐位 == `f52dfdd4`**
- [x] T040 [P] [US4] 复跑既有无损套件 `tests/harness/render_art_lossless.test.ts` 与 `tests/harness/camera_zoom_lossless.test.ts` —— **零改动**通过
- [x] T041 [P] [US4] 复跑 `tests/performance/render_art_cost.test.ts`：每帧耗时中位数**比值 ≤ 1.2**（同机 / 同场景 / 3 次取中位数）

### Implementation for User Story 4

- [x] T042 [US4] 核对 `git status --short -- src/` 与 `git diff --stat src/` 均为空；核对 `client/` 依赖集合仍为 `{pixi.js, howler}`（记入 `production/m19-evidence.md`）
- [x] T043 [US4] 核对 `REWARD_POOL` / `draftRewards` / `modifiers.json` / `POISON_STATUS_SPEC` **零改动**；品质未参与任何随机或数值（记入 `production/m19-evidence.md`）

**Checkpoint**: 硬约束全部有证据

---

## Phase 7: User Story 5 - 既有覆盖层纳入统一 HD 视觉语言 (Priority: P2)

**Goal**: 死亡 / 胜利 / 营地与本特性 HUD/卡片同一 HD 语言，语义契约不变

**Independent Test**: 分别触发三界面，视觉统一且 `R` 回营地 / 购买 / 开始逃离仍可用

### Tests for User Story 5 ⚠️

- [x] T044 [P] [US5] `tests/ui/overlay_contract.test.ts`：覆盖层既有语义与交互契约不变（`R` 回营地 / 购买天赋 / 开始逃离 / 终局优先级）；冻结 class `is-death` / `is-win` / `is-hub` 仍存在

### Implementation for User Story 5

- [x] T045 [US5] `index.html`：三覆盖层皮肤统一（沿用 `--ui-overlay-death` / `--ui-overlay-win` / `--ui-panel-camp` + 新增 `--ui-rule` 铜色分隔）
- [x] T046 [US5] `client/UIManager.ts`：确认覆盖层渲染路径与优先级**零改动**（仅皮肤变更）

**Checkpoint**: 全站视觉语言统一

---

## Phase 8: User Story 6 - 优雅降级、文本可读与键盘可达 (Priority: P2)

**Goal**: 缺资产仍可用；中文不依赖网络字体；键盘可达；离线可用

**Independent Test**: 移除 UI 资产仍可用；无 `@font-face`；键盘 Tab 遍历焦点可见；外部请求数为 0

### Tests for User Story 6 ⚠️

- [x] T047 [P] [US6] `tests/ui/ui_degradation.test.ts`：`--ui-*` 全 `none` 时各表面纯 CSS 可用；缺资产不崩溃 / 不黑屏
- [x] T048 [P] [US6] `tests/ui/accessibility.test.ts`：全部可交互元素可聚焦 + 焦点环规则存在
- [x] T049 [P] [US6] `tests/ui/text_readability.test.ts`：**追加**断言（**未新增任何 `--font-*`**）；既有 **9 例零改动**
- [x] T050 [P] [US6] `tests/ui/offline.test.ts`：**离线可用性**（FR-053 / SC-011）—— 断言全部 UI 资产经构建期静态导入本地分发、源码与产物中**无运行时 `fetch` / 外部 URL / CDN 引用**（外部请求数 = 0）

### Implementation for User Story 6

- [x] T051 [US6] `index.html`：为每个新表面补纯 CSS 回退（生命 = 实心条 / 冲刺 = `conic-gradient` 环 / 卡片 = 实心品质边框 / 图标 = CSS 字形或 `◆`）—— **只去装饰，绝不去文字与状态色**

**Checkpoint**: 弱环境与无障碍场景下仍可用

---

## Phase 9: Polish & Cross-Cutting Concerns

- [x] T052 [P] `production/m19-probe.mjs`：真浏览器探针（5 视口：1920×1080 / 2560×1440 / 3840×1080 / 1080×1920 / 800×600）—— 卡片三要素可见、不溢出；HUD 非纯文本
  - **PASS**（主理人执行，原 `quality-lead` 因 429 失败）：5/5 视口 `#hud-material` 图形化节点齐备、7 槽位全部解析为 `url(...)`、外部请求 0。⚠️ 页面滚动条经 **M18 基线 A/B 实测**证伪为**既有缺陷**（非 M19），见 `production/m18-baseline-scroll-ab.json`
- [x] T053 [P] 品质像素判据：采样**框外 3px 品质环**或 **chip 背景**（**不采**被 `border-image` 覆盖的框区）；三色两两 欧氏 ΔRGB ≥ 60 且 max-channel Δ ≥ 50；并加 `grayscale(1)` 截图断言。输出至 `production/m19-shots/`
  - **PASS**：环/chip 实测 `#3f6ea8` / `#8a5cd0` / `#ffcd4a`；三对 **86.9/75 · 233.9/192 · 210.7/134** 全达标；灰度裁剪 sha256 两两不同
- [x] T054 UI 资产体积实测（FR-053 / SC-016）：统计 `assets/art/ui/` 新增资产的总量与单文件，判定不超过**既有全局预算**（单文件 ≤ 3 MiB / 总量 ≤ 12 MiB）；本特性**不设**更紧子预算。证据写入 `production/m19-ui-volume.md`
- [x] T055 变异实验 M1–M5：① 品质 → class 映射 ② 描述数值来源 ③ Tab 不暂停 ④ 降级回退 ⑤ 面板集合一致性 —— 各自「破坏 → 确认断言失败 → **从备份逐字节还原**」（**禁** `git checkout --`）；日志写入 `production/m19-mutation-log.md`
  - **PASS（扩为 M1–M6）**：6/6 均被对应断言**真实捕获**，6/6 **逐字节还原成功**（实验后全量 sha256 与快照一致）。新增 **M6** 守卫本次修复的 `--ui-frame-dash` 死槽位缺陷
- [x] T056 [P] `assets/art/LICENSES.md` + `README.md` 更新（M19 条目）
- [x] T057 证据归档：`production/m19-{baseline,evidence}.md`（五道闸门输出、摘要对比、性能比值、探针截图）
- [x] T058 执行 `specs/027-hud-boon-ui/quickstart.md` V1–V13 并逐条记录判定
- [x] T059 主观 SC 登记 **PENDING**（SC-014 观察者正确率 / SC-001·002 观感），安排人类观察者（记入 `production/m19-evidence.md`）
- [x] T060 五道闸门终验：`npm test` · `typecheck` · `typecheck:client` · `lint` · `build` 全绿（输出记入 `production/m19-evidence.md`）
- [x] T061 git 提交（**须人工审批**，默认不 push；提交哈希记入 `production/m19-evidence.md`）
  - 用户于 2026-10-03 明确授权**提交并 push**；哈希见 `production/m19-evidence.md` §13

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**：无依赖，可立即开始
- **Foundational (Phase 2)**：依赖 Setup —— **阻塞全部用户故事**
- **US1 / US2 / US3 (Phase 3–5)**：依赖 Foundational；三者**互相独立**，可并行
- **US4 (Phase 6)**：依赖 US1–US3 完成后核对
- **US5 / US6 (Phase 7–8)**：依赖 Foundational，可与 US1–US3 并行
- **Polish (Phase 9)**：依赖全部期望故事完成

### Within Each User Story

测试**先写且先失败** → 纯模型 → DOM 装配 → 样式 → 集成；故事完成后再进入下一优先级。

### Parallel Opportunities

- Setup：T002–T005 可并行
- Foundational：T007–T011、T013、T014 可并行
- US1：T016 / T017 / T018 / T019 可并行
- US2：T023 / T024 / T025 可并行
- US3：T030 / T031 / T032 / T033 可并行
- US4：T036–T041 可并行
- US6：T047 / T048 / T049 / T050 可并行
- ⚠️ **单文件热点必须串行**：`client/UIManager.ts`（T012 → T020 → T026 → T034 → T046）与 `index.html`（T004 → T021 → T027 → T028 → T035 → T045 → T051）

### Parallel Example: User Story 1

```bash
# 并行（不同文件）：
tests/ui/hud-model.test.ts          # T016
tests/ui/hud-persistence.test.ts    # T017
tests/ui/hud-boundaries.test.ts     # T018
client/ui/hud-model.ts              # T019

# 串行（同一批单文件热点）：
client/UIManager.ts  # T020
index.html           # T021
client/main.ts       # T022
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Phase 1 Setup
2. Phase 2 Foundational（**关键** —— 阻塞全部故事）
3. Phase 3 US1（材质化 HUD）
4. **STOP & VALIDATE**：独立验证 US1
5. 可演示

### Incremental Delivery

Setup + Foundational → US1（MVP）→ US2 → US3 → US4 核对 → US5 / US6 → Polish。
每个故事独立可测、独立可演示，且不破坏前序故事。

---

## Notes

- [P] = 不同文件、无依赖；**同文件（`UIManager.ts` / `index.html`）必须串行**
- 测试任务 MUST **先写、先失败**（宪法 Principle IV）
- 恒真陷阱防范：品质分配用**两独立来源**比对；描述数值用**双通道**（含真实掉血）
- 反空真：断言「没有」之前先断言「有过」
- 每个任务后或逻辑组后提交（**须人工审批**）
- **禁止**：放宽或删除既有断言 · `git checkout --` 还原 · 绝对墙钟性能阈值 · 让 `src/` 出现任何改动
