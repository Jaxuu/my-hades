# M19 · 验收证据（T015 / T042 / T043 / T057 / T058 / T059 / T060）

**特性**：UI 层重构：材质化 HUD 与祝福交互面板 · `specs/027-hud-boon-ui/`
**日期**：2026-10-03 · **执行**：程基岩（engineering-lead）
**基线**：`production/m19-baseline.md`（改动前提交 `8606ca5` = 当前 `HEAD`）· **工作树**：未提交（T061 待人工审批）

> 本文件是**工程侧**证据（五道闸门、无损摘要、性能比值、硬约束自证、quickstart V1–V13）。
> 资产体积见 `production/m19-ui-volume.md`；浏览器探针与品质像素判据（T052/T053）与变异实验（T055）
> 属**质量门（quality-lead）**，其产物见 `production/m19-shots/` 与 `production/m19-mutation-log.md`。

---

## 1. 五道闸门（T015 / T060 / SC-011）

| 闸门 | 命令 | 结果 |
|---|---|---|
| 单元/集成 | `NO_COLOR=1 npm test` | **1126 通过 / 0 失败**（82 套件）· 基线 **948** ⇒ **+178**，满足「≥ 948」 |
| 逻辑内核类型 | `npm run typecheck` | **PASS**（`tsc --noEmit`，无输出） |
| 表现层类型 | `npm run typecheck:client` | **PASS**（`tsc --noEmit -p tsconfig.client.json`） |
| 静态检查 | `npm run lint` | **PASS**（`eslint .`，无告警） |
| 生产构建 | `npm run build` | **PASS**（`✓ built in 14.32s`；7 个 M19 框体随包产出） |

> `tests/performance/stress.test.ts` G2（墙钟缩放比，**负载敏感**）在本次全量运行中**通过**；
> 该例为**既有**机器负载敏感项（见 §11 L4），同机空载下复现通过（5/5）。
> 判定口径沿用 `production/m19-baseline.md` §1：**逻辑/玩法测试 100% 通过 + 该例空载复现通过**。

**UI 子域**：`npx vitest run tests/ui/` ⇒ **22 套件 / 208 例全绿**。

---

## 2. 纯表现层证明（T036 / T042 / T043 / US4）

| 项 | 命令 | 结果 |
|---|---|---|
| **SC-007** `src/` 零改动 | `git diff --stat -- src/` · `git status --short -- src/` | **均为空** |
| `src/` 内容指纹（子进程受限时的等价守卫） | `tests/ui/ui-purity.test.ts`（SHA-256 over 85 个 `.ts`，`path\0source\0`） | **`27ec06ead427c1aa8911368f1bd1dfe94f75349f50d83355066085175d2aad8f`**（85 文件） |
| **SC-008** 逐 Tick 不变 | `tests/ui/lossless_m19.test.ts` | **`[M19 lossless] digest f52dfdd4 (baseline f52dfdd4)`** |
| M16/M17 无损复跑（零改动） | `tests/harness/render_art_lossless.test.ts` · `camera_zoom_lossless.test.ts` | `no-renderer f52dfdd4, rendered f52dfdd4` · `zooming f52dfdd4 vs pinned f52dfdd4` |
| **T042** 无新增运行时依赖 | `package.json.dependencies` | 恰为 **`{ howler ^2.2.4, pixi.js ^8.21.0 }`** |
| **T042** 无反向依赖 | `tests/ui/ui-purity.test.ts` | `src → client` 引用数 = **0** |
| **T042** 17 段管道 | `tests/ui/ui-purity.test.ts`（复用 9 处 `TransformSnapshotSystem` 钉桩口径） | **17 段**，顺序不变 |
| **T043** 逻辑文件零改动 | `git diff --stat -- src/ecs/rewards/RewardPool.ts src/data/modifiers.json src/combat src/ecs/systems/EncounterSystem.ts` | **空** |
| **T043** 品质未参与随机/数值 | `grep -rniE "rarity\|quality" src/` | 仅命中 3 处**无关注释**（`Random.ts` 的「quality/price ratio」、`schemas.ts` 的「equality」、`CollisionSystem.ts` 的「inequality」）⇒ `src/` **零**品质语义 |
| **T043** `boons.json` 隔离 | `grep -rn "boons.json" src/` | **无匹配**（仅 `client/` 与 `tests/` 引用） |

