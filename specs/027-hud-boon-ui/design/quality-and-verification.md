# M19 · 测试策略与验收方案（quality-and-verification）

**特性**：UI 层重构：材质化 HUD 与祝福交互面板 · `specs/027-hud-boon-ui/spec.md`
**里程碑**：M19 ｜ **任务**：M19-T01-QA ｜ **作者**：quality-lead（严守真）
**日期**：2026-10-03 ｜ **状态**：待评审（advisory 门控）

---

## 0. 基线与口径（先钉死，后面全部引用）

| 项 | 值 | 来源 |
|---|---|---|
| 测试运行器 | Vitest 2.1.8 · `pool:'threads'` · `environment:'node'`（**无 jsdom**） | `vitest.config.ts` |
| 当前总数 | **948 例 / 62 套件**（947 通过 + 1 已知负载敏感失败） | 本次实测 `npx vitest run` |
| 已知失败 | `tests/performance/stress.test.ts` G2（墙钟缩放比 `<9`，本次实测 22.76） | M18 已登记（S3），**非本特性缺陷** |
| 无损摘要 | `f52dfdd4`（seed `0x12345678`，601 tick，FNV-1a over `listEntities()×listComponents()`） | `production/m18-baseline.md` §2 |
| 性能口径 | 比值（改动后/改动前，同机同场景 3 次中位数 ≤ 1.2），**禁绝对墙钟** | 宪法 Principle IV / FR-056 |
| 逻辑内核 | `src/` 改动文件数 = 0；管道恒 17 段 | 宪法 Principle V / VI |

### 0.1 计数口径（948 为下限的判定规则）

- **N = Vitest 报告的 `Tests` 行**（每个 `it` / `it.each` 的一行 = 1 例；`describe` 不计数）。
- 基线 **N₀ = 948**。本特性要求 **N ≥ 948**（FR-055 / SC-009）。
- **只增不减**：`tests/ui/ui_skin.test.ts`（21 例）与 `tests/ui/text_readability.test.ts`（9 例）的**既有用例一行都不得删除或减少**；新增断言只能以**新 `it` 块**加入。
- 若某既有断言确需**改写**（本方案的目标是**零改写**），MUST 先在 `spec.md` FR-042 显式登记，并在验收报告里逐条列出「改前 / 改后」。
- ⚠️ `it.each` 的每一行算一例：给 `FROZEN_CLASSES` 增项会让计数上升（安全），**删项**会让计数下降（禁止）。

### 0.2 本项目特有的测试陷阱（本方案每条断言都必须规避）

| 陷阱 | 规则 | 本方案的落地 |
|---|---|---|
| **恒真断言** | `字段 === 构造它的那个常量` 恒真 ⇒ 必须另配**字面量钉桩**或**行为断言** | 见 §7 检查表；核心在「描述数值」用**行为断言**（真打一次、量真实掉血）而非读回自己写的字段 |
| **状态被设置 ≠ 效果被施加** | 断言「挂上了 `zeus_strike`」不等于「引发了 20 伤害」 | `boon_description_truth` 必须真的落一次命中并断言目标 hp 下降量 |
| **反空真** | 断言「什么都没有」前，先断言「曾经有过」 | 空面板断言前先断言非空场景存在；摘要相等前先断言世界非空 |
| **浮点** | 位移/比例容差 `1e-9`，**禁**严格相等 | 生命比例、冲刺进度一律 `toBeCloseTo(x, 9)` |
| **无损 ≠ 全绿** | M15 实测「全绿但摘要变了」 | 无损只用**摘要逐位自证**（§4），不用「套件全绿」 |
| **性能** | 禁绝对墙钟（CI 负载漂 2×） | 只用缩放比（§5） |
| **变异实验** | 门控改动必须「破坏→确认失败→**从备份逐字节还原**」，**禁 `git checkout --`** | §3 |
| **枚举单位** | 遍历战斗单位必须显式排玩家；尸体不销毁 ⇒ 存活数断言必须过滤 `isDead` | 伤害/存活断言按此写（§7） |
| **`client/UIManager.ts` 无 node 单测** | 无 jsdom ⇒ 只能 source-string 断言 + `typecheck:client` + `vite build` 兜底 | §2 架构前提 + §6 真浏览器兜底 |

---

## 1. 冻结 vs 可更新清单

> 判定原则：**既有冻结钩子与既有断言 MUST 零改动**；**新增只能以新断言/新 `it` 块加入**。
> 两张「脆弱耦合」表列出**容易在重构中被无意破坏**的断言，engineering-lead MUST 逐条守住。

### 1.1 `tests/ui/ui_skin.test.ts` —— MUST 零改动（21 例）

| # | 断言（原文摘要） | 类别 | 冻结理由 / 重构红线 |
|---|---|---|---|
| F1 | `it.each(FROZEN_CLASSES)` × **10**：`is-visible` / `is-death` / `is-win` / `is-hub` / `reward-button` / `talent-button` / `start-button` / `hub-currency` / `hub-talents` / `death-hint` 同时出现在 `index.html`（`.class`）**与** `UIManager.ts`（字面量） | class 钩子 | **HD 重皮不得改名/删除**。`UIManager` 源码 MUST 仍字面包含这 10 个字符串 |
| F2 | `it.each(FROZEN_IDS)` × **5**：`id="app"` / `id="ui-layer"` / `id="hud"` / `id="gold"` / `id="keys"` | 元素 id | 新 HUD MUST **复用** `#gold` 或**新增独立 id**，MUST NOT 删除这 5 个 |
| F3 | M16 钩子 × 6：`ui-card` / `ui-hint` / `ui-currency` / `ui-list` / `ui-button-primary` / `ui-heading` 同时在两侧存在 | M16 皮肤 | MUST 保留；新钩子以**新 `it`** 追加，**不改此 `it`** |
| F4 | 原生按钮：`UIManager.ts` 中 `document.createElement('button')` 匹配数 **≥ 3** | 可达性 | ⚠️**脆弱耦合**：正则只认**单引号字面量**。若重构把建按钮抽成 `el('button')` 助手，此断言会失败 ⇒ **UIManager MUST 保留 ≥3 处字面 `document.createElement('button')`** |
| F5 | 焦点环：`index.html` 含 `:focus-visible` **且** 匹配 `/outline:\s*3px/` | 可达性 | MUST 保留；新可交互元素 MUST 纳入同一焦点环规则 |
| F6 | `UIManager.ts` **不含** `pixi.js` / `Container` / `Graphics` | 场景图隔离 | ⚠️**硬红线**：HD HUD **必须是 DOM**，MUST NOT 迁入 Pixi 场景图（否则撞 F1–F6 场景图契约） |
| F7 | 9 个 `--ui-*` 槽位变量存在（`--ui-panel-hud` … `--ui-bar-hud`） | 资产槽 | MUST 保留；**新增槽位允许**（只增） |
| F8 | `--ui-[a-z-]+:\s*none;` 匹配数 **≥ 11** | 降级默认值 | 只增不减；新增槽位 MUST 仍默认 `none`（降级路径） |
| F9 | `index.html` 含 `image-rendering: pixelated` | 皮肤 | MUST 保留 |

