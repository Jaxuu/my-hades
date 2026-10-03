# Phase 0 · Research：决策与理由（M19 · `027-hud-boon-ui`）

> 本文件回答「技术上下文里的每个未知项各选了什么、为什么、否决了什么」。
> 规格见 [`spec.md`](./spec.md)；接口契约见 [`contracts/`](./contracts/)；实体见 [`data-model.md`](./data-model.md)。
> 三位成员的专业交付物见 [`design/`](./design/)（技术总监 / 美术总监 / 质量总监）。

## 0. 问题域

M19 要在**表现层**引入材质化 HUD、三选一祝福卡片与 Tab 局内状态面板，并统一既有覆盖层的视觉语言。三个硬约束支配了全部决策：

1. `src/` **改动文件数 = 0**（宪法 Principle V / VI；用户要求 4）；
2. 既有 **948 例测试 100% 通过**（用户要求 5）；
3. 品质 = **静态、声明式、纯外观**，禁改掉落算法、禁运行时生成（用户裁定）。

因此本阶段的中心问题是：**「品质 / 图标 / 数值化描述」这些新元数据放在哪里，才能既是数据驱动、又不触碰 `src/`？**

---

## D1 — 祝福元数据表的**位置**：`client/assets/boons.json`（新建，**表现层自有**）

> ⚠️ **本决策在 Phase 1 成员复核后修订**（原草案为 `assets/data/boons.json`）。两位成员（技术总监 / 质量总监）独立收敛到 **client 自有目录**，主理人采纳。

**Decision**：新建 `client/assets/boons.json`，作为**表现层自有、只读**的祝福元数据表（`rewardId → { rarity, icon, description }`）。逻辑内核**不加载、不校验、不感知**它。

**Rationale**：
- **结构性保证 > 约定性保证**：放在 `client/` 下，`src/` 想 import 它在**语义与路径上都说不通**；放在 `assets/data/` 下则只靠「别把它加进 `bundled.ts`」的约定。用户的核心硬约束是 `src/` 零污染，故取更强的结构隔离。
- 该表是**表现层元数据**（品质 / 图标 / 文案），**不是业务数值**——宪法「业务数值一律来自 `assets/data/*.json`」不适用于它；放 `client/` 反而更准确地表达了「这是 UI 元数据」。
- `client/assets/` 已在 `tsconfig.client.json` 的覆盖范围内，JSON import 由 `typecheck:client` 一并校验。
- `src/data/bundled.ts` 以**具名 `import`** 逐表加载、**不做目录枚举** ⇒ 即便留在 `assets/data/` 也惰性；迁移到 `client/` 只是把「惰性」从**运行时事实**提升为**结构性事实**。

**Alternatives considered**：
- `assets/data/boons.json`（原草案）：与既有数据表同目录，但只靠约定保证内核不加载。**修订为否决**（成员复核）。
- `client/boons/boons.json`（技术总监备选）：语义清晰，但新建一级目录、与既有 `client/assets/` 资产目录重复。**否决**。
- 直接扩展 `assets/data/modifiers.json` 加 `rarity`：① 该表被 `DataManager` 在 Bootstrap 期校验（`parseModifierConfig`），加未知字段需改 `src/data/schemas.ts` ⇒ **违反 `src/` 零改动**；② 它只覆盖 5 个祝福中的 2 个（`hp_up` / `dash_up` 根本不是 modifier，`dionysus_strike` 也没有条目）。**否决**。
- 把 rarity 硬编码进 `UIManager` 的渲染分支：违反 FR-034「必须来自声明式数据表」。**否决**。

**护栏（保留）**：新增测试断言 `src/**` **不** import `boons.json`，且 `src/data/bundled.ts` 的加载列表**不含**它（双重护栏，防未来误接）。

---

## D2 — 品质枚举与三色映射

**Decision**：`rarity ∈ { "common", "epic", "legendary" }` ↔ **蓝 / 紫 / 金**。默认值 `common`。品质**只**驱动卡片边框外观，不参与任何数值或随机。

**Rationale**：用户裁定「静态品质……Common=蓝, Epic=紫, Legendary=金」；FR-016 明确品质 MUST NOT 改变数值、掉落概率与抽取结果。

**Alternatives considered**：抽取时随机品质（Hades 式）——需要把品质抽取放进 `src/` 的种子随机（否则不可复现），与 `src/` 零改动直接冲突。**用户已否决**。

**护栏**：`src/ecs/rewards/RewardPool.ts::draftRewards` 与 `REWARD_POOL` 零改动；`boons.json` 不被任何逻辑层代码读取。

---

## D3 — 祝福图标：**纯 CSS 字形 / 形状**（用户裁定 U3 · 修订）

