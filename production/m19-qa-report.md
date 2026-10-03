# M19 · 独立质量门报告（T052 / T053 / T055 / T058 · 独立复核）

**特性**：`specs/027-hud-boon-ui`（M19 · UI 层重构：材质化 HUD + 三选一祝福卡片 + Tab 状态面板 + 覆盖层统一）
**执行者**：主理人游承峰（原派 `quality-lead`，其因**模型侧 429 频率限制**在动手前失败，任务由主理人接管）
**基线**：`8606ca5`（M18）· 工作树含 M19 全部改动（未提交）
**日期**：2026-10-03

---

## 0. 最终判定

| 项 | 判定 |
|---|---|
| **M19 质量门** | **PASS（带 1 项 CONCERNS + 1 项既有缺陷登记）** |
| CONCERNS | SC-001 / SC-002 / SC-014 / US5 视觉统一的**主观部分**需 ≥1 名人类观察者，如实登记 **PENDING**，不预支通过 |
| 既有缺陷（**非 M19 引入**） | 页面出现一个视口高度的滚动条：PixiJS canvas 池在 DOM 中留下第二个 `position: static` 的裸 `<canvas>`。**已用 M18 基线 A/B 实测证伪「M19 引入」**，详见 §5 |
| 本次新发现并修复的 M19 缺陷 | `--ui-frame-dash` 槽位**只声明、只注入、资产已产出，但全仓库无任何 CSS 消费它**（T021 未落地）⇒ 已修复 + 补守卫断言，详见 §4 |

---

## 1. 五道闸门（独立复跑，非采信工程侧自报）

| # | 闸门 | 命令 | 结果 |
|---|---|---|---|
| 1 | 全量测试 | `NO_COLOR=1 npx vitest run` | **82 套件 / 1133 例全过，失败 0** |
| 2 | 类型检查 | `npm run typecheck` | **PASS**（无输出） |
| 3 | 表现层类型检查 | `npm run typecheck:client` | **PASS**（无输出） |
| 4 | Lint | `npm run lint` | **PASS**（无告警） |
| 5 | 构建 | `npm run build` | **PASS**（`✓ built in 11.01s`） |

**基线对照**：M18 基线 **948 例**（947 通过 + 1 例负载敏感失败）⇒ 现 **1133 例**（**+185**），满足 SC-009「≥948」。

### 1.1 负载敏感项的独立处置（不采信、不掩盖）

`tests/performance/stress.test.ts` G2 是 M15 引入的**绝对墙钟**缩放断言（阈值 `ratio < 9`）。

| 运行条件 | 结果 |
|---|---|
| 与全量套件并行（机器满载） | **1 例失败**：`expected 9.1734 to be less than 9` |
| **单独空载复跑**（`npx vitest run tests/performance/stress.test.ts`） | **5/5 通过**，实测 `ratio = 6.82` |

**结论**：该例为**既有负载敏感项**，非 M19 缺陷，**未修改、未放宽**。这也是工程侧「1126 通过 / 0 失败」与主理人首轮「1125 通过 / 1 失败」的唯一差异来源（同一套件、不同机器负载）。

---

## 2. 结构性硬约束复核

| 约束 | 判据 | 实测 |
|---|---|---|
| **`src/` 零改动**（SC-007） | `git status --short -- src/` / `git diff --stat -- src/` | **均为空**；另有 `tests/ui/ui-purity.test.ts` 的 `src/**` 85 文件 SHA-256 指纹 `27ec06ea…d8f` 守卫 |
| **无新增运行时依赖** | `package.json` dependencies | 恰为 `{howler ^2.2.4, pixi.js ^8.21.0}` |
| **17 段管道不变** | `toHaveLength(17)` 钉桩 | 命中 `meta_progression` · `tilemap_and_topology` · `aoe_and_lifecycle` · `advanced_ballistics` · `walls_and_projectiles` · `economy_and_victory` · `ui-purity` 共 **7 处**，段数与顺序未变 |
| **无损摘要**（SC-008） | 固定种子 601 tick，FNV-1a over `listEntities() × listComponents()` | **`f52dfdd4` == 基线**（`lossless_m19` 实跑输出，非仅读断言） |
| **性能比值**（SC-013） | 同机同场景，改动后/改动前每帧中位数 | **0.782 ≤ 1.2**（多轮 0.8–1.15）；**未使用绝对墙钟阈值** |
| **既有 UI 断言零改动** | `git diff --numstat -- tests/ui/ui_skin.test.ts tests/ui/text_readability.test.ts` | **+105 / −0**（只增不删，21 + 9 例既有断言逐字保留） |
| **冻结钩子零删除** | 10 class + 5 id + 6 M16 钩子 | 全部在 `index.html` 与 `client/UIManager.ts` 中存在 |