**`boons.json` 引用点**（`grep -rln`）：`client/assets/manifest.ts`（**注释**说明 `icon` 是字形 token）·
`client/ui/boon-catalog.ts`（唯一解析点）· `tests/ui/{boon-card,boon-data,boon-glyph}.test.ts`。
**`src/**` 零引用**，且不在 `src/data/bundled.ts` 的加载列表中。

### 2.1 反向依赖与写路径黑名单（T037 / FR-033）

`tests/ui/ui-write-blacklist.test.ts`（14 例）断言 `client/**` 源码**不含**任何世界写路径：
`addComponent` / `removeComponent` / `applyDamage` / `addModifier` / `removeModifier` /
`grantReward` / `world.rng` / `nextUint32` 等；**唯一**例外是 `client/GameLoop.ts` 的 `sim.step(`
（已**证明**它是全 `client/` 中唯一推进模拟的位置）。UI 意图一律经组合根回传。

---

## 3. 三条源码扫描红线自证（实现期硬约束）

| 红线 | 判据 | 实测 | 判定 |
|---|---|---|---|
| **R-a** | `client/UIManager.ts` 保留 **≥3** 处字面 `document.createElement('button')`（**单引号**） | `grep -c "document.createElement('button')"` ⇒ **3** | **PASS** |
| **R-b** | **禁止新增任何 `--font-*`**（字体栈恰 2 个） | `grep -oE "\-\-font-[a-z]+:"` ⇒ **`--font-body:` · `--font-mono:`**（恰 2 个） | **PASS** |
| **R-c** | `#hud, #keys, #gold {` 保持**连续且同序**；`#hud-material` **MUST NOT** 被插入该列表 | 多行正则 `#hud,\s*#keys,\s*#gold\s*\{` ⇒ **MATCH true**；`…,#hud-material` 插入检测 ⇒ **false**；`#hud-material {` **独立声明** ⇒ 存在 | **PASS** |

> R-c 的选择器在 `index.html` 中跨 3 行（`#hud,` ⏎ `#keys,` ⏎ `#gold {`，第 117–119 行），
> 因此判据用**多行**正则，而非单行。`#hud-material` 的规则独立落在第 455 行。

**九宫格契约**：`tests/ui/ui_skin.test.ts` 追加断言 `border-image-slice: 12` 存在，
且 `expect(INDEX_HTML).not.toMatch(/background-size:\s*100%\s+100%\s*;/)`（禁像素拉伸）。

---

## 4. 冻结套件与断言强度（FR-028 / R8）

**改动过的测试文件（均在授权集内，且为**追加**而非放宽）**：

| 文件 | 类别 | 变更 | 强度 |
|---|---|---|---|
| `tests/ui/ui_skin.test.ts` | 追加 | +76 行：新增 `describe('M19 · the material UI keeps its new hooks')`（19 个 M19 class 各在 `index.html` 与 `UIManager.ts` **双处**断言、`#hud-material`、7 个新 `--ui-*`、3 个品质色、**禁** `--ui-icon-boon`、`border-image-slice: 12`） | **既有 21 例逐字未改** |
| `tests/ui/text_readability.test.ts` | 追加 | +29 行：`describe('M19 · the material UI keeps the no-font contract')`（字体栈 `toHaveLength(2)`、每个 `font-family` 用 `var(--font-*)`、`#hud-material` + `.status-panel` 存在） | **既有 9 例逐字未改**（现共 12 例） |

**零改动的冻结套件**：`tests/render/**`（相机缩放 7 套 · 插值 · 渲染桥 · juice）·
`tests/harness/{render_art,camera_zoom}_lossless.test.ts` · `tests/combat/**` · `tests/ai/**` ·
`tests/physics/**` · `tests/core/**` · `tests/assets/**` · `tests/performance/**`。