### 1.2 `tests/ui/text_readability.test.ts` —— MUST 零改动（9 例）

| # | 断言 | 冻结理由 / 红线 |
|---|---|---|
| T1 | `index.html`（去 CSS 注释后）**不含** `@font-face` | 新 CSS MUST NOT 引入任何网络字体 |
| T2 | 不含 `.woff/.woff2/.ttf/.otf/.eot` 扩展名 | 同上 |
| T3 | `it.each(CJK_FAMILIES)` × 3：`PingFang SC` / `Microsoft YaHei` / `Noto Sans CJK SC` | 中文回退栈 MUST 保留 |
| T4 | `--font-(body\|mono)` 栈**恰为 2 个**且各以 `sans-serif`/`monospace` 结尾 | ⚠️**脆弱耦合**：`stacks.length === 2` 精确。**新 UI MUST NOT 新增任何 `--font-*` 变量**（否则计数变 3 而失败） |
| T5 | 中文文案存在：`移动`/`攻击`/`冲刺`/`回营地` | MUST 保留（这些是「栈是承重的」证据，删了断言会空转） |
| T6 | 调色板变量：`--parchment`/`--gold`/`--blood`/`--stone-dark` | MUST 保留；品质三色 MUST 新增变量（见 §2），**不改这 4 个** |
| T7 | `#hud, #keys, #gold {` 共享规则块含 `background-repeat: no-repeat` 与 `image-rendering: pixelated` | ⚠️**脆弱耦合**：正则要求 `#hud, #keys, #gold {` **连续且同序**。MUST NOT 在此三选择器之间插入新选择器 |

### 1.3 MAY 扩展（两个套件均可，但只以新增方式）

- **允许**：在两个文件末尾追加新的 `describe` / `it` 块（例如 M19 的新钩子存在性、新 CSS 无网络字体、新按钮纳入焦点环）。
- **允许**：`ui_skin.test.ts` 新增一个 `it` 断言 M19 新钩子（`boon-card` / `boon-rarity-*` / `status-panel` / `hud-*` 等）同时出现在两侧。
- **禁止**：修改 F1–F9 / T1–T7 的**任何一行**；删除任何 `it.each` 行。

### 1.4 可更新集（授权改动，需在验收报告登记）

`tests/ui/*` **新增文件**（§2）不受冻结约束；若因实现细节确需**改写**既有 UI 断言，走 `spec.md` FR-042 登记流程。**本方案的验收目标 = 两个既有文件 `git diff` 为空 + 新增文件净增用例。**

---

## 2. 新增测试套件设计

### 2.0 可测性架构前提（MUST，交 engineering-lead 落地）

> 无 jsdom ⇒ `UIManager` 的 DOM 分支**不可在 node 单测**。若把全部逻辑塞进 `UIManager` 的 DOM 分支，则 FR-002/003/004/011/012/013/017/021/023/024/035 全部只能靠真浏览器，CI 覆盖为零。
>
> **强制要求**：把**纯表现层模型**抽成**无 DOM、无 Pixi 的纯函数模块**（落在 `client/`，符合 Principle V），`UIManager` 只做「读模型 → 写 DOM」的哑胶水。建议文件：
>
> - `client/ui/hud-model.ts` —— `buildHudView(readonly inputs) → { hp, hpRatio, dashState, dashProgress, gold, texts }`
> - `client/ui/quality.ts` —— `qualityColor(rarity) → string`（三色字面量）+ `DEFAULT_QUALITY`
> - `client/ui/boon-presentation.ts` —— `buildBoonCard(id, logicNumbers) → { rarity, color, iconToken, description }`（`iconToken` = **CSS 字形 token**，非资产 id，见 U3）
> - `client/ui/status-panel.ts` —— `buildStatusPanel(ownedIds) → { entries, isEmpty, scrollable }`
>
> 这些模块**只读**、**不消费随机**、**不 import pixi.js**（否则撞 F6）。它们让本节的绝大多数断言在 node 下可执行。
> 数据表：建议 `client/assets/boons.json`（表现层只读，**不被 `src/data/bundled.ts` 具名 import**）。表内**只放 `rarity`/`icon`（= CSS 字形 token，U3）/描述**模板**（带数值占位符）**，数值一律**只读派生**自逻辑层。

### 2.1 套件清单