### 2.1 三条源码扫描红线（独立 grep，非复述）

| # | 红线 | 命令 | 实测 |
|---|---|---|---|
| R-a | `client/UIManager.ts` ≥3 处字面 `document.createElement('button')`（单引号） | `grep -c "document.createElement('button')"` | **3** ⇒ PASS |
| R-b | 不新增任何 `--font-*` | `grep -oE -- "--font-[a-z]+:" index.html` | 恰 **`--font-body:` / `--font-mono:`（2 个）** ⇒ PASS |
| R-c | `#hud, #keys, #gold {` 连续同序；`#hud-material` **不得**插入该选择器列表 | 多行正则 `#hud,\s*#keys,\s*#gold\s*\{` | 命中 `index.html:117-119`；`#hud-material` 为**独立声明**（`:455`）⇒ PASS |

---

## 3. T055 · 变异实验（M1–M6）

**纪律**：每次「破坏 → **确认对应断言真的失败** → **从快照逐字节还原** → sha256 校验」。**未**使用 `git checkout --` / `git restore` / `git stash`。
**驱动**：`production/m19-mutation-run.py`（一次性工具）· **日志**：`production/m19-mutation-log.md` · **快照**：`production/m19-mutation-backup/`

| # | 破坏点 | 守卫测试 | 断言是否失败 | 还原逐位一致 |
|---|---|---|---|---|
| **M1** | 品质 → class 映射塌缩（`RARITY_CLASSES.epic` → common 类名） | `tests/ui/boon-card.test.ts` | **是（断言有效）** | 是 |
| **M2** | 描述数值脱离逻辑层（`zeus_strike` 的 `damage` 硬编码 999） | `tests/ui/boon-description.test.ts` | **是（断言有效）** | 是 |
| **M3** | Tab 面板获得通往模拟的通道（`togglePanel` 签名加 `world` 形参） | `tests/ui/status-panel-nopause.test.ts` | **是（断言有效）** | 是 |
| **M4** | 降级回退被移除（品质卡片实心品质边框 → `transparent`） | `tests/ui/ui_degradation.test.ts` | **是（断言有效）** | 是 |
| **M5** | 面板集合不一致（`readOwnedBoonIds` 只返回第一个） | `tests/ui/status-panel.test.ts` | **是（断言有效）** | 是 |
| **M6** | 槽位只声明不消费（`.hud-dash` 不再引用 `var(--ui-frame-dash)`） | `tests/ui/ui_degradation.test.ts` | **是（断言有效）** | 是 |

**结果：6/6 全部被断言捕获，6/6 全部逐字节还原成功**（实验后全量 sha256 与快照一致，`all_restored=True`）。

> **M6 是本报告 §4 缺陷的守卫回归**：它证明新增的「每个 M19 槽位都必须被消费」断言**真的会失败**，而不是一条恒真断言。

> **实验过程中的一次自我修正（如实记录）**：M4 首轮锚点含换行，而 `index.html` 为 **CRLF** 行尾，导致锚点未命中、变异**未被应用**。已改为单行锚点并重跑；同时把「锚点未命中」与「断言无效」在日志中**分开报告**，避免把未执行误读为通过。

---

## 4. 主理人发现并修复的缺陷：`--ui-frame-dash` 未被消费