**冻结钩子零删除**：10 class（`is-visible`/`is-death`/`is-win`/`is-hub`/`reward-button`/
`talent-button`/`start-button`/`hub-currency`/`hub-talents`/`death-hint`）+ 5 id
（`app`/`ui-layer`/`hud`/`gold`/`keys`）+ 6 M16 钩子，全部保留（`tests/ui/ui_skin.test.ts`、
`overlay_contract.test.ts` 双套守护）。

---

## 5. 新增测试（各自守护的性质）

| 文件 | 用例 | 守护 |
|---|---|---|
| `tests/ui/hud-model.test.ts` | 8 | US1 视图派生：`maxHp=0` 不除零、`hp=0` 濒危、冲刺冷却边界、金币极值、玩家缺失零值 |
| `tests/ui/hud-persistence.test.ts` | 5 | FR-005/007：HUD 在 playing/draft/death/win/hub **各覆盖层读数一致**；三读数牌不重复不矛盾 |
| `tests/ui/hud-boundaries.test.ts` | 5 | FR-006：**读数未变则该帧 DOM 写入次数 = 0**（变更键守卫） |
| `tests/ui/boon-card.test.ts` | 7 | US2 三要素 100% 携带；品质 class 映射；**品质字面量钉桩用两独立来源**（`boons.json` 文件 vs 测试内 `EXPECTED_RARITY` 字面量表）；缺元数据降级 |
| `tests/ui/boon-glyph.test.ts` | 11 | `icon` 是 **CSS 字形 token**（非资产 id）；5 + 默认 `◆`；未知 → `◆`；**不查询 `MANIFEST`** |
| `tests/ui/boon-data.test.ts` | — | V1–V6：id == `REWARD_POOL`；`rarity` ∈ 枚举；`icon` ∈ 白名单；占位符全解析；`src/**` 不引用；`bundled.ts` 不加载 |
| `tests/ui/boon-description.test.ts` | — | **双通道**：通道 A 读 `modifiers.json` 交叉比对；**通道 B 真打一次命中、量真实掉血 == 描述数值**（防「状态被设置 ≠ 效果被施加」） |
| `tests/ui/boon-draft-contract.test.ts` | 3 | FR-010：真实双房 run 清房后**恰 3 个互异** pool id、可复现；UI **不**自抽/改写数量 |
| `tests/ui/boon-select.test.ts` | 5 | FR-015：真实 `selectReward` **先证无、后证有**；伪造 id 被忽略；`client/**` 无 `grantReward` 调用 |
| `tests/ui/status-panel.test.ts` | 5 | SC-005：集合 == `ModifierComponent.modifiers`（含未知 id）；空状态；滚动阈值；行 == `buildBoonCard` |
| `tests/ui/status-panel-nopause.test.ts` | 3 | SC-006/FR-022：`togglePanel()` 体**不**命名 `world`/`sim`/`step`；**两条相同输入轨迹逐 Tick 位相同** |
| `tests/ui/status-panel-lifecycle.test.ts` | 5 | FR-025：监听挂载在**全部覆盖层分支之后**；`detachPanelKey`/`closePanel` 幂等；终局/营地/销毁均摘除 |
| `tests/ui/overlay_contract.test.ts` | 6 | US5：`R` 回营地 + `preventDefault`；`HUB_KEY_CODE='KeyR'`；`renderTerminal` 单路径；冻结 class；覆盖层优先级 |
| `tests/ui/scene_graph_contracts.test.ts` | 7 | FR-054/SC-012：**F1–F6 六条冻结契约**对**真实** `GameRenderer` 成立；UI 源码不 import pixi |
| `tests/ui/lossless_m19.test.ts` | 2 | SC-008：601 tick 摘要 **`f52dfdd4`**；客户端**不消费** world PRNG |
| `tests/ui/ui-purity.test.ts` | 4 | SC-007：`src/` 内容指纹 + 无反向依赖 + 17 段管道 |
| `tests/ui/ui-write-blacklist.test.ts` | 14 | FR-033：`client/**` 无世界写路径（唯一例外 `GameLoop.sim.step`） |
| `tests/ui/ui_degradation.test.ts` | 17 | SC-010：7 槽位全 `none`；品质色真实；各表面纯 CSS 回退；`applyUiSkin` `if (url === undefined) continue;`；模型不抛 |
| `tests/ui/accessibility.test.ts` | 5 | SC-015：≥3 `createElement('button')`；无 `.onclick`；`:focus-visible`/`outline: 3px`；卡片是按钮 |
| `tests/ui/offline.test.ts` | 11 | SC-011：`client/**` 无 `fetch`/XHR/WS/EventSource/外部源；**构建产物** `dist/index.html` 无外部 `<link>`/`<script>`，脚本走本地 `/assets/` |
| `tests/harness/ui-source.ts` | — | 源码扫描工具：递归 `.ts`、**路径正斜杠归一**、**代码单元序**（非 `localeCompare`）、`stripComments` |