> ⚠️ **本决策在 Phase 1 用户裁定后修订**（原草案为 `ui.boon.<rewardId>` 位图资产）。

**Decision**：祝福图标 **不引入任何位图资产**。由 `client/assets/boons.json` 的 `icon` 字段承载一个 **CSS 字形 token**（如 `lightning` / `grape` / `trident` / `heart` / `boot`），经 `client/ui/boon-presentation.ts` 映射为**纯 CSS 字形或形状**渲染，默认 `◆`。

**Rationale**：
- 用户裁定「纯 CSS 占位，不新增图标资产」（U3）。
- 省去 5 个资产的制作与许可登记；与「品质色三层载体 + 品质 chip + 中文标签」的多通道辨识**互补**（形状是又一非颜色通道）。
- `icon` 字段仍**数据驱动**（FR-034），只是 token 语义从「资产 id」变为「CSS 字形」。

**Alternatives considered**：
- `ui.boon.<id>` 位图资产（原草案）—— 用户已否决（U3）。
- 引入 CC0 图标库 —— 额外许可登记 + 风格统一成本，亦被用户否决。

---

## D4 — 数值化描述的**防漂移**机制

**Decision**：`boons.json` 只存**描述模板**（含命名占位符），**数值本身不落进数据表**；表现层在渲染时从**逻辑层的唯一来源**只读注入：

| 祝福 | 数值来源（只读） | 描述示例 |
|---|---|---|
| `zeus_strike` | `DataManager.getModifierConfig('zeus_strike')` → `{damage:20, radius:1}` | 「攻击命中时在目标处引发 20 点雷电伤害」 |
| `poseidon_dash` | `DataManager.getModifierConfig('poseidon_dash')` → `{damage:5, radius:3, knockbackForce:40}` | 「冲刺时在原地引发冲击波，造成 5 点伤害并击退 40」 |
| `dionysus_strike` | `POISON_STATUS_SPEC`（`src/ecs/components/StatusEffectComponent.ts`）→ `{damagePerStack:4, intervalTicks:30, maxStacks:5, durationTicks:120}` | 「命中使目标中毒：每 0.5 秒每层 4 点伤害，最多 5 层，持续 2 秒」 |
| `hp_up` | `HP_UP_AMOUNT`（`RewardPool.ts`）= 20 | 「生命上限 +20」 |
| `dash_up` | `DASH_UP_COOLDOWN_REDUCTION`（`RewardPool.ts`）= 10 | 「冲刺冷却 -10 帧（下限 10）」 |

**Rationale**：用户示例「30 点雷电伤害」与真实数值（`zeus_strike` = **20**）不符，恰恰说明**描述数值必须派生自逻辑层**，否则会写出玩家可验证的谎言。FR-014 / SC-004 要求一致率 100%。

**Alternatives considered**：
- 把数值抄进 `boons.json`：灵活但会**漂移**（改平衡表后卡面变假）。**否决**（除非该数值在逻辑层无导出，见下）。
- 把描述也放进 `src/`（如扩展 `RewardDefinition`）：需要改 `src/`。**否决**。

**注**：`modifiers.json` 的 `damage` 是**每次命中**的伤害；`dionysus_strike` 无 modifier 条目，其数值在 `POISON_STATUS_SPEC`。两者都是 `src/` 已导出的只读面，client 可单向 import（宪法 Principle V 允许 `client → src`）。

---

## D5 — HUD 的实现载体：**DOM / CSS**（不进入 Pixi 场景图）

**Decision**：生命 / 冲刺充能 / 金币三件 HUD 组件以 **DOM + CSS** 实现，作为 `#ui-layer` 之外的常驻 HUD 层，由 `UIManager` 扩展驱动。

**Rationale**：
- 既有 HUD 已经是 DOM（`#gold` / `#hud`），且 `index.html` 的 `--ui-*` 皮肤机制与 48×48 九宫格 `border-image` 全是 CSS 资产；沿用即零成本复用 M16 皮肤契约。
- **关键**：DOM 层**不进 Pixi 场景图**，因此**完全不触碰渲染场景图的 6 条冻结契约**（`camera.children` 长恰 1 / `fxLayer.children` 长恰 0 等）——这些契约由 node 渲染套件逐字钉死，任何常驻 Pixi 节点都可能撞坏它们。
- `#hud` / `#gold` 是 `tests/ui/ui_skin.test.ts` 冻结的 id；DOM 方案可**原地改造其内部结构**而不丢 id。
- 免去在渲染层重建一套 UI 框架（文本框 / 布局 / 九宫格）的巨大成本。