### 4.1 缺陷
`--ui-frame-dash` 在 `index.html:47` 声明（默认 `none`）、在 `client/main.ts:297` 注入、在 `manifest.ts` 注册 `ui.frame.dash`、资产 `assets/art/ui/frame-dash.png` 已产出 —— 但**全仓库没有任何 CSS 规则引用 `var(--ui-frame-dash)`**。冲刺组件实际由 `.hud-dash-ring` 的 `conic-gradient` 绘制。即：**T021 明确要求的「`--ui-frame-dash` 九宫格 `border-image`」未落地，该槽位与资产是死代码**。

工程侧证据 `production/m19-evidence.md` §7 讨论了 `frame-health`/`frame-dash` 字节相同导致的构建去重，**但未披露该槽位从未被消费**。

### 4.2 修复
`index.html` 的 `.hud-dash` 补齐九宫格外框（`border-width: 8px` / `border-image-slice: 12` / `border-image-source: var(--ui-frame-dash)`），与 `.hud-health` 同族；资产缺失时回退实心石色边框（FR-050 降级路径不变）。

### 4.3 守卫
`tests/ui/ui_degradation.test.ts` 新增一组断言：**每个 M19 槽位都必须在样式表里被 `var(...)` 引用**（+7 例）。这类缺陷此前对全部既有断言**完全隐形** —— 声明在、注入在、资产在、测试全绿，唯独画面里没有。

> ⚠️ **同类既有问题（**不在 M19 范围**，如实登记不擅自修）**：M16 遗留槽位 `--ui-frame-slot` 与 `--ui-frame-slot-inlay` 同样未被任何规则消费。因超出 M19 交付边界，**未改动**，仅登记为后续清理项。

---

## 5. T052 · 真浏览器探针（5 视口）

**脚本**：`production/m19-probe.mjs`（零依赖 CDP，Node 22 内建 `WebSocket`）· **产物**：`production/m19-shots/`
**Part A 跑真实构建产物**（真 boot / 真 renderer / 真 `UIManager` / 真资产 URL / 真样式表）。

| 视口 | canvas | HUD 非纯文本 | 7 槽位全部解析为 `url(...)` | 金币材质牌 | 外部请求 |
|---|---|---|---|---|---|
| 1920×1080 | 2 | ✅ | ✅（0 未解析） | ✅ | 0 |
| 2560×1440 | 2 | ✅ | ✅ | ✅ | 0 |
| 3840×1080 | 2 | ✅ | ✅ | ✅ | 0 |
| 1080×1920 | 2 | ✅ | ✅ | ✅ | 0 |
| 800×600 | 2 | ✅ | ✅ | ✅ | 0 |

- **HUD 非纯文本**判据：`#hud-material` 内同时存在 `.hud-health` + `.hud-dash` + `.hud-dash-ring`（图形）+ `.hud-health-fill`（比例条）⇒ 三件组件均为图形化节点，非文本读数。
- **金币牌**：`#gold` 自身携带 `.hud-gold` 类并含 `.hud-gold-icon` / `.hud-gold-value`。
- **无降级**：7 个 `--ui-*` 全部解析为真实 `url(...)`，即资产随包产出且被注入。
- **外部请求数 = 0**（FR-053 / SC-011）。

### 5.1 页面滚动条 —— 已 A/B 证伪「M19 引入」
探针在 5 个视口下均测得 `scrollHeight == 2 × 视口高`，溢出源是一个**无 `id`、无 `class`、`position: static`** 的裸 `<canvas>`（PixiJS canvas 池留在 DOM 中的产物），其 `top` 恰为一个视口高。

**A/B 实测**（`git worktree` 检出基线 `8606ca5`，独立构建后跑**同一个探针**）：

| | M18 基线 `8606ca5` | M19 工作树 |
|---|---|---|
| `scrollHeight / 视口高` | **2×（5/5 视口）** | **2×（5/5 视口）** |
| 溢出源 | 裸 `CANVAS`，`position: static` | **完全相同** |
| HUD 非纯文本 | `false` | `true` |
| 未解析槽位 | 7 | 0 |

原始记录：`production/m18-baseline-scroll-ab.json`。同时 `git diff` 证实 M19 **未改动** `html` / `body` / `#app` / `#app canvas` 任何规则，也未改动 `Application` / `canvas` / `mountCanvas` / `resizeTo` 任何一行；且 M19 的 UI 为**纯 DOM**（`ui_skin.test.ts` 断言 `UIManager` 不含 `pixi.js` / `Container` / `Graphics`），不新增任何 Pixi 调用。