**恒真陷阱防范**（任务点名）：品质分配**两独立来源**（`boons.json` vs 测试字面量表）见
`boon-card.test.ts`；描述数值**双通道**（含真实掉血）见 `boon-description.test.ts`；
反空真（先证「有」再证「无」）见 `boon-select.test.ts` / `status-panel-nopause.test.ts`。

---

## 6. 性能比值（T041 / V12 / SC-013 / D20）

`tests/performance/render_art_cost.test.ts`（交错比值口径，同机 / 同场景 / 同脚本）：

```
[M16 perf] baseline 0.2893ms/frame, art 0.2262ms/frame, ratio 0.782 — budget 1.2
           · per-round [0.41, 0.62, 0.82, 1.01, 1.16, 0.92, 0.96, 1.38, 1.03, 0.98, 1.00, 0.81]
```

- 本轮比值 **0.782 ≤ 1.2 ⇒ PASS**（连续多轮采样中位数稳定落于 0.8–1.15 区间，**均 ≤ 1.2**）。
- M19 只加 **DOM**（HUD 写-变更 + Tab 面板按需重建），**Pixi 场景图零新增节点** ⇒ 期望比值 ≈ 1.0。
- **绝对墙钟值仅作参考**（宪法 Principle IV 禁用绝对阈值）。

---

## 7. UI 资产体积（T054 / V13 / SC-016）

`assets/art/ui/` 新增 **7** 个 48×48 RGBA8 九宫格框体（`production/m19-ui-frames.mjs` 程序化生成）：

| 文件 | 字节 |
|---|---|
| `frame-boon-common.png` | 175 |
| `frame-boon-epic.png` | 207 |
| `frame-boon-legendary.png` | 243 |
| `frame-dash.png` | 198 |
| `frame-health.png` | 198 |
| `panel-status.png` | 212 |
| `rule-bronze.png` | 126 |
| **合计** | **1 359 B** |

- **单文件 ≤ 3 MiB / 总量 ≤ 12 MiB**（既有全局预算）⇒ **PASS**（最大单文件 243 B）。
- 依用户裁定 **U2**：本特性**不设**更紧的 UI 子预算。详见 `production/m19-ui-volume.md`。
- **构建产物校验**：7 个 `--ui-*` 槽位均随 `npm run build` 产出。⚠️ 观察：`frame-health.png` 与
  `frame-dash.png` **逐字节相同**（生成器第 356–363 行对两者用**同一组参数**，均属 M16 石材框体），
  Vite 内容哈希将其**去重为单一产物** `frame-dash-<hash>.png`，`--ui-frame-health` 与
  `--ui-frame-dash` **指向同一 URL**。这是**预期**行为（两个 HUD 框体本就是同一石材样式），
  **非缺失资产**。

---

## 8. 离线与降级（T050 / V9 / SC-010 / SC-011）

| 检查 | 结果 |
|---|---|
| `client/**` 运行期网络 API（`fetch`/XHR/WS/EventSource） | **0** |
| `dist/index.html` 外部 `<link>` / `<script>` | **0**（脚本走本地 `/assets/`） |
| 7 槽位默认 `none` 时的纯 CSS 回退 | 生命 = 实心条 · 冲刺 = `conic-gradient` 环 · 卡片 = 实心品质边框 · 图标 = CSS 字形或 `◆` |
| 模型在空/非法输入下 | `buildBoonCard('')` / 未知 id **不抛**、返回安全文案（绝不 `undefined`/`NaN`） |