**Alternatives considered**：
- **Pixi 内绘制**（`Graphics`/`Sprite` 进 `stage`）：会新增常驻场景图节点 ⇒ 撞 6 条冻结契约，需惰性挂载或补显式同步钉桩；且要自建布局与文本渲染。**否决**。
- **混合**（HUD 用 DOM，卡片用 Pixi）：徒增两套坐标与输入系统，收益为零。**否决**。

---

## D6 — HUD 承载元素与冻结钩子的关系

**Decision**：保留 `#gold` 与 `#hud` 两个**既有 id**（`ui_skin.test.ts` 冻结）。`#gold` 改造为**玩家面向 HUD 容器**（内含生命 / 冲刺 / 金币三个子组件）；`#hud` 保留为**诊断块**（`main.ts` 的 tick/hp/counts 读数），二者**明确分离**（FR-007），不产生重复读数。

**Rationale**：冻结 id 必须保留（FR-042）；把玩家 HUD 与诊断块分开，避免「两处都显示血量且不一致」的混乱。

**Alternatives considered**：删除 `#hud` 诊断块——会破坏 `ui_skin.test.ts` 的 `id="hud"` 断言，且诊断块对调试有价值。**否决**（保留）。

---

## D7 — Tab 局内状态面板：`#ui-layer` 的新皮肤 `is-status`，**非阻塞**

**Decision**：Tab 面板复用既有 overlay root `#ui-layer`，新增皮肤 class `is-status`（**追加**，不替换任何冻结钩子），内容 = 已拥有祝福列表。Tab 监听生命周期严格受控（沿用 `UIManager` 现有的 `handleHubKey` 模式：仅在激活时挂载、退出即移除）。

**Rationale**：用户裁定「不暂停·纯覆盖层」；FR-022 / SC-006 要求「面板开/关两条轨迹逐 Tick 一致」——即面板**不得**影响 `sim.step`。`#ui-layer` 已是「至多一个表面在屏」的互斥容器，天然满足 FR-026。

**Alternatives considered**：独立 overlay 元素——与 `#ui-layer` 的互斥语义重复，且增加场景图/DOM 复杂度。**否决**。

---

## D8 — 既有覆盖层统一：沿用 `--ui-*` 槽位

**Decision**：死亡 / 胜利 / 营地覆盖层继续使用 `--ui-overlay-death` / `--ui-overlay-win` / `--ui-panel-camp` 等既有槽位，替换为同一 HD 语言的新贴图；`is-death` / `is-win` / `is-hub` 钩子与交互契约（`R` 回营地 / 购买天赋 / 开始逃离）**零改动**。

**Rationale**：FR-040 / FR-041；钩子被 `ui_skin.test.ts` 冻结，语义不得变。

---

## D9 — 降级契约：`--ui-*` 默认 `none` ⇒ 纯 CSS

**Decision**：全部新增 UI 贴图仍经 `--ui-*` 自定义属性注入，默认值 `none`。任一资产缺失 / 解码失败时，表面回退到纯 CSS 表现（FR-050 / SC-010）。

**Rationale**：沿用 M16 既有降级契约与 `AssetCatalog` 的逐条目降级；这是 `src/` 零改动前提下的「不崩溃」保障。

---

## D10 — 无损证明：快照摘要**逐位**自证

**Decision**：以固定种子 + 固定输入序列，用 `listEntities() × listComponents()` 拼串过 FNV-1a 得到摘要，要求改动前 / 改动后**逐位相同**（基线 `f52dfdd4`）。

**Rationale**：宪法 Principle IV 明文要求；M15 实测过「634 例全绿但摘要变了」的假阴性。「既有测试全绿 ≠ 无损」。

**Alternatives considered**：仅靠既有测试通过来推断无损——已被 M15 证伪。**否决**。

---

## D11 — 性能验收：**比值**口径 ≤ 1.2

**Decision**：复用 `production/m18-probe.mjs`，同机 / 同场景 / 同一脚本下比较每帧耗时**中位数**的「改动后 / 改动前」比值 ≤ 1.2（连续 3 次取中位数）。

**Rationale**：宪法 Principle IV 禁用绝对墙钟阈值（CI 负载可漂 2 倍）；M18 已确立该口径（实测中位数 0.970）。

---

## D12 — 依赖集合不变

**Decision**：`client/` 的运行时依赖集合保持 `{pixi.js, howler}`，**不新增**任何依赖。

**Rationale**：FR-030 的等价约束（本特性为 UI 重构，不需要新运行时）；宪法「技术栈与架构约束」。

**Alternatives considered**：引入 UI 库（React/Vue）或动画库（GSAP）——违背零新增依赖，且与 DOM/CSS 方案相比收益不成比例。**否决**。