| # | 文件 | 覆盖 FR / SC | 类型 | 关键断言要点 |
|---|---|---|---|---|
| S1 | `tests/ui/hud_model.test.ts` | FR-002/003/004 · SC-001 | 真 `GameSimulator` + 纯模型 | 读数正确性与边界（见下） |
| S2 | `tests/ui/hud_persistence.test.ts` | FR-005/006/007 · SC-001 | source-string | HUD 常驻/写-变更/与诊断分离 |
| S3 | `tests/ui/boon_presentation.test.ts` | FR-011/012/013/017/034 · SC-002/003 | 纯模型 + 表 | 三要素 + 品质色映射 + 降级 |
| S4 | `tests/ui/boon_description_truth.test.ts` | FR-013/014 · SC-004 | **真 sim 行为断言** | 描述数值 == 逻辑真实数值 |
| S5 | `tests/ui/status_panel_model.test.ts` | FR-021/023/024 · SC-005 | 纯模型 + 真 sim | 集合一致性 + 空/大量 |
| S6 | `tests/ui/tab_no_pause.test.ts` | FR-022 · SC-006 | **真 sim 逐 Tick** | 面板开/关轨迹逐 Tick 一致 |
| S7 | `tests/ui/boon_table_integrity.test.ts` | FR-030/031/035/036 · SC-003/007 | 表 + 常量 | 防悬空 id + 品质静态 + `src/` 不加载 |
| S8 | `tests/ui/ui_degradation.test.ts` | FR-050 · SC-010 | `AssetCatalog` 注入坏 loader | 逐 id 降级、游戏可用 |
| S9 | `tests/ui/ui_accessibility.test.ts` | FR-051/052 · SC-011/015 | source-string | 无网络字体 + 键盘可达 |
| S10 | `tests/ui/ui_skin.test.ts`（**追加**） | FR-042 · SC-012 | source-string | M19 新钩子存在（**只增 `it`**） |

### 2.2 S1 `hud_model.test.ts` —— HUD 三组件读数与边界

- **生命**：真 sim 起玩家 → `applyDamage` 一个已知 N → step → 模型 `hp` 与组件 `hp` 一致（`toBe`），`hpRatio ≈ hp/maxHp`（`toBeCloseTo(…,9)`）。**行为断言**：掉血后读数随之下降（不是读回自写常量）。
- **边界 hp=0**：把 hp 打到 0 → `hpRatio === 0`，有限、无负数、无反向条（`hpRatio ∈ [0,1]`）。
- **边界 maxHp=0**：构造 `maxHp=0` 的 `HealthComponent`（POD，允许）→ `hpRatio` 有限（`Number.isFinite`）、`∈[0,1]`，**不得 NaN/Infinity**（除零护栏）。
- **冲刺可用/冷却**：`cooldownRemaining=0` ⇒ `dashState==='ready'`、`dashProgress===1`；`cooldownRemaining===cooldownTicks` ⇒ `'cooling'`、`progress===0`；中值 ⇒ 分数进度（`toBeCloseTo`）。**行为断言**：真 `startDash` 后 `cooldownRemaining>0` 且读数从 ready 翻到 cooling。
- **金币极值**：`gold=0` 与 `gold=9999`（真钱包写入）→ 文本不含 `e`/`NaN`、不截断、可读（长度合理）。
- **反空真**：断言「金币为 0」前，先断言「曾有过 >0」（先拾取再加/减）。

### 2.3 S2 `hud_persistence.test.ts`（source-string）

- HUD 在覆盖层分支**之前**且**无条件**更新（`syncHud(world)` 是 `sync` 首行调用）。
- 存在**写-变更**护栏（`renderedHud` 比较 + early return）⇒ FR-006 无闪烁。
- HD HUD 与诊断 `#hud` 是**不同元素**、读不同数据（FR-007）；`#gold` 仍存在或被新 HUD 取代且无重复读数。
- 新 HUD 模块**不含** `pixi.js`（FR-054 场景图隔离）。

### 2.4 S3 `boon_presentation.test.ts` —— 卡片三要素与品质色

- **完备**：每个 `REWARD_POOL` id 都能构造出卡片（`icon` + `rarity` + `description`）。
- **品质色映射（字面量钉桩）**：`qualityColor('Common'|'Epic'|'Legendary')` 返回**三个字面量颜色**，且**两两不同**（`new Set([...]).size === 3`）——避免「映射 == 构造它的常量」恒真。
- **品质分配（字面量钉桩，U1）**：`id → rarity` 映射 MUST 等于 **zeus_strike=Epic / dionysus_strike=Epic / poseidon_dash=Legendary / hp_up=Common / dash_up=Common**（测试读 `boons.json` 与**测试内字面量表**两个独立来源比对，非恒真）。三种品质**均出现**（Common×2 / Epic×2 / Legendary×1）⇒ SC-003 三色在出厂池内可测。
- **图标（U3 · 纯 CSS 字形，非资产）**：`icon` 字段语义 = **CSS 字形 token**；断言每个 token ∈ **已知字形集合**——字面量钉桩 `{zeus_strike:'↯', dionysus_strike:'☣', poseidon_dash:'◎', hp_up:'♥', dash_up:'»'}`（默认 `◆`）；测试读 `boons.json` 与**测试内字面量表**两个独立来源比对（非恒真）。**MUST NOT** 断言 ∈ `MANIFEST_IDS`（图标不再是资产）。
- **降级（FR-017）**：缺 `rarity`/`icon`/`description` ⇒ 返回**默认品质外观 + 占位 CSS 字形 + 安全描述**，`MUST NOT` 抛错/空串。
- **数据驱动（FR-034）**：`UIManager.ts` 渲染分支**不含** `rarity` 字面量（品质来自表，不是渲染分支硬编码）。

### 2.5 S4 `boon_description_truth.test.ts` —— 描述数值 == 逻辑真实数值（核心，反恒真）

**双通道，缺一不可：**

- **通道 A（字面量交叉校验）**：从每张卡片的描述里解析出的数字，必须等于**逻辑层来源**：
  - `zeus_strike` 伤害 == `modifiers.json.zeus_strike.damage`（20）；
  - `poseidon_dash` 伤害 == `modifiers.json.poseidon_dash.damage`（5）、击退 == `knockbackForce`（40）；
  - `hp_up` == `HP_UP_AMOUNT`（20，`src` 导出常量）；
  - `dash_up` == `DASH_UP_COOLDOWN_REDUCTION`（10，`src` 导出常量）。
  - ⚠️ 直接 `entry.n === HP_UP_AMOUNT` 若 `n` 本就由 `HP_UP_AMOUNT` 赋值则**恒真** ⇒ 通道 A 必须**读 JSON 与导出常量做两个独立来源比对**，且描述文本由**模板 + 逻辑注入**生成，测试断言**最终字符串**含该数字。