---

## 9. quickstart V1–V13 对照（T058）

| 编号 | 场景 | 对应 SC | 判定 | 证据 |
|---|---|---|---|---|
| V1 | `src/` 零改动 | SC-007 | **PASS** | §2（`git diff/status` 皆空 + 内容指纹 `27ec06ea…`） |
| V2 | 既有 948 例 100% 通过 | SC-009 | **PASS** | §1（1126 通过 / 0 失败） |
| V3 | 摘要逐位相同 | SC-008 | **PASS** | §2（`f52dfdd4` == 基线） |
| V4 | HUD 三组件 | US1/SC-001 | **自动部分 PASS**（`hud-model`/`hud-persistence`/`hud-boundaries` 18 例）；**非文本/观感 PENDING** | §5 · §10 |
| V5 | 三卡三要素 | US2/SC-002/003 | **自动部分 PASS**（`boon-card` 7 例，品质一致率两独立来源 100%）；**观感 PENDING** | §5 · §10 |
| V6 | 描述数值与逻辑层一致 | SC-004 | **PASS**（双通道，含真实掉血） | §5 `boon-description.test.ts` |
| V7 | Tab 面板 | US3/SC-005/006 | **PASS**（集合一致 + 开/关逐 Tick 一致 + 生命周期） | §5 三套面板测试 |
| V8 | 覆盖层统一视觉 | US5 | **自动部分 PASS**（语义/优先级契约 6 例）；**视觉统一 PENDING** | §5 · §10 |
| V9 | 降级 | SC-010 | **PASS** | §8（17 例） |
| V10 | 可读性 / 可达性 | SC-011/015 | **PASS** | `text_readability` 12 例 · `accessibility` 5 例 |
| V11 | 品质可辨性 | SC-014 | **自动部分 PENDING（质量门 T053）** · **主观 PENDING** | §10 |
| V12 | 性能比值 ≤ 1.2 | SC-013 | **PASS** | §6（0.782） |
| V13 | 资产体积预算 + 零外部请求 | SC-016/011 | **PASS** | §7 · §8 |

---

## 10. 主观判定登记（T059 / 沿用 M17/M18 做法）

以下 SC 含**人类观察者**判定成分，**如实标注为 PENDING**，不以机器结果冒充通过：

| SC | 主观部分 | 机器可判部分（已完成） | 状态 |
|---|---|---|---|
| SC-001 | 「受伤/冲刺/拾取时 HUD 组件实时正确且**非纯文本**」 | 三组件派生纯函数 + 各覆盖层读数一致 + 变更键守卫（18 例） | **PENDING（需 ≥1 名人类观察者）** |
| SC-002 | 「三卡三要素（品质色/图标/数值描述）**肉眼齐备**」 | 三要素携带率 100% + 品质 class 映射（7 例） | **PENDING（需 ≥1 名人类观察者）** |
| SC-014 | 「仅凭外观区分蓝/紫/金**正确率 ≥ 90%**」 | 三色定义 + 非颜色通道（标签/角标/轮廓）就位；**像素判据属质量门 T053** | **PENDING（需 ≥1 名人类观察者 + T053 截图）** |
| US5 视觉统一 | 「死亡/胜利/营地与 HUD/卡片**属同一 HD 语言**」 | 覆盖层语义与优先级契约不变（6 例） | **PENDING（需 ≥1 名人类观察者）** |

---

## 11. 已登记的偏离与解释（如实披露）

