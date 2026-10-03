# Implementation Plan: UI 层重构：材质化 HUD 与祝福交互面板（M19）

**Branch**: `027-hud-boon-ui` | **Date**: 2026-10-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/027-hud-boon-ui/spec.md`

## Summary

把界面（**表现层 DOM**）从「角落里的纯文本读数 + 只有英文名的文字按钮」整体升级为**有材质质感的 HD UI**：① **材质化 HUD**——生命（数值 + 比例条）、冲刺充能（可用/冷却 + 进度）、金币牌三件常驻图形组件；② **三选一祝福卡片**——品质颜色（**蓝/紫/金**）+ 专属图标 + **数值化效果描述**（数值只读派生自逻辑层）；③ **Tab 局内状态面板**（**非阻塞**）——陈列玩家已拥有的全部祝福及描述；④ 死亡 / 胜利 / 营地三个既有覆盖层纳入**统一的 HD 视觉语言**。

**技术路线**：**纯表现层重构**。`src/` **零改动文件**、17 段管道不变、依赖方向保持单向（`client → src`）、**不新增任何运行时依赖**（仍 `{pixi.js, howler}`）。新增一份**表现层自有、只读**的祝福元数据表 `client/assets/boons.json`（品质 / 图标 / 描述模板），内核对其**结构性不可见**（置于 `client/` 之下 ⇒ `src/` 引用它在路径语义上即不成立；且 `src/data/bundled.ts` 具名加载、不做目录枚举）。

**核心工程动作集中在四处**：① `client/UIManager.ts` 扩展（HUD 三组件 + 卡片三要素 + Tab 面板 + 覆盖层皮肤，全部**追加**，不替换冻结钩子）；② 新增**祝福目录模块**（`boons.json` 解析 + 描述纯函数 + 只读数值注入）；③ `index.html` 皮肤扩展（新增 `--ui-*` 槽位，默认 `none` ⇒ 纯 CSS 降级）；④ 新增 UI 资产（图标 / 九宫格框 / 条 / 面板）与 `client/assets/manifest.ts` 的引用点扩充。

**定案的关键决策**：HUD 用 **DOM/CSS**（不进 Pixi 场景图 ⇒ 6 条渲染冻结契约零风险）· 品质 = **静态声明式纯外观** · Tab 面板**不暂停** · 描述数值**单一来源只读注入**（防漂移）· 校验放**测试期**、运行期**降级**。

**全部决策与备选**见 [`research.md`](./research.md)；成员专业交付物见 [`design/`](./design/)。

## Technical Context

**Language/Version**: TypeScript 5.7（`strict`）· Node ≥ 22 · ESM

**Primary Dependencies**:
- 表现层：`pixi.js ^8.21.0` + `howler ^2.2.4` —— **本特性 MUST NOT 新增任何依赖**（D12）。
- 逻辑内核 `src/`：零运行时依赖（宪法「技术栈与架构约束」）。

**Storage**: 本地文件。祝福元数据以**静态 JSON import** 在**构建期**解析；UI 贴图经 `client/assets/manifest.ts`（唯一引用点）以 `?url` 静态导入。无后端、无 CDN、无运行时 `fetch`。

**Testing**: Vitest 2.1.8，`pool: 'threads'`、`environment: 'node'`（无 jsdom）、`setupFiles: ./tests/harness/setup-config.ts`。基线 **948 例全绿**；本特性后总数 MUST ≥ 948（FR-055）。`client/UIManager.ts` 无 node 单测 ⇒ 靠 `typecheck:client` + `vite build` 兜底。

**Target Platform**: 桌面浏览器（界面 = DOM/CSS；世界 = WebGL · PixiJS v8）。配合 M17（`specs/025`）相机缩放与视口自适应。

**Project Type**: 单仓库前端游戏 —— **冻结的 headless ECS 内核（`src/`）+ 独立表现层（`client/`）**，单向依赖。

**Performance Goals**:
- 约 150 敌人同屏下，表现层**每帧耗时中位数**的「改动后 / 改动前」**比值 ≤ 1.2**（同机、同场景、同一脚本、连续 3 次取中位数；宪法 Principle IV 禁用绝对墙钟）。
- HUD 在读数未变化时 MUST NOT 重建节点（FR-006）。

**Constraints**:
- `src/` **改动文件数 = 0**（FR-030 / SC-007）；17 段管道段数与顺序不变。
- 依赖方向单向；`GameRenderer` 导入图 MUST NOT 含 `howler`（宪法 Principle V）。
- 品质 = **静态、声明式、纯外观**；禁改掉落算法、禁运行时生成（用户裁定 / FR-016 / FR-031）。
- **唯一资产引用点**：`client/assets/manifest.ts`（删文件即构建失败，FR-050）。
- 冻结 UI 钩子 MUST 保留（10 class + 5 id + M16 钩子，`tests/ui/ui_skin.test.ts`）。
- **无网络字体** + 中文回退（`tests/ui/text_readability.test.ts`）。
- 渲染场景图 **6 条冻结契约** MUST NOT 被破坏（DOM 方案天然满足）。
- 离线可用、外部请求数 = 0；许可合规（开放许可或原创，逐项登记）。
- 根 `tsconfig` MUST NOT include `client/`；表现层由 `tsconfig.client.json` + `npm run typecheck:client` 覆盖。
- 五道闸门 MUST 全绿：`npm test` · `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build`。

**Scale/Scope**:
- **HUD**：3 个组件（生命 / 冲刺 / 金币），常驻。
- **卡片**：3 张/次（沿用既有 draft 数量），覆盖 **5 个祝福**（`zeus_strike` / `dionysus_strike` / `poseidon_dash` / `hp_up` / `dash_up`）。
- **Tab 面板**：列表行 = 已拥有祝福数（0…5）。
- **覆盖层**：3 个既有表面统一皮肤。
- **新增资产**：5 个祝福图标 + HUD 面板/条/金币牌 + 3 张品质卡框 + Tab 面板框（≈ 12–16 个小尺寸九宫格/图标），体积预算在规划阶段重定（FR-053 / SC-016）。
- 明确**不在范围**：世界美术（M18 已交付）与音频（M16 已交付）保持现状。

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 判定 | 论证 |
|------|------|------|
| **I. 逻辑内核零浏览器依赖** | **PASS** | `src/` 改动文件数 = 0；全部 DOM/资产/皮肤落在 `client/` 与 `index.html`。 |
| **II. 确定性模拟** | **PASS** | 不改组件/系统/`World`/`snapshot()`；要求以固定种子 + 固定输入证明状态序列与快照摘要逐位不变（D10 / SC-008）；品质不消费随机（D2）。 |
| **III. 17 段固定管道** | **PASS** | 无段增删或重排；不新增事件，`createDefaultSystems` 签名不变。 |
| **IV. 测试先行与证据化验证** | **PASS（须落实）** | 性能用**比值**口径（D11）；`src/` 零改动用**摘要逐位**自证（D10），不靠「既有测试全绿」推断；`tests/ui/*` **只扩展不放宽**（D13）。 |
| **V. 表现层隔离** | **PASS（须落实）** | 全部改动在 `client/`；UI 仅经只读探针 / 事件总线读取（`contracts/readonly-probe-and-eventbus.md`）；`GameRenderer` 导入图不含 `howler`；过 `typecheck:client`。 |
| **VI. 既有核心不可重构** | **PASS** | 不重构组件/系统/预制体/管道；祝福目录仍以 `REWARD_POOL` 为唯一真源，UI 只读投影。 |

**闸门结论：PASS**（无未论证的违规）。Phase 1 设计完成后须**复核**一次（见文末）。

## Project Structure

### Documentation (this feature)

```text
specs/027-hud-boon-ui/
├── spec.md                       # 已冻结（/speckit.specify 产出）
├── plan.md                       # 本文件
├── research.md                   # Phase 0 产出：D1–D16 决策 + 风险登记
├── data-model.md                 # Phase 1 产出：8 个实体 + 校验规则
├── quickstart.md                 # Phase 1 产出：V1–V13 端到端验收剧本
├── contracts/                    # Phase 1 产出：接口契约
│   ├── ui-boon-data-table.md         # boons.json 形状 / 一致性 / 内核惰性 / 占位符
│   ├── readonly-probe-and-eventbus.md # 只读白名单 / 写黑名单 / 意图回传 / 无损义务
│   ├── hud-and-overlay-ui.md         # 冻结钩子 / 表面优先级 / HUD / 卡片 / Tab / 降级 / 可达性 / 源码扫描红线
│   └── ui-asset-slots.md             # --ui-* 槽位登记（既有保留 + 新增 14 槽）+ 体积子预算
├── design/                       # 成员专业交付物（非 speckit 标准件）
│   ├── engineering-architecture.md   # 技术总监：接入架构与测试改写方案
│   ├── ui-art-direction.md           # 美术总监：HD UI 美术规格（品质色 / 组件 / 图标 / 预算）
│   └── quality-and-verification.md   # 质量总监：测试策略与验收方案
├── checklists/
│   └── requirements.md           # 规格质量校验（已全部通过）
└── tasks.md                      # Phase 2 产出（/speckit.tasks，不由本命令创建）
```

### Source Code (repository root)

```text
# ── 冻结层：本特性改动文件数 = 0 ──────────────────────────────
src/                              # headless ECS 内核（17 段管道）
├── ecs/rewards/RewardPool.ts     # 祝福目录（唯一真源）—— 只读
├── ecs/components/{Health,DashStats,Modifier,StatusEffect}Component.ts  # 只读探针
└── ...                           # 一行不改

# ── 表现层：本特性的全部改动落点 ──────────────────────────────
client/
├── assets/boons.json             # 新增：表现层自有祝福元数据（品质 / 图标 / 描述模板）
├── ui/                           # 新增：纯表现层模型模块（无 DOM / 无 pixi / 无随机 ⇒ 可 node 单测）
│   ├── hud-model.ts              # HUD 视图模型派生（纯函数）
│   ├── quality.ts                # 品质枚举 + 色/纹样映射（纯函数）
│   ├── boon-presentation.ts      # 描述模板 + 只读数值注入 + 卡面视图（纯函数）
│   └── status-panel.ts           # Tab 面板视图模型（纯函数）
├── UIManager.ts                  # 扩展：DOM 装配（HUD 三组件 + 卡片三要素 + Tab 面板 + 覆盖层皮肤）
├── assets/
│   ├── manifest.ts               # 唯一引用点：扩充 ui.* 图标/框/条/面板
│   └── AssetCatalog.ts           # 逐条目降级（沿用）
├── main.ts                       # 装配：注入新 --ui-* 槽位、构造 UIManager
├── GameRenderer.ts               # 不动（世界美术）—— 导入图仍不含 howler
├── ClientEventBridge.ts          # 可选：HUD 瞬时反馈（不驱动状态）
└── GameLoop.ts / KeyboardInput.ts / AudioManager.ts / SaveStore.ts / VFXManager.ts

# ── 资产与皮肤 ───────────────────────────────────────────────
client/assets/boons.json          # 新增：表现层自有祝福元数据（内核不加载、结构性隔离）
assets/art/ui/                    # 扩充：祝福图标 + HUD 组件 + 品质卡框 + Tab 面板框
index.html                        # 皮肤：新增 --ui-* 槽位（默认 none ⇒ 纯 CSS 降级）

# ── 测试 ─────────────────────────────────────────────────────
tests/
├── ui/                           # 本特性主战场（既有断言零改动，仅追加）
│   ├── ui_skin.test.ts           # ⚠️ 冻结钩子：MUST 零改动通过
│   ├── text_readability.test.ts  # ⚠️ 冻结可读性：MUST 零改动通过
│   ├── boon-data.test.ts         # 新增：数据表一致性 / 内核惰性护栏
│   ├── boon_description.test.ts  # 新增：描述数值与逻辑层一致
│   ├── hud.test.ts               # 新增：HUD 三组件读数与边界
│   ├── status_panel.test.ts      # 新增：Tab 面板集合 / 空 / 大量 / 不暂停
│   └── ui_degradation.test.ts    # 新增：缺资产仍可用
├── render/                       # 零改动（DOM 方案不碰场景图）
└── ...                           # 其余（combat/ai/physics/core/...）零改动
```

**Structure Decision**:

沿用既有的**双层单仓库**结构，不新增项目、不新增构建目标：

- **冻结层 `src/`** —— 一行不改。所有「看起来需要改内核」的需求都在 `client/` 侧以**只读投影**解决：祝福目录继续以 `REWARD_POOL` 为唯一真源，品质/图标/描述由表现层数据表 + 只读数值注入派生，选择意图经组合根回传。
- **表现层 `client/`** —— 新增 `client/ui/` 承载纯逻辑模块（`BoonCatalog` / `describeBoon` / `hudView`），`UIManager.ts` 只做 DOM 装配与生命周期。模块划分使**纯函数可被 node 单测**（`UIManager` 本身无 node 单测，只能靠 `typecheck:client` + `build` 兜底）。
- **皮肤 `index.html`** —— 新增 `--ui-*` 槽位，**追加**不替换；默认 `none` 保证降级。
- **测试 `tests/ui/`** —— 既有 2 套件**零改动**通过；新增 5 套件覆盖数据表 / 描述 / HUD / 面板 / 降级。

## Complexity Tracking

> 本表登记**经规格显式授权的偏离**，以及需要用户/评审确认的影响面。

| 偏离 / 影响面 | 为何必要 | 更简单的替代为何被否决 |
|---|---|---|
| **新增 `client/assets/boons.json`**（本特性唯一的新数据文件，**表现层自有**） | 品质/图标/描述需要一个**声明式**来源（FR-034），而逻辑层无可承载它们的表（`REWARD_POOL` 只有 `{id,label}`）。置于 `client/` 之下还额外获得**结构性隔离**（内核引用它在路径语义上即不成立）。 | ① 扩展 `modifiers.json` ⇒ 需改 `src/data/schemas.ts`，**违反 `src/` 零改动**；② 硬编码进 UI ⇒ 违反 FR-034；③ 落 `assets/data/` ⇒ 只靠「别加进 `bundled.ts`」的**约定**，不如结构性隔离可靠。 |
| **新增 `--ui-*` 槽位**（HUD 条 / 品质卡框 / 面板框 / 图标） | 材质化 HUD 与品质卡片需要新的贴图槽；既有槽位不足以表达三色品质与三件 HUD 组件。 | 复用既有槽位 ⇒ 三色品质与 HUD 组件无法区分，FR-011/001 不成立。**追加而非替换**，冻结槽位名不变（FR-042）。 |
| **`tests/ui/*` 追加断言**（不改既有断言） | 新表面（HUD 三组件 / Tab 面板）需要新的契约断言；但既有钩子断言是 DOM 与测试的唯一契约。 | 改名或放宽既有断言 ⇒ 静默破坏选择器（D13 已否决）。**948 为下限**，只增不减。 |
| **`index.html` 的 `#gold` 内部结构改造**（id 保留，内容重构） | 现有 `#gold` 只是两行文本；材质化 HUD 需要在其内部承载三件组件。 | 删除 `#gold` 另建新元素 ⇒ 撞 `ui_skin.test.ts` 的 `id="gold"` 断言（FR-042）。**保留 id，改造内部**。 |

**无未论证的违规。** 本特性**无新增运行时依赖** ⇒ 技术栈条款无需修订；**无 `src/` 改动** ⇒ Principle I / III / VI 无偏离。

## Constitution Check（Phase 1 设计后复核）

*GATE: Phase 0 前已判定 PASS；此处为设计完成后的复核。*

| 原则 | 复核判定 | 复核依据（设计已定案） |
|------|---------|----------------------|
| **I. 逻辑内核零浏览器依赖** | **PASS** | 设计不含任何 `src/` 改动；`boons.json` 对内核惰性（`contracts/ui-boon-data-table.md` §5 护栏）。 |
| **II. 确定性模拟** | **PASS** | 品质不消费随机（D2）；描述数值只读注入、不参与模拟；无损用摘要 `f52dfdd4` 逐位自证（D10）。 |
| **III. 17 段固定管道** | **PASS** | UI 完全在 `step()` 之外；不新增事件、不改 `createDefaultSystems`。 |
| **IV. 测试先行与证据化验证** | **PASS** | 性能用**比值** ≤ 1.2（D11）；无损用**摘要逐位**（D10）；`tests/ui/*` 只扩展不放宽（D13）；校验在测试期、运行期降级（D15）。 |
| **V. 表现层隔离** | **PASS** | 依赖单向；UI 仅经只读探针/事件总线（`contracts/readonly-probe-and-eventbus.md`）；DOM 方案不碰渲染场景图（`contracts/hud-and-overlay-ui.md` §1）；过 `typecheck:client`。 |
| **VI. 既有核心不可重构** | **PASS** | 不重构组件/系统/预制体/管道；祝福目录仍以 `REWARD_POOL` 为唯一真源，UI 只读投影。 |

**闸门结论：PASS**（无未论证的违规）。**无新增运行时依赖** ⇒ 技术栈条款无需修订。

## 成员交付物汇编与裁定（Phase 1 · 主理人）

按工作室 SOP（Phase 4 预制作 · 并行 → 汇编），三位成员已交付专业产出，主理人做**一致性检查与裁定**：

| 成员 | 交付物 | 规模 |
|---|---|---|
| `engineering-lead`（技术总监 程基岩） | `design/engineering-architecture.md` | 424 行 |
| `art-director`（美术总监 林绘澄） | `design/ui-art-direction.md` | 457 行 |
| `quality-lead`（质量总监 严守真） | `design/quality-and-verification.md` | 359 行 |

### 主理人裁定（跨成员冲突与收口）

| # | 事项 | 裁定 | 依据 |
|---|---|---|---|
| **A1** | **`boons.json` 位置** | **`client/assets/boons.json`**（**修订原 D1** 的 `assets/data/boons.json`） | 技术总监与质量总监**独立收敛**到 client 自有目录；结构性隔离优于约定性保证 |
| **A2** | **HUD 的 DOM 承载** | `#hud` **保留为诊断块**；**新增 `#hud-material`** 承载材质 HUD（生命 + 冲刺）；`#gold` 复用为**材质金币牌**；三者明确分离（FR-005 / FR-007） | 两位成员**独立收敛**；5 个冻结 id **零删除** |
| **A3** | **HUD 瞬时反馈驱动** | 用**状态差分**（HUD 读数是每帧轮询的，事件桥每帧只被排空一次，不适合作 HUD 驱动）；事件桥**仅**作可选补充 | 采纳技术总监工程判断 |
| **A4** | **可测性硬前提** | 强制抽出**纯表现层模型模块** `client/ui/{hud-model,quality,boon-presentation,status-panel}.ts`（无 DOM / 无 pixi / 无随机） | 无 jsdom ⇒ 否则 FR-002/003/004/011/012/013/017/021/023/024/035 在 CI 覆盖为零 |
| **A5** | **三条源码扫描红线** | 已写入 [`contracts/hud-and-overlay-ui.md`](./contracts/hud-and-overlay-ui.md) §10 | `ui_skin.test.ts` / `text_readability.test.ts` 是**源码文本扫描**而非 DOM 测试 |
| **A6** | **UI 资产槽位** | 新增 **7 个**槽位（`--ui-frame-health` / `--ui-frame-dash` / `--ui-frame-boon-{common,epic,legendary}` / `--ui-panel-status` / `--ui-rule`），全部默认 `none`，既有槽位名不变；**U3 后无任何图标槽**；以 [`design/ui-art-direction.md`](./design/ui-art-direction.md) 附录 A 为唯一权威，登记于 [`contracts/ui-asset-slots.md`](./contracts/ui-asset-slots.md) | FR-042 / FR-050 |

### 用户已裁定（3 项 · 2026-10-03）

| # | 事项 | 裁定 |
|---|---|---|
| **U1** | 5 个祝福的**品质分配** | **采纳技术总监建议**：`zeus_strike`=Epic · `dionysus_strike`=Epic · `poseidon_dash`=**Legendary** · `hp_up`=Common · `dash_up`=Common |
| **U2** | **UI 资产体积预算** | **不设 UI 子预算** —— 仅受 M18 全局预算约束（单文件 ≤3 MiB / 总量 ≤12 MiB）；≈80 KB 估算仅作参考，**不落为断言** |
| **U3** | **图标形态** | **纯 CSS 占位，不新增图标资产** —— 取消全部 `--ui-icon-boon-*` 与 `--ui-boon-placeholder` 槽位；`boons.json` 的 `icon` 字段语义 = **CSS 字形 token** |

### 质量门判定

- **CONCERNS**（质量总监）：方案就绪，**待实现与实测**；全部门禁标注「待实现后复核」，**不预支通过**。
- **基线更正（重要）**：实测基线为 **948 例 = 947 通过 + 1 例负载敏感失败**（`tests/performance/stress.test.ts` G2，实测比值 22.76）。SC-009「948 例 100% 通过」的验收口径需据此明确：**该例为已知的机器负载敏感项**，判定应以「逻辑/玩法测试 100% 通过 + 该例在同机空载下复现通过」为准，而非硬性要求满载下恒绿。

## 生成物索引

| 产物 | 说明 |
|---|---|
| `spec.md` | 已冻结的特性规格（**6** 用户故事 · **39** FR · **16** SC） |
| `plan.md` | 本文件 |
| `research.md` | Phase 0：**16** 条决策（D1–D16，D1 已按成员复核修订）+ 风险登记（R1–R7） |
| `data-model.md` | Phase 1：**8** 个实体 · 校验规则 V1–V6 · 「不引入的数据」清单 |
| `contracts/ui-boon-data-table.md` | 数据表形状 · 与 `REWARD_POOL` 一致性 · 内核惰性护栏 · 占位符 |
| `contracts/readonly-probe-and-eventbus.md` | 只读白名单 / 写黑名单 · 意图回传 · 事件总线 · 无损义务 |
| `contracts/hud-and-overlay-ui.md` | 冻结钩子 · 表面优先级 · HUD / 卡片 / Tab / 降级 / 可达性 · **源码扫描红线** |
| `contracts/ui-asset-slots.md` | `--ui-*` 槽位登记（既有保留 + 新增 14 槽）· 体积子预算 |
| `quickstart.md` | V1–V13 端到端验收剧本 + 验收矩阵速查 |
| `design/engineering-architecture.md` | 技术总监交付物（424 行 · 已交付） |
| `design/ui-art-direction.md` | 美术总监交付物（457 行 · 已交付） |
| `design/quality-and-verification.md` | 质量总监交付物（359 行 · 已交付） |
| `tasks.md` | **61 个任务**（T001–T061 · 9 阶段）—— `/speckit.tasks` 产出，`/speckit.analyze` 后补全 5 条覆盖任务 |