- **通道 B（行为断言，最强）**：真 sim 授予 `zeus_strike` → 驱动一次**会命中**的攻击 → 断言目标 hp 下降量 == 描述中的 N。`hp_up` → 授予后 `maxHp` 增量 == 描述中的 N。`poseidon_dash` → 进入冲刺 → 观测冲击波击退 == 40。
- **反空真**：比对掉血前先断言**目标确实掉了血**（`hpBefore > hpAfter`），否则「下降量 == N」在 0==0 时空转。
- **浮点**：伤害为整数用 `toBe`；任何比例用 `toBeCloseTo(…,9)`。

### 2.6 S5 `status_panel_model.test.ts` —— Tab 面板集合一致性 + 空/大量

- **一致性（FR-023/SC-005）**：真 sim 用 `addModifier`/`grantReward` 授予 N 个 → `buildStatusPanel(ownedIds)` 的条目 id 集合 **恰好等于** 已拥有集合（顺序稳定：按 id 升序）。
- **空状态（FR-024）**：零祝福 ⇒ `isEmpty===true` 且给出**明确空态**（非空串/非报错）。
- **大量（FR-024）**：50 个条目 ⇒ 全部返回、`scrollable===true`、无截断。
- **每条含品质+图标（CSS 字形）+描述**（FR-021）：复用 S3 的卡片构造。

### 2.7 S6 `tab_no_pause.test.ts` —— Tab 不改变模拟（逐 Tick）

- 两条**相同 seed + 相同输入**的轨迹：A 不加面板；B 在若干 tick 之间反复 `togglePanel()`（纯表现层开关，**签名不含 `World`/`GameSimulator`**）。
- 断言：**逐 Tick 快照摘要完全相同**（差异处数 = 0）。复用 §4 的 FNV-1a `digest`。
- **反空真**：先断言 `tick === TICKS` 且 `entityCount > 0`（世界确实在推进），否则「两条都空」会假通过。
- **结构断言**：`togglePanel` / 面板模块**不 import** `GameSimulator`/`World`，源码不含 `.step(` / `inject(` / `addComponent(`（把「不暂停」从结构上锁死）。

### 2.8 S7 `boon_table_integrity.test.ts` —— 表 ↔ `REWARD_POOL`（防悬空）

- **无缺失**：`set(boons.json 键) ⊇ set(REWARD_POOL.id)`。
- **无悬空**：每个 `boons.json` 键 ∈ `REWARD_POOL` id 集合（反向也成立 ⇒ 恰好相等）。
- **`src/` 不加载**：`boons.json` 未被 `src/data/bundled.ts`（或任何 `src/**`）具名 import（FR-030/036）；`src/` 不感知该表。
- **品质静态（FR-016/031）**：固定 seed 的抽取结果 == 已知 id 序列（品质不参与抽取）；`boons.json` 的 `rarity` 是**字面量**，不含计算/随机表达式。

### 2.9 S8 `ui_degradation.test.ts` —— 缺资产仍可用

- `AssetCatalog` 注入「只坏一个 HD UI 资产」的 loader ⇒ `degradedIds()` **恰好**为那一个，其余 ready。
- 降级下**卡片/面板模型仍产出可用结果**（回退外观），游戏不崩。
- 源码：`--ui-*` 默认 `none` 的纯 CSS 回退路径仍在（与 F8 呼应）。

### 2.10 S9 `ui_accessibility.test.ts` —— 可读性/可达性

- 新增 CSS **无** `@font-face`、无字体文件扩展；新文本使用 `var(--font-body)`。
- 新可交互元素是**真 `<button>`**，且被 `:focus-visible` + `outline: 3px` 覆盖。

### 2.11 S10 —— 追加到 `ui_skin.test.ts`（只增 `it`）

- 新钩子（如 `boon-card`、品质类、`status-panel`、`hud-*`）在 `index.html` 与 `UIManager.ts` **两侧**存在。
- 断言「新增而非替换」：10 个冻结 class + 5 个 id + 6 个 M16 钩子**仍在**（与 F1–F3 同源，作为 M19 视角的复核）。

---

## 3. 变异实验方案（门控点，宪法 Principle IV）

> 统一流程：**① 备份原文件 → ② 临时破坏 → ③ 跑目标套件确认预期断言确实失败（记录失败用例名与条数）→ ④ 从备份逐字节还原（`cmp` 校验）**。
> **禁止 `git checkout --` / `git restore`**（会掩盖「未提交改动」的风险）。

| # | 门控点 | 破坏方式 | 预期失败的断言 | 还原方式 |
|---|---|---|---|---|
| M1 | **品质色映射** | 令 `qualityColor()` 恒返回 Common 的颜色（忽略 `rarity`） | `boon_presentation.test.ts` 的「三色两两不同」+ Epic/Legendary 映射字面量断言 | 备份 `client/ui/quality.ts` → `cmp` 逐字节还原 |
| M2 | **描述数值来源** | 在 `boons.json` 把 `zeus_strike` 描述改成「999 点」（制造第二份漂移数值） | `boon_description_truth.test.ts` 通道 A（交叉校验）失败；若同时改渲染分支硬编码则通道 B 也失败 | 备份 `boons.json` → `cmp` 还原 |
| M3 | **Tab 不暂停** | 令 `togglePanel()` 内部调用 `sim.step(1)`（或注入一个输入） | `tab_no_pause.test.ts` 逐 Tick 摘要不一致（差异 > 0） | 备份面板模块 → `cmp` 还原 |
| M4 | **降级回退** | 令缺失 `rarity/icon` 的分支**抛错**（去掉 fallback） | `boon_presentation.test.ts` 的 FR-017 降级断言 + `ui_degradation.test.ts` 失败 | 备份 `boon-presentation.ts` → `cmp` 还原 |
| M5 | **冻结钩子存活** | 把 `UIManager.ts` 的 `is-death` 改名 `is-gameover` | `ui_skin.test.ts` 的 F1 `it.each` 对应行失败（证明冻结契约是**活**的） | 备份 `UIManager.ts` → `cmp` 还原 |