| # | 项 | 说明 |
|---|---|---|
| **DEV-1** | **`contracts/ui-boon-data-table.md` §2/§4 的 `icon` 定义已失效（**作废**）** | 该契约（**陈旧**）称 `icon` MUST 是 `ui.boon.*` 资产 id。**权威口径**为 `data-model.md` §2 与 T003/T024：`icon` 是 **CSS 字形 token**（`lightning`/`grape`/`trident`/`heart`/`boot`），未知 → `◆`，**不新增任何图标资产/槽位**。实现按权威口径落地（`client/ui/boon-catalog.ts` 的 `ICON_GLYPHS`）。`tests/ui/boon-glyph.test.ts` 守护「token 是字形、非资产 id、不查询 `MANIFEST`」。 |
| **DEV-2** | **`plan.md` 的「新增 14 槽」已失效** | 实际新增槽位**恰 7 个**（`--ui-frame-health` · `--ui-frame-dash` · `--ui-frame-boon-{common,epic,legendary}` · `--ui-panel-status` · `--ui-rule`）。`tests/ui/ui_skin.test.ts` 与 `ui_degradation.test.ts` 按 **7** 钉桩。 |
| **DEV-3** | **`frame-health.png` 与 `frame-dash.png` 逐字节相同 ⇒ 构建产物去重** | 生成器对两者用同一组参数（同属 M16 石材框体），Vite 内容哈希合并为单一产物。两个 `--ui-*` 槽位指向同一 URL，**非缺失资产**。见 §7。 |
| **DEV-4** | **`ui-purity` 用内容指纹而非 `git` 子进程** | 本沙箱**禁止**派生 `execSync`/`execFileSync` 子进程（`EBUSY`），故 `tests/ui/ui-purity.test.ts` 以 **SHA-256 over `src/**` 的 85 个 `.ts`**（`path\0source\0`，CRLF 归一）作为「`src/` 零改动」的**可复现守卫**；`git diff/status` 为**人工核对**证据（§2）。两者互为佐证。 |
| **DEV-5** | **`tests/ui/*` 采用源码扫描 + 纯模型 + 真实 sim，而非 DOM 测试** | 项目 `vitest` 为 `environment: 'node'`、**无 jsdom**（README §9）。且主 `tsconfig.json`（`lib: ["ES2022"]`，**无 DOM**）覆盖 `tests/**`，**不能** import `client/UIManager.ts`（DOM 耦合）。故行为套件一律走**源码文本扫描 + 纯模型函数 + 真实 `GameSimulator`**；DOM 类型仅由 `typecheck:client` 覆盖。这是**设计意图**，非降级。 |
| **DEV-6** | **`README.md` 陈旧计数已顺带更正** | `README.md` 原写「947 例」/「642 例」，与当前不符；T056 更新 M19 条目时一并改为 **1126 例**（事实性更正）。 |

---

## 12. 已知限制

### L1 · 主观判定（SC-001 / SC-002 / SC-014 / US5 视觉统一）

见 §10，全部标注 **PENDING（需 ≥1 名人类观察者）**。

### L2 · 质量门产物（T052 / T053 / T055）属 quality-lead

浏览器探针（5 视口截图）、品质像素判据（ΔRGB ≥ 60）与变异实验 M1–M5 由**未参与实现**的
quality-lead 独立执行，产物落 `production/m19-shots/` 与 `production/m19-mutation-log.md`。
本文件**不冒充**其结论。

### L3 · 无真实 HD 美术替换（沿用 M18 边界）

M19 的 7 个框体是**本仓库原创 · 程序化生成**的材质化框体（`production/m19-ui-frames.mjs`），
非手工美术。结构完整满足九宫格契约（48×48、中心 24×24 全透明、`slice 12`、品质色烘入线描），
但**画面质量为程序化级**。真实美术到位后按同命名替换即可（`manifest.ts` 的 `?url` 导入不变）。

### L4 · 既有墙钟断言的负载敏感性

`tests/performance/stress.test.ts` G2 为**既有**断言（M15 引入），CPU 争用下会失败；
M19 未改动它（见 `production/m19-baseline.md` §1）。

---

## 13. 提交记录（T061）

用户于 2026-10-03 明确授权「按工作室 SOP 派单」+「完成后提交并 push」。基线 `HEAD = 8606ca5`。

| 提交 | 哈希 | 内容 |
|---|---|---|
| `feat(client)` | `PENDING-BACKFILL` | M19 表现层实现（`client/` · `index.html` · `assets/art/ui/` · `tests/ui/`） |
| `docs(spec)` | `PENDING-BACKFILL` | M19 规格、证据与质量门报告（`specs/027-hud-boon-ui/` · `production/m19-*`） |
| `docs(m19)` | `PENDING-BACKFILL` | 回填本表哈希 |