⇒ **该滚动条为 M18 之前既存现象，非 M19 引入。** 建议后续以 `html, body { overflow: hidden }` 单行修复（**本次未擅自改动**：超出 M19 交付边界，且属行为变更，须用户裁定）。

---

## 6. T053 · 品质像素判据

采样位置：**框外 3px 品质环**（`box-shadow`，主锚点）+ **品质 chip 背景**（`.boon-rarity-tag`）。**未**采样被 `border-image` 覆盖的框区。

| 品质 | 环实测 RGB | chip 实测 RGB | pips | 标签 | 轮廓类 |
|---|---|---|---|---|---|
| common | **`#3f6ea8`** | `#3f6ea8` | 1 | 普通 | `boon-icon-frame--square` |
| epic | **`#8a5cd0`** | `#8a5cd0` | 2 | 史诗 | `boon-icon-frame--cut` |
| legendary | **`#ffcd4a`** | `#ffcd4a` | 3 | 传说 | `boon-icon-frame--crown` |

**判据：欧氏 ΔRGB ≥ 60 且 max-channel Δ ≥ 50**

| 色对 | 环（欧氏 / max） | chip（欧氏 / max） | 判定 |
|---|---|---|---|
| common ↔ epic | **86.9 / 75** | 86.9 / 75 | ✅ |
| common ↔ legendary | **233.9 / 192** | 233.9 / 192 | ✅ |
| epic ↔ legendary | **210.7 / 134** | 210.7 / 134 | ✅ |

**`grayscale(1)` 断言**：三张卡片在灰度下裁剪截图 sha256 **两两不同** ⇒ 去除颜色后仍可区分（pips 1/2/3 + 中文标签 + 三种轮廓类）。证据：`production/m19-shots/cards-gray-*.png`。

> **口径披露（诚实边界）**：Part B 使用**生产样式表 + 生产资产 URL**，但卡片 DOM 由探针注入（逐字转写 `client/UIManager.ts:440-475` 的元素顺序与类名），而非由 `UIManager` 现场产出 —— 因为 `main.ts` 刻意不暴露 `sim` / `ui`，且三选一面板只在清房后出现。因此 §6 证明的是**皮肤与资产的像素行为**；「`UIManager` 确实产出该 DOM 契约」由 `tests/ui/ui_skin.test.ts` 守护。首次注入 `#ui-layer` 时卡片被每帧 `sync()` 清掉，已改为探针自有容器。

---

## 7. T058 · quickstart V1–V13 独立判定

| 编号 | 场景 | 判定 | 依据 |
|---|---|---|---|
| V1 | `src/` 零改动 | **PASS** | §2 |
| V2 | 既有 948 例 100% 通过 | **PASS** | §1（1133 例 / 0 失败） |
| V3 | 摘要逐位相同 | **PASS** | §2（`f52dfdd4`） |
| V4 | HUD 三组件 | **自动 PASS**（18 例 + 探针 5 视口图形化节点）；**观感 PENDING** | §1 · §5 |
| V5 | 三卡三要素 | **自动 PASS**（三要素携带率 100%，品质一致率两独立来源）；**观感 PENDING** | §1 · §6 |
| V6 | 描述数值与逻辑层一致 | **PASS**（双通道，通道 B 真打命中量真实掉血） | §1 |
| V7 | Tab 面板 | **PASS**（集合一致 + 开/关逐 Tick 差异 0 + 生命周期） | §1 |
| V8 | 覆盖层统一视觉 | **自动 PASS**（语义/优先级 6 例）；**视觉统一 PENDING** | §1 |
| V9 | 降级 | **PASS**（17 例，含新增槽位消费守卫 7 例） | §4 |
| V10 | 可读性 / 可达性 | **PASS** | §2.1 |
| V11 | 品质可辨性 | **自动 PASS**（§6 像素 + 灰度）；**主观正确率 ≥90% PENDING** | §6 |
| V12 | 性能比值 ≤ 1.2 | **PASS**（0.782） | §2 |
| V13 | 体积预算 + 零外部请求 | **PASS**（新增 1 359 B；外部请求 0） | §1 · §5 |