**收尾**：`grep -rn "MUTATION" client/` 无残留；备份目录清理；实验记录写入验收报告（含失败用例名/条数/`cmp` 结果）。

---

## 4. 无损证明（快照摘要逐位自证）

**判据**：固定 seed `0x12345678`、601 tick，对 `listEntities() × listComponents()` 拼串过 FNV-1a，**改前 == 改后 == `f52dfdd4`**，逐位相同。

**两层证据：**

1. **既有套件零改动且通过**（首选，成本最低）：
   - `tests/harness/render_art_lossless.test.ts`（已钉 `f52dfdd4`）与 `tests/harness/camera_zoom_lossless.test.ts`（已钉 `f52dfdd4`）——M19 MUST **一行不改**且继续通过。
   - 这两个套件已在 M18 每次运行时打印摘要字面量，是「摘要未漂移」的现成守卫。
2. **独立一次性脚本**（复核，防「套件被无意改动」）：复刻 M15/M18 口径——

```js
// production/m19-digest.mjs（一次性工具，验收后归档/删除）
// FNV-1a over listEntities() × listComponents()，seed 0x12345678，601 tick。
// 期望：改前 digest === 改后 digest === 'f52dfdd4'
const SEED = 0x12345678, TICKS = 601;
function digest(sim) {
  let hash = 0x811c9dc5;
  const feed = (t) => { for (let i = 0; i < t.length; i++) { hash ^= t.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; } };
  const ids = sim.world.listEntities();
  feed(`${ids.length}|`);
  for (const id of ids) { feed(`${id}:`); feed(sim.world.listComponents(id).join(',')); feed(';'); }
  feed(`tick=${sim.tick}`);
  return hash.toString(16).padStart(8, '0');
}
// buildStressRun() 同 render_art_lossless.test.ts；runScript 同（每 37 tick 攻击一次）
```

**结论判定**：`before === after === 'f52dfdd4'` ⇒ 无损 PASS。若不等 ⇒ **FAIL（阻塞）**，即便 948 例全绿也不放行（M15 教训）。

---

## 5. 性能比值验收（缩放比，禁绝对墙钟）

| 口径 | 工具 | 判据 |
|---|---|---|
| Node 侧渲染成本 | `tests/performance/render_art_cost.test.ts`（交错比值：同机/同场景/同脚本） | 连续 **3 次中位数 ≤ 1.2** |
| 浏览器侧每帧 | `production/m18-probe.mjs`（复用，5 视口 + 压测房） | 改动后/改动前每帧耗时中位数 **≤ 1.2** |

- **预期**：M19 只加 DOM（HUD 写-变更、Tab 面板仅在打开且内容变化时重建），Pixi 场景图**零新增节点** ⇒ 比值应 ≈ 1.0。
- **护栏**：若比值 > 1.2，优先怀疑「每帧无条件重建 HUD/Tab DOM」⇒ 回落到写-变更/按需重建。
- **口径纪律**：绝对 ms 仅记录参考，**不作为放行依据**（宪法 Principle IV）。

---

## 6. 真浏览器视觉验收

**工具**：复用 `production/m18-probe.mjs` 的 CDP + 缓存 Chromium + **真实时间**（`--virtual-time-budget` 无法完成异步启动 + rAF，M17/M18 教训）。跨极端尺寸**每视口独立重载**。截图落 `production/m19-shots/`。

### 6.1 视口矩阵

| 视口 | 用途 |
|---|---|
| 1920×1080 / 2560×1440 | 常规桌面 |
| 3840×1080（32:9） / 1080×1920（9:16） | 极端宽高比 |
| 800×600 | 小视口（HUD/卡片不溢出） |

### 6.2 截图判据（可自动化部分）

| 判据 | 机器方法 | 对应 SC |
|---|---|---|
| **品质三色可区分** | 采样三张卡片边框像素，断言三色两两 ΔRGB > 阈值（且各自接近声明色） | SC-003/SC-014（客观部分） |
| **HUD 非纯文本** | 截图 HUD 区域颜色方差 > 阈值（有材质/条/底纹），且 `#hud` 诊断文本块与之分离 | SC-001（客观部分） |
| **卡片三要素可见** | 卡片区域存在：**CSS 字形前景像素**（非空 / 包围盒非退化，U3 无图标 PNG）、品质边框色、描述文本行（非空） | SC-002（客观部分） |
| **覆盖层统一语言** | death/win/camp 三态截图的调色板与卡片/HUD 同族（色相接近），death↔win 明显两极 | SC-012 类（客观部分） |
| **焦点环可见** | `Tab` 聚焦到卡片按钮 → 截图 → 断言出现 `outline` 金色像素 | SC-015 |
| **零外部请求** | 观测请求全部本地/`data:`/`blob:` | SC-011 |
| **零 pageerror** | 控制台无 `[exception]` | 稳定性 |

### 6.3 需人类观察者的部分（**登记 PENDING**）

| SC | 主观部分 | 机器可判部分（已完成） | 状态 |
|---|---|---|---|
| SC-001 | 「1 秒内正确读出、正确率 100%」的**可读性**观感 | HUD 非纯文本、读数与逻辑一致 | **PENDING（需 ≥1 名人类观察者）** |
| SC-002 | 卡片「精美」与三要素**一眼可辨** | 三要素在像素上均存在 | **PENDING** |
| SC-014 | 「仅凭外观区分蓝/紫/金正确率 ≥ 90%」 | 三色像素两两可区分 | **PENDING** |
| SC-016 | 资产体积「符合预算」的**视觉无退化** | 体积仅受 M18 既有全局预算约束（**U2：不设 UI 子预算**） | **PENDING** |