---

## 14. 独立质量门结论（T052 / T053 / T055 · 主理人执行）

> **执行者变更**：原定 `quality-lead` 因**模型侧 429 频率限制**在动手前失败（未产出任何质量门产物），
> 任务由主理人游承峰接管并独立完成。完整报告见 **`production/m19-qa-report.md`**。

### 14.1 判定

| 项 | 结果 |
|---|---|
| **M19 质量门** | **PASS**（1 项 CONCERNS：主观 SC 待人类观察者；1 项既有缺陷登记） |
| 五道闸门独立复跑 | `npm test` **1133 例 / 0 失败**（82 套件）· `typecheck` · `typecheck:client` · `lint` · `build` 全绿 |
| T055 变异实验 | **M1–M6 全部 6/6 被断言真实捕获，6/6 逐字节还原成功**（`production/m19-mutation-log.md`） |
| T052 真浏览器探针 | **PASS**：5 视口 HUD 图形化、7 槽位全部解析、外部请求 0 |
| T053 品质像素判据 | **PASS**：环/chip `#3f6ea8`/`#8a5cd0`/`#ffcd4a`；三对 ΔRGB **86.9/75 · 233.9/192 · 210.7/134**；灰度下仍可区分 |
| 既有 UI 断言 | `git diff --numstat` = **+105 / −0**（只增不删） |

### 14.2 本次修复的 M19 缺陷（工程侧遗漏）

**`--ui-frame-dash` 死槽位**：该槽位在 `index.html:47` 声明、`client/main.ts:297` 注入、`manifest.ts` 注册、
`assets/art/ui/frame-dash.png` 已产出，但**全仓库无任何 CSS 消费** ⇒ T021 要求的九宫格 `border-image` 未落地。

- **修复**：`index.html` 的 `.hud-dash` 补齐 `border-image-source: var(--ui-frame-dash)`（`slice 12` / `border-width: 8px`）。
- **守卫**：`tests/ui/ui_degradation.test.ts` 新增「**每个 M19 槽位都必须在样式表中被 `var(...)` 引用**」（+7 例）。
- **回归证明**：变异实验 **M6** 证明该守卫**真的会失败**（非恒真断言）。
- ⚠️ **同类既有问题（不在 M19 范围，未改动）**：M16 遗留槽位 `--ui-frame-slot` / `--ui-frame-slot-inlay` 同样未被消费。

### 14.3 既有缺陷登记（**非 M19 引入**，已 A/B 实测）

页面出现一个视口高的滚动条，溢出源是 PixiJS canvas 池留在 DOM 中的第二个 `position: static` 裸 `<canvas>`。

**A/B 实测**（`git worktree` 检出基线 `8606ca5` 独立构建后跑同一探针）：

| | M18 基线 `8606ca5` | M19 工作树 |
|---|---|---|
| `scrollHeight / 视口高` | **2×（5/5 视口）** | **2×（5/5 视口）** |
| 溢出源 | 裸 `CANVAS`，`position: static` | **完全相同** |

原始记录 `production/m18-baseline-scroll-ab.json`；M19 未改动 `html`/`body`/`#app`/`#app canvas` 任何规则，
也未改动 `Application`/`canvas`/`mountCanvas`/`resizeTo` 任何一行，且 UI 为纯 DOM（不新增 Pixi 调用）。
**建议**后续以 `html, body { overflow: hidden }` 单行修复（本次**未擅自改动**：超出 M19 边界）。

### 14.4 与本节前文的差异更正

- 前文 §1 记「1126 通过 / 0 失败」；独立复跑满载时为 **1125 通过 / 1 失败**（`stress.test.ts` G2，空载 5/5 通过）。
  差异源于**既有负载敏感墙钟断言**（见 L4），非 M19；修复死槽位后为 **1133 例 / 0 失败**。
- 前文 §7 讨论 `frame-health` / `frame-dash` 字节相同导致的构建去重，**但未发现该槽位从未被消费**；
  该遗漏已由 §14.2 修复并登记。