---

## D13 — 测试处置：`tests/ui/*` **扩展**而非放宽

**Decision**：`tests/ui/ui_skin.test.ts` 与 `tests/ui/text_readability.test.ts` 的**既有断言零改动**（10 class + 5 id + M16 钩子 + 无网络字体 + 中文回退）；本特性**新增**断言与**新增**套件。948 例为**下限**。

**Rationale**：FR-042 / FR-055；冻结钩子是 DOM 与测试之间的唯一契约，改名会静默破坏选择器。

**注**：若实现确需变更某个冻结钩子，MUST 在本规格 / 计划中**显式登记**（沿用 M18 的 DEV 登记惯例）。

---

## D14 — 色觉障碍：品质**多通道编码**

**Decision**：品质不仅用颜色区分，另叠加**边框纹样 / 角标 / 文字标签**等非颜色通道。

**Rationale**：Edge Cases 末条与 SC-014；蓝 / 紫 / 金在红绿色盲下区分度不足。多通道使品质在不依赖颜色时仍可辨。

---

## D15 — 数据表的一致性校验（防悬空 id）

**Decision**：新增一条测试，断言 `boons.json` 的 id 集合 **恰好覆盖** `REWARD_POOL` 的全部 id（无悬空、无缺失）。运行期若某 id 缺元数据，卡片降级（默认品质 + 占位图标 + 安全描述），**不崩溃**（FR-035 / FR-017）。

**Rationale**：`REWARD_POOL` 是逻辑层的**唯一**祝福目录；数据表必须与它对齐。校验放在**测试期**（而非运行期），因为 `step()` 内禁止校验抛错（宪法「技术栈与架构约束」）。

**Alternatives considered**：运行期读取 `REWARD_POOL` 并断言——`REWARD_POOL` 是 `src` 导出的 `const`，client 可只读 import，但**抛错**会违反「UI 不得让游戏崩溃」；故改为测试期校验 + 运行期降级。**否决**运行期抛错。

---

## D16 — 描述模板的占位符机制

**Decision**：`boons.json` 的 `description` 为**模板字符串**，以 `{name}` 形式引用逻辑层数值键（如 `"攻击命中时在目标处引发 {damage} 点雷电伤害"`）；表现层用一个**纯函数**把逻辑层数值注入模板。模板缺少所需键时降级为不含数值的安全描述。

**Rationale**：把「文案」与「数值」解耦，使文案可编辑而不引入第二份数值来源（FR-014 / FR-034）。纯函数便于单测。

**Alternatives considered**：为每个祝福写死完整描述（含数值）——即 D4 的漂移风险。**否决**。

---

## 风险登记（Phase 0）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **描述数值漂移**（卡面与真实效果不符） | 单一来源只读注入（D4）+ 逐祝福一致性测试（SC-004） |
| R2 | **体积预算**被新增 HD UI 资产挤压 | 规划阶段重定预算（单文件 / 总量），以构建产物实测（SC-016）；沿用 M18 的许可与体积登记表 |
| R3 | **冻结钩子**被重构误删 / 改名 | 以 `tests/ui/ui_skin.test.ts` 锁定；变更必须显式登记（D13） |
| R4 | **色觉障碍**下品质不可辨 | 多通道编码（D14） |
| R5 | **Tab 监听泄漏**（终局/营地残留监听） | 沿用 `handleHubKey` 的「激活即挂载、退出即移除」生命周期（D7）+ 专项测试 |
| R6 | **`boons.json` 未来被接入 `bundled.ts`** 而改变内核 | 护栏测试断言 `src/**` 不 import 该文件（D1） |
| R7 | **主观 SC**（视觉观感）无法自动化 | 真浏览器截图 + 像素判据自动化可测部分；需人类观察者的部分显式登记 **PENDING** |

---

## 待办 —— **已全部闭合**（2026-10-03 复核）

- ✅ **新增 UI 资产的体积预算**：用户裁定 **U2 = 不设子预算**，沿用既有全局预算（单文件 ≤ 3 MiB / 总量 ≤ 12 MiB）。图集形态见 `design/ui-art-direction.md` 附录 A 与 [`contracts/ui-asset-slots.md`](./contracts/ui-asset-slots.md) §5。
- ✅ **5 个祝福的品质分配**：用户裁定 **U1 = 采纳技术总监建议** —— `zeus_strike`=Epic · `dionysus_strike`=Epic · `poseidon_dash`=Legendary · `hp_up`=Common · `dash_up`=Common。
- ✅ **新增测试套件的文件清单与断言要点**：已由质量总监交付（`design/quality-and-verification.md` S1–S10），并落入 [`tasks.md`](./tasks.md)。