**主观项（SC-001 / SC-002 / SC-014 / US5 视觉统一）一律登记 PENDING，需 ≥1 名人类观察者。**

---

## 8. 与工程侧报告的不一致点（主理人裁定）

| # | 工程侧 `m19-evidence.md` | 独立复核 | 裁定 |
|---|---|---|---|
| 1 | 未披露 `--ui-frame-dash` 从未被消费（§7 仅讨论其字节与 `frame-health` 相同） | **确实未被任何 CSS 消费**（全仓 grep 无 `var(--ui-frame-dash)`） | **工程侧遗漏**；已修复 + 补守卫断言（§4） |
| 2 | 「五道闸门全绿」（实测 1126 例） | 首轮满载 **1125 通过 / 1 失败**（`stress.test.ts` G2），空载 5/5 通过 | 差异源于**既有负载敏感项**，非 M19；工程侧结论方向正确但**未披露波动** |
| 3 | `contracts/ui-boon-data-table.md` §2/§4 的 `icon` 定义「作废」 | 复核一致：权威为 `data-model.md` §2（CSS 字形 token） | **一致**，工程侧已登记（DEV-1） |
| 4 | `plan.md`「新增 14 槽」作废，实为 7 槽 | 复核一致 | **一致**（DEV-2） |
| 5 | 页面滚动条未提及 | 发现并 A/B 证伪为**既有缺陷** | 登记为既有项，建议单行修复（§5.1） |

---

## 9. 残余风险与后续建议

> **用户工程裁决（2026-10-03）**：R2 与 R3 **已正式转入技术债登记** [`docs/TECH-DEBT.md`](../docs/TECH-DEBT.md) —— 分别记为 **TD-002**（滚动条，**已排期**到下个迭代，届时加 `html, body { overflow: hidden }`）与 **TD-001**（M16 死槽位，**专门清理**，并把 M19 的「槽位必须被消费」守卫扩展到全部 `--ui-*`）。R4 由主理人补录为 **TD-003**（待用户确认）。本次迭代**刻意不动**这三处代码，符合「克制、不越界」的交付纪律。

| # | 风险 / 建议 | 级别 | 技术债 |
|---|---|---|---|
| R1 | 主观 SC（SC-001/002/014、US5 视觉统一）需人类观察者签字 | 中（阻塞最终验收，不阻塞合并） | — |
| R2 | 既有页面滚动条（裸 canvas，M18 前既存）建议以 `html, body { overflow: hidden }` 修复 | 低 | **TD-002（已排期）** |
| R3 | M16 遗留死槽位 `--ui-frame-slot` / `--ui-frame-slot-inlay` 未被消费，建议后续清理 | 低 | **TD-001** |
| R4 | `tests/performance/stress.test.ts` G2 为绝对墙钟断言，满载易失败（M15 遗留）；建议改为缩放比口径 | 中 | **TD-003（补录）** |
| R5 | `production/m19-mutation-backup/` 为一次性快照（含源码副本），合并后可由后续清理移除 | 低 | — |

---

## 10. 证据索引

| 产物 | 内容 |
|---|---|
| `production/m19-evidence.md` | 工程侧证据（主理人已补充 §4/§5/§6/§8 的独立复核结论） |
| `production/m19-baseline.md` | 基线固化（948 例 / 摘要 `f52dfdd4`） |
| `production/m19-mutation-log.md` | **T055 变异实验 M1–M6 逐条证据 + 还原完整性校验** |
| `production/m19-mutation-run.py` | 变异实验驱动（一次性工具，可复现） |
| `production/m19-mutation-backup/` | 变异实验前快照 + `ORIGINAL-SHA256.txt` |
| `production/m19-probe.mjs` | **T052/T053 真浏览器探针（零依赖 CDP）** |
| `production/m19-shots/` | 5 视口截图 + 卡片截图 + 灰度裁剪 + `m19-probe-report.json` |
| `production/m18-baseline-scroll-ab.json` | **滚动条 A/B 实测原始记录（M18 基线 vs M19）** |
| `production/m19-ui-volume.md` | UI 资产体积实测（PASS） |