> **纪律**：机器结果**不冒充**主观通过；PENDING 项如实标注，不得以客观部分代替主观结论。

---

## 7. 恒真断言与反空真检查表（逐条自查）

| 断言（本方案） | 恒真风险 | 规避手段 |
|---|---|---|
| `entry.rarity === 'Common'` | 若 `rarity` 由同一常量赋值 ⇒ 恒真 | 改为**字面量钉桩**（三色 hex 两两不同）+ 映射函数**行为**断言 |
| `card.n === HP_UP_AMOUNT` | 若 `n` 源于 `HP_UP_AMOUNT` ⇒ 恒真 | 通道 A 读 **JSON + 导出常量两个独立来源**；通道 B **真打一次量掉血** |
| `panel.entries.length === owned.length` | 若两者是同一数组引用 ⇒ 恒真 | 断言**集合相等**（排序后逐项）+ 用真 sim 授予后**独立读取** |
| `hpRatio === hp/maxHp` | 同式重算 ⇒ 恒真 | 用**已知伤害**驱动（掉血 N 后比例 = (maxHp−N)/maxHp），并 `toBeCloseTo(…,9)` |
| `dashProgress === 1 − rem/cool` | 同式重算 ⇒ 恒真 | 钉 `rem=0⇒1`、`rem=cool⇒0` 两个**字面量边界** |
| 「面板为空」 | 空真（从未有过） | **反空真**：先断言「曾拥有若干」（非空场景存在）再断言空态 |
| 「两条轨迹摘要相同」 | 两条都空 ⇒ 假通过 | **反空真**：先断言 `tick===TICKS ∧ entityCount>0` |
| 「目标掉血 == N」 | 0==0 空转 | **反空真**：先断言 `hpBefore > hpAfter` |
| 存活/伤害枚举 | 玩家被算入 / 尸体未过滤 | 显式**排除玩家**；存活数断言**过滤 `isDead`** |
| 比例/进度浮点 | 严格相等误判 | 一律 `toBeCloseTo(x, 9)` |

---

## 8. 风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **source-string 测试脆弱**（`ui_skin` 风格：正则/字面量耦合） | 重构易误伤、维护成本高 | ① 优先抽**纯模型模块**（§2.0）把断言从字符串移到行为；② 字符串断言只用于「钩子存活」这类真契约；③ 红线（F4 单引号 `createElement('button')`、T4 `--font-*` 恰 2 个、T7 三选择器连续）写入 engineering-lead 交接单 |
| R2 | **计数口径变化**：新增套件抬高 N（安全），但若误删既有用例会跌破 948 | 门禁失败 | ① 两个既有 UI 文件 `git diff` 必须为空；② 验收报告显式列出 N（改前/改后） |
| R3 | **新增套件加剧 `stress.test.ts` G2 墙钟 flaky**（M17 教训：新套件曾使其失败 4/5） | 门禁红 | ① `vitest.config.ts` 已限 `maxThreads`（保留）；② 新套件保持**短足迹**（无损套件只跑一次，复用已钉摘要字面量）；③ 该失败为**既有已知**，验收报告需区分「功能缺陷」与「负载敏感」 |
| R4 | **主观 SC 无法自动化**（SC-014 及 SC-001/002 观感） | 无法给出机器通过 | 如实登记 **PENDING（需人类观察者）**，不冒充 |
| R5 | **描述数值漂移**（表现层复制数值） | SC-004 失效 | 单一来源（只读派生）+ 通道 A/B 双证（§2.5） |
| R6 | **品质被卷入随机/数值** | FR-016/031 失效、摘要漂移 | `boon_table_integrity` 断言固定 seed 抽取不变 + 品质字面量静态；摘要 `f52dfdd4` 守卫 |
| R7 | **冻结钩子被改名** | `ui_skin` 静默失败 | F1–F3 字面量守卫 + M5 变异实验证明守卫是活的 |
| R8 | **数据表被 `src/` 加载** | 违反 FR-030/036 | `boon_table_integrity` 断言 `src/**` 不 import `boons.json`；`typecheck` + `lint` 单向依赖门兜底 |

---

## 9. 质量门判定（advisory）

| 门 | 判据 | 状态 |
|---|---|---|
| 冻结套件零改动 | `tests/ui/{ui_skin,text_readability}.test.ts` `git diff` 为空 | 待实现后复核 |
| 用例总数 | `N ≥ 948`（只增不减） | 待实现后复核 |
| `src/` 零改动 | `git diff --stat -- src/` 空、管道 17 段 | 待复核 |
| 无损 | 摘要 `f52dfdd4` 逐位相同 | 待复核 |
| 性能 | 比值中位数 ≤ 1.2 | 待复核 |
| 五道闸门 | `test`/`typecheck`/`typecheck:client`/`lint`/`build` 全绿（G2 flaky 单列） | 待复核 |
| 变异实验 | M1–M5 均「破坏→失败→逐字节还原」 | 待执行 |
| 主观 SC | 登记 PENDING | 待人类观察 |

**当前判定**：**CONCERNS（方案就绪，待实现与实测）** —— 策略与断言已可执行，但所有门均为「待实现后复核」，不得预支通过。

---

## 10. 交接清单（Handoff）

**→ engineering-lead（MUST）**
1. 抽纯模型模块 `client/ui/{hud-model,quality,boon-presentation,status-panel}.ts`（无 DOM、无 pixi、无随机）——这是 CI 覆盖的前提（§2.0）。
2. 守红线：`UIManager.ts` 保留 ≥3 处字面 `document.createElement('button')`（F4）；**不新增 `--font-*` 变量**（T4）；`#hud, #keys, #gold {` 保持连续同序（T7）；HD HUD **保持 DOM**、不 import `pixi.js`（F6）。
3. 新增数据表**不被 `src/**` import**（FR-030/036）；数值**只读派生**自 `modifiers.json` / `src` 导出常量，表只放模板 + 占位符。
4. `togglePanel()` 签名**不含** `World`/`GameSimulator`，内部**不调** `step`/`inject`/写 API（FR-022/033）。

**→ art-director（MUST）**
1. 品质三色须为**可像素区分**的蓝/紫/金（SC-003/014），并在 `index.html` 以**新 CSS 变量**声明（不改 `--parchment/--gold/--blood/--stone-dark`）。
2. 卡片三要素（品质边框 + **纯 CSS 字形图标**（U3）+ 数值描述）在视口矩阵下均可见、不溢出。
3. 新 UI 资产本地分发（外部请求 0）；体积仅受 M18 既有全局预算约束（**U2：不设 UI 子预算**）。

**→ team-lead**
- 落盘路径：`specs/027-hud-boon-ui/design/quality-and-verification.md`
- 关键判定：见 §9（当前 CONCERNS，全部门待实测）
- 待用户审批：`boons.json` 路径裁定（建议 `client/assets/boons.json`）、主观 SC 的人类观察者安排。（体积子预算已由 **U2** 裁定取消；品质分配已由 **U1** 裁定；图标已由 **U3** 裁定为纯 CSS 字形。）

---

## 11. 与 art-director 对齐的落地补充（2026-10-03）

> 来源：`specs/027-hud-boon-ui/design/ui-art-direction.md`（509 行）+ 双向对齐消息。本节为**已达成一致的裁定**，覆盖 §2/§6 的相应开放项。

### 11.1 品质三色与判据

- **三色（art §2.3.1）**：Common `#3f6ea8` / Epic `#8a5cd0` / Legendary `#ffcd4a`；**新增** `--rarity-common|epic|legendary`（+`-bright`/`-deep`），**只增不改**；不动 `--parchment/--gold/--blood/--stone-dark`。
- **SC-003 客观判据（像素）**：对每张卡片**边框区域**采样，取**中位数** RGB（抗 AA/纹理），**排除**文字与图标内部；断言三色**两两欧氏 ΔRGB ≥ 60** **且** **max-channel Δ ≥ 50**。
  - 实测三色两两欧氏 ΔRGB：Common↔Epic **86.9** / Epic↔Legendary **210.7** / Common↔Legendary **233.9**（最小对余量 1.4×）。
  - ⚠️ **禁用「逐通道最小值」判据**：Common↔Epic 的 **G 通道仅差 18**，逐通道最小值会误判为「不可区分」。
  - **独立精确校验（source-level，与像素判据互为独立证据）**：`index.html` 三个 `--rarity-*` 声明值 == 三字面量 hex，且两两不同。
- **非颜色通道（色觉障碍 Edge Case / SC-014 缓解）**：每个品质 MUST 另有**颜色以外的判别线索**（中文品质标签 / 角标 pips / 边框纹样），并以钩子暴露（`boon-rarity-{common|epic|legendary}` 或文本标签）；`ui_skin` 扩展 MUST 断言其**存在**（否则色盲缓解为空口承诺）。

### 11.2 ✅ 风险已闭合：品质色三层载体（art §2.4）

`border-image-source` 非 `none` 时 `border-color` **不绘制**（白描框会盖住品质色）⇒ 品质色改为**三层独立载体**，前两层**恒绘制、恒可采样、与 border-image 无关**：

| 载体 | CSS | 受 border-image 影响 | 可采样 |
|---|---|---|---|
| ① 外层 3px 品质环 | `box-shadow: 0 0 0 3px var(--rarity-<q>), 0 0 14px var(--rarity-<q>-glow)` | 否（绘在 border box 之外） | ✅ **主锚点** |
| ② 品质 chip 背景 | `background: var(--rarity-<q>)` | 否 | ✅ 实心块 |
| ③ 每品质专属框体图 | `border-image-source: var(--ui-frame-boon-<q>)`（品质色**烘进线描**，非纯白描） | 是（色已在图内） | ✅ |

- **降级**：③ 缺失 ⇒ `border-image-source: none` ⇒ `border-color: var(--rarity-<q>)` **正常绘制**实心品质边框（M16 降级路径保持）。
- **采样纪律**：MUST **不取**「框体图覆盖的边框区」（白描/品质线描），取 **① 外层 3px 环** 或 **② chip 背景块**（干净实心、无文字）。
- 新增 `--ui-frame-boon-<q>` 槽位只**增加** F8 的 `none` 计数（安全）；`--rarity-*` 既非 `--ui-*` 也非 `--font-*`（不触 F8 / T4）。

### 11.3 HUD 结构裁定（Q3 = 方案 b）

- `#hud`（冻结 id）**保留为既有诊断块**、元素不动；
- 材质 HUD 用**新 id `#hud-material`**（生命条 + 冲刺环），与诊断块读不同数据、视觉分离 ⇒ 直接满足 **FR-007**（无重复/矛盾读数）；
- `#gold`（冻结 id）**复用**为材质金币牌，读**同一钱包值**、**无第二份读数**。
- 结论：F2 的 5 个冻结 id **零删除**；FR-005 常驻、FR-007 分离均成立。

### 11.4 新钩子（供 §2.11 追加 `it`）

`#hud-material` · `hud-health` / `hud-dash` / `hud-gold` · `boon-card` · `boon-rarity-*` · `status-panel` · `status-row` · `status-empty`（art 附录 A）。§2.11 的追加 `it` MUST 同时断言这些钩子在 `index.html` 与 `UIManager.ts` **两侧**存在，且 10 冻结 class + 5 冻结 id + 6 M16 钩子**仍在**。

### 11.5 视口自适应（art §4.5）

- 卡片 `width: clamp(160px, 22vw, 200px)` + `aspect-ratio: 5/7` + `flex-wrap`；面板 `max-width: min(720px, 94vw)` + `max-height: 92vh` + `overflow: auto`；字号下限恒定（clamp 只作用于容器）。
- **判据**：任一视口 `scrollWidth ≤ clientWidth`，且卡片不被 `#keys`/HUD 遮挡（800×600 下三卡 3×160+2×24=528px < 800，横排可容）。

### 11.6 体积（U2：不设 UI 子预算）

- **用户裁定（U2）**：**不设 UI 子预算**。体积仅受 M18 既有全局预算断言约束（`licenses.test.ts` 的 `MAX_FILE_BYTES=3MiB` / `MAX_TOTAL_BYTES=12MiB`）。**MUST NOT 新增任何体积上限 `it`。**
- **可选防空转**（若 engineering-lead 认为需要）：改为**新 UI 资产的存在性 / 非空**断言（`assets/art/ui/**` 的框体文件存在且非零字节），**MUST NOT** 是体积上限断言。
- UI 纹理保持 `nearest`，**不入** `HD_WORLD_ART_IDS`。

### 11.7 采样区域 / 阈值（art §2.4.1，`production/m19-probe.mjs` 编码依据）

| 判据 | (a) 采样元素 / 包围盒 | (b) 排除 | (c) 统计量 | (d) 阈值 |
|---|---|---|---|---|
| 品质边框色（主） | `.boon-rarity-<q>` 卡片**外扩 3px 品质环**（取环内侧 1–2px 实心带） | 文字 / 图标 / 内层白描 / **glow 衰减** | 中位数 RGB | 两两欧氏 ΔRGB ≥60 **且** max-channel Δ ≥50；各色对声明 hex ±25/通道 |
| 品质色（交叉验证） | `.boon-rarity-tag` chip **背景块**（内缩 2px 避圆角/AA） | chip 内文字 | 中位数 RGB | 同上 |
| 图标存在（U3 纯 CSS 字形） | `.boon-icon` 包围盒 | 卡片背景 | **字形前景像素占比 / 非空 / 包围盒非退化** | 前景占比 ≥5% 且包围盒 > 0（**不假设图标 PNG**） |
| 描述存在 | `.boon-desc` 行包围盒 | 图标 / 边框 | 非背景文本行数 | ≥1 行 |
| 材质 HUD | `#hud-material` 包围盒 | — | 颜色方差 / 色簇数 | ≥3 色簇 |
| 品质标签 | `.boon-rarity-tag` textContent | — | 字面量 | ∈{普通,史诗,传说} |

- **⚠️ glow 采样纪律**：`box-shadow` 第二段 `0 0 14px` 是**渐变光晕** ⇒ 采样 MUST 只取**内 1–2px 实心环带**，否则中位数被衰减污染。
- 采样统一用**中位数**（抗 AA / 纹理 / 文字混入），且像素判据与 §11.1 的 source-level 精确校验**互为独立证据**。

### 11.8 非颜色通道（色觉障碍 / SC-014 缓解，机器可断言）

art §2.2 / 附录 A 以**类钩子**暴露，均**不依赖颜色**、`grayscale(1)` 下仍可分：

| 钩子 | 断言 |
|---|---|
| `.boon-rarity-tag` | `textContent ∈ {普通,史诗,传说}`（三者互异） |
| `.boon-pips` | 子元素数 **1 / 2 / 3** |
| `.boon-icon-frame--square\|--cut\|--crown` | 类名互异（直角 / 切角 / 切角+冠冕） |

- **机器证明（主，确定性）**：DOM 层断言上述钩子的 `textContent` / 子元素数 / 类名（source + 浏览器 `textContent`），**完全不依赖颜色**。
- **机器证明（次，抗干扰）**：浏览器加 `filter: grayscale(1)` 截三卡，断言**非颜色区域**（tag / pips / 角框）仍两两可区分。
- 结论：SC-014 的色盲缓解**从口头承诺升级为可断言性质**（写入 S3 / S9 与 §6.2）。

### 11.9 体积断言（U2 裁定：撤销子预算）

- **用户裁定（U2）**：**撤销**原「新增 256 KB / 512 KB 体积 `it` 到 `licenses.test.ts`」的方案。**不新增任何体积上限断言。**
- **体积约束来源**：仅 M18 既有全局预算（`licenses.test.ts`：单文件 ≤3 MiB / 总量 ≤12 MiB）——**保持零改动**。
- **可选（若 engineering-lead 认为需要防「空转」）**：改为**UI 资产存在性 / 非空**断言（新框体文件存在且非零字节），**MUST NOT** 为体积上限。此项由 engineering-lead 决定是否加，非强制。

### 11.10 三项用户裁定（U1 / U2 / U3）对齐记录（2026-10-03）

| 裁定 | 内容 | 对本方案的影响 |
|---|---|---|
| **U1** | 品质分配：`zeus_strike`=Epic · `dionysus_strike`=Epic · `poseidon_dash`=Legendary · `hp_up`=Common · `dash_up`=Common | §2.4 S3 新增「品质分配字面量钉桩」；三种品质**均出现**（Common×2 / Epic×2 / Legendary×1）⇒ SC-003 三色在出厂池内可测；同品质同屏（zeus+dionysus）靠**图标/名称**区分（Edge Case） |
| **U2** | **不设 UI 子预算** | §11.6 / §11.9 撤销体积 `it`；体积仅受 M18 既有全局预算约束；防空转改「存在性 / 非空」（**非体积上限**） |
| **U3** | 图标 = **纯 CSS 占位**，不新增图标资产 | §2.0 / §2.4 S3 / §6.2 / §11.7 的「图标」全部改为 **CSS 字形 token**：`boons.json.icon` 语义 = 字形 token（非资产 id），断言对**已知字形集合**（`↯ ☣ ◎ ♥ »` + 默认 `◆`）而非 `MANIFEST_IDS`；`--ui-icon-boon-*`（5）与 `--ui-boon-placeholder` 槽位**取消**；降级回退**默认字形 `◆`** |

**维持不变**：三层载体采样锚点（§11.2）· grayscale 非颜色断言（§11.8）· 非颜色通道机器化 · 描述数值双通道校验（§2.5）。
