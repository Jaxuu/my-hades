# M18 · 验收证据（T039 / T043 / T061 / T062 / T063 / T064 / T065 / T069 / T071）

**特性**：高清 2D 美术与动画资产替换 · `specs/026-hd-2d-art-assets/`
**日期**：2026-10-03 · **基线**：`production/m18-baseline.md` · **工作树**：未提交（T072 待人工审批）

---

## 1. 五道闸门（T059 / SC-011）

| 闸门 | 命令 | 结果 |
|---|---|---|
| 单元/集成 | `npm test` | **948 通过 / 0 失败**（62 套件）· 基线 893 ⇒ **+55**，满足「≥ 893」 |
| 逻辑内核类型 | `npm run typecheck` | PASS |
| 表现层类型 | `npm run typecheck:client` | PASS |
| 静态检查 | `npm run lint` | PASS |
| 生产构建 | `npm run build` | PASS（7.6 s） |

> 基线唯一失败项 `tests/performance/stress.test.ts` G2（墙钟缩放比，负载敏感）在 M18 全量运行中通过。

---

## 2. 纯表现层证明（T038 / T039 / T040 / T041 / T042 / T043）

| 项 | 命令 | 结果 |
|---|---|---|
| **SC-007** `src/` 零改动 | `git diff --stat -- src/` · `git status --short -- src/` | **均为空** |
| **SC-006** 逐 Tick 不变 | `tests/harness/render_art_lossless.test.ts` | 摘要 **`f52dfdd4`**（= 基线，逐位相同） |
| M17 缩放无损 | `tests/harness/camera_zoom_lossless.test.ts` | `zooming digest f52dfdd4 vs pinned f52dfdd4` |
| **T040** 两个 lossless 套件零改动 | `git diff` 两者 | **未修改**，继续通过 |
| **T041a** `GameRenderer` 导入图不含 `howler` | `grep -rE "^\s*import .*howler" client/` | 仅 `client/AudioManager.ts`（只被 `main.ts` 导入） |
| **T041b** 无 `src → client` 依赖 | `grep -rE "^\s*(import\|export) .*['\"].*client/" src/` | **无匹配** |
| **T041c** 只读契约 | `tests/assets/sprite-map.test.ts`（never writes / does not consume randomness） | 通过（仅 `pickupIconId` 的 id 字面量更新，三条断言强度不变） |
| **T042** 17 段管道 | 段计数 + 9 处钉桩 `git diff` | **17 段**，钉桩**零改动** |
| **T043** 无新增运行时依赖 | `package.json` | `dependencies` 恰为 `{ howler, pixi.js }` |

---

## 3. 冻结套件与断言强度（T060 / T061 / FR-028 / R8）

**改动过的测试文件（全部在授权集内）**：

| 文件 | 类别 | 理由 |
|---|---|---|
| `tests/assets/licenses.test.ts` | 结构（授权） | 像素图集形态断言（PNG+同名 JSON、`raw/` 包数 ≥5、体积 1MB/6MB）的**前提被本特性移除**；改写为 HD 形态 + 新增同强度上限（图集数、单图集像素、gutter）+ SC-008 残留断言 |
| `tests/assets/manifest.test.ts` | 结构（授权） | 许可断言由「恰为 CC0-1.0」改为**显式字面量白名单**；新增发行商黑名单扩展、`ui./sfx.` 保留断言、六类敌人独立图集断言 |
| `tests/assets/sprite-map.test.ts` | 结构（授权） | `pickupIconId` 的 **id 字面量**更新（D4）；三条断言（互不相同、纯函数）强度不变 |
| `tests/render/player_art.test.ts` | `*_art`（授权） | 帧数 2→8、缩放基准 16→128（由帧宽推导）、新增循环语义 + 攻击相位 |
| `tests/render/enemy_art.test.ts` | `*_art`（授权） | 缩放断言改为**绘制尺寸 == 碰撞直径**、`dash` 显示 `move` 帧（别名）、新增死亡剪辑推进 |
| `tests/render/tilemap_art.test.ts` | `*_art`（授权） | scale 重钉 128；新增 HD 基准钉桩 + 柱子竞技场铺装场景；**F1–F6 六条冻结用例逐字未动** |
| `tests/render/fx_art.test.ts` | `*_art`（授权） | 掉落物 id 命名空间迁移；剪影来源由 `ui.icon.*` 改为 `fx.pickup.*` |
| `tests/harness/png.ts` · `enemy_silhouette` · `hd_sharpness` · `player_animation_continuity` · `tilemap_autotile` | **新增** | 见 §4 |

**零改动的冻结套件（`git diff` 均为空）**：
`tests/render/camera_zoom_*.test.ts`（7 个）· `tests/render/interpolation.test.ts` · `tests/render/renderer_bridge.test.ts` · `tests/render/juice_m14.test.ts` · `tests/render/juice-verify.test.ts` · `tests/harness/{render_art,camera_zoom}_lossless.test.ts` · `tests/combat/**` · `tests/ai/**` · `tests/physics/**` · `tests/core/**`

**F1–F6 场景图冻结契约**：`git diff tests/render/tilemap_art.test.ts` 中 F1–F6 的六条用例**逐字未改**，且在 HD 资产在场时继续成立（`staticLayer.children.length === 1 + wallCount` 亦保持 —— 墙体深度**内嵌于既有 wall node**，零新增节点）。

**管道钉桩**：`grep -rl "'TransformSnapshotSystem'" tests/` 的 9 处 `git diff` 为空。

### 3.1 断言强度**未下降**的证明（R8）

- 「恰为 CC0-1.0」→「显式白名单」是**授权放宽**，同时**新增**发行商黑名单（13 家）与白名单字面量钉桩作为等价强度补偿（VR-24 同款做法）。
- 体积预算放宽（1 MB/6 MB → 3 MB/12 MB）**同步新增**两条新维度上限：图集数 ≤ 12、单图集 ≤ 4096²（并在 `licenses.test.ts` 中断言）。实测最大图集 1968×1804 ⇒ 断言有效，非空转。
- `raw/` 包数 ≥ 5 被移除后，替换为**许可登记完整性**断言（每个 id 可追溯 + 登记中显式记载退役管线）。
- 帧矩形不越界断言**强度不变**，仅比对基准目录由 `assets/art/atlas/` 改为 HD 图集目录。

---

## 4. 新增测试（各自守护的性质）

| 文件 | 用例 | 守护 |
|---|---|---|
| `tests/render/player_animation_continuity.test.ts` | 1 | **SC-015**：600 帧真实窗口内 跳帧 / 空白帧 / 一次性动作僵直 **三项计数 = 0**（实测 `skipped=0 blank=0 lockedUp=0`，动作覆盖 attack/idle/move） |
| `tests/render/enemy_silhouette.test.ts` | 6 | **FR-004 / SC-002**：5 类声明敌人两两可区分（网格 **且** 行剖面）+ `unknown` 兜底与 5 类均可区分；含「两套独立结构自洽」的非空转守卫 |
| `tests/render/tilemap_autotile.test.ts` | 15 | **T031** 47 部件完备性（256 掩码全解析、满射）· **T032** 像素不外溢（帧 = 1 格 + gutter 全透明 + **三带亮度严格递减**）· **T033** 立面不遮挡（逐格与 `rooms.json` 网格交叉核对 + 柱子房间）· **T034** 地面变体确定性 + **不消费 `World.rng`** |
| `tests/render/hd_sharpness.test.ts` | 6 | **FR-025**：HD 世界美术逐纹理 `linear` + `autoGenerateMipmaps`；全局默认仍 `nearest`；UI 贴图仍 `nearest`；覆盖发生在 `sheet.parse()` **之前** |
| `tests/harness/png.ts` | — | 零依赖 PNG 解码器（`node:zlib`），使 T032/T033 成为**真实像素断言**而非矩形断言 |

---

## 5. 性能比值（T062 / SC-010 / D20）

`tests/performance/render_art_cost.test.ts`（交错比值口径，同机同场景同脚本），连续 3 次：

| 轮次 | baseline ms/frame | art ms/frame | **比值** |
|---|---|---|---|
| 1 | 0.1280 | 0.1302 | **1.018** |
| 2 | 0.2068 | 0.2006 | **0.970** |
| 3 | 0.1984 | 0.1654 | **0.833** |

**中位数 = 0.970 ≤ 1.2 ⇒ PASS**。绝对墙钟值仅作参考（宪法 Principle IV 禁用绝对阈值）。

---

## 6. 体积（T063 / SC-014）

| 项 | 实测 | 上限 | 判定 |
|---|---|---|---|
| `assets/art/**` 总量 | **595 462 B ≈ 582 KB** | 12 MB | PASS |
| 单文件最大 | `hd/enemy-elite.png` **52 417 B ≈ 51 KB** | 3 MB | PASS |
| 图集数量 | **10**（9 张世界 HD + 1 张 UI 图标） | 12 | PASS |
| 单图集像素 | 最大 `hd/enemy-elite.png` **1968 × 1804** | 4096² | PASS（≤ 2048² 目标亦满足） |
| 相邻帧 gutter | **4 px**（网格步长 = 帧边长 + 4） | ≥ 4 px | PASS |

---

## 7. 离线与降级（T064 / SC-007 / SC-012 / FR-021 / FR-022）

真实 Chromium（headless，CDP + 真实时间，每视口独立重载）：

| 检查 | 结果 |
|---|---|
| **外部请求数** | 观测 **199** 个请求，**外部 0** ⇒ SC-012 PASS |
| 资产加载 | 控制台 `[assets] 38 assets ready`（无降级） |
| **人为损坏单个 HD 资产**（从 `dist/` 删除 `enemy-gunner-*.png`） | 控制台 `[assets] 1 of 38 assets degraded to placeholder art (the game is unaffected): enemy.gunner`；**canvas 仍在（2 个）**、标题正常、**崩溃 0 次、黑屏 0 次**；外部请求仍为 0 ⇒ SC-007 / FR-022 PASS |
| 逐条目隔离 | 恰好 **1** 个 id 降级，其余 37 个不受影响 |

---

## 8. 浏览器像素验收（T057 / T058 / SC-009 客观部分）

`production/m18-probe.mjs`（临时工具，复用 M17 的 CDP 模式）在每个视口独立重载后截图，
并对截图做客观测量。**「无像素块放大」的机器判据**：扫描线上相邻同色像素的平均游程 ——
8.64× 放大的像素画会给出 ≈ 8–9 px，HD + `linear` 给出 1–3 px。

| 视口 | 场景 bbox | 颜色数 | **meanRun** | 相邻像素相异比 | 房间短边/视口短边 | 完整可见 |
|---|---|---|---|---|---|---|
| 1920×1080 | 864×864 | 2331 | **2.85 px** | 35.0% | **80.0%** | YES |
| 2560×1440 | 1152×1152 | 5766 | **3.36 px** | 29.7% | **80.0%** | YES |
| 3840×1080（32:9） | 864×864 | 5480 | **2.83 px** | 35.3% | **80.0%** | YES |
| 1080×1920（9:16） | 864×864 | 5168 | **2.83 px** | 35.3% | **80.0%** | YES |
| 800×600 | 480×480 | 3158 | **2.30 px** | 43.4% | **80.0%** | YES |
| **T058** 30×30 压测房 @z=2.88 DPR1 | 864×864 | **12579** | **2.06 px** | **48.5%** | — | YES |

**结论（机器部分）**：
- meanRun **2.06–3.36 px** ⇒ **不存在像素块放大**（像素画会 ≥ 8 px）；
- 颜色数 2311–12579 ⇒ 场景确实是**带纹理的 HD 画面**，而非纯色块（旧管线为数十色）；
- 压测房缩小 4.4× 时 meanRun 2.06、相异比 48.5%，**无周期性摩尔纹特征**（mipmap 生效）；
- M17 的房间适配语义在 HD 资产下**保持**：5 个视口短边占比恒 **80.0%**、居中、零裁剪。

截图：`production/m18-shots/{v1,v2,v5a,v5b,v6}-*.png`、`moire-stress-1920x1080.png`。

> **⚠️ 主观部分登记为 PENDING**（见 §11）：SC-001 / SC-002 / SC-009 的「清晰 / 可区分 / 无锯齿」
> 含人类观察判定，机器结果**不冒充**主观通过。

---

## 9. 变异实验（T065 / 宪法 Principle IV）

三处门控/条件分支各做「临时破坏 → 确认预期断言确实失败 → **从备份还原**」（**未使用** `git checkout --`）：

| # | 位置 | 破坏方式 | 失败用例 | 证据 |
|---|---|---|---|---|
| 1 | `GameRenderer.wallPartIndex` | 忽略掩码，恒返回 0 | **3 条** | `T031 … resolves EVERY mask…` · `…opposite ends` · `…47-way reduction` |
| 2 | `GameRenderer.isLoopingAction` | 恒返回 false（无剪辑循环） | **2 条** | `the idle clip WRAPS instead of freezing` · `the move clip WRAPS…` |
| 3 | `manifest.isHdWorldArt` | 恒返回 false（不覆盖全局过滤） | **2 条** | `samples every HD world-art texture with linear…` · `applies the override BEFORE the sheet is parsed…` |

三处破坏后均从 `production/m18-mutation-backups/*.bak` 还原，`cmp` **逐字节相同**，
且 `grep -rn "MUTATION EXPERIMENT" client/` **无残留**。备份目录已清理。

---

## 10. quickstart V1–V11 对照（T069）

| 编号 | 场景 | 对应 SC | 判定 | 证据 |
|---|---|---|---|---|
| V1 | `src/` 零改动 | SC-007 | **PASS** | §2 |
| V2 | 逐 Tick 不变 + 摘要逐位 | SC-006 | **PASS** | 摘要 `f52dfdd4` |
| V3 | 像素资产/生成器/源包残留 = 0 | SC-008 | **PASS** | `atlas/`·`raw/`·`tools/` 均不存在；`client/ assets/ tests/ src/` 无 `build-atlas` 引用（仅退役登记与断言）；产物无旧像素资产；删 HD 资产 ⇒ 构建**响亮失败**（T048） |
| V4 | 许可可追溯 / 体积达标 | SC-013 / SC-014 | **PASS** | 每个 id 在 `LICENSES.md` 中以 `` `id` `` 出现；白名单显式；无发行商名；§6 体积 |
| V5 | 降级仍可玩 | SC-007 | **PASS** | §7 |
| V6 | HD 视觉验收 8 项 | SC-001…005 / SC-009 / SC-016 | **客观部分 PASS，主观部分 PENDING** | §8 + §11 |
| V7 | 性能比值 ≤ 1.2 | SC-010 | **PASS** | 中位数 0.970 |
| V8 | 离线零外部请求 | SC-012 | **PASS** | 199 请求 / 0 外部 |
| V9 | 场景图 6 条冻结契约 | SC-011 | **PASS** | F1–F6 逐字未改且通过 |
| V10 | 变异实验证据 | Principle IV | **PASS** | §9 |
| V11 | 动画连续性三项计数 = 0 | SC-015 | **PASS** | `skipped=0 blank=0 lockedUp=0` |

---

## 11. 主观判定登记（T071 / 沿用 M17 做法）

以下 SC 含**人类观察者**判定成分，**如实标注为 PENDING**，不以机器结果冒充通过：

| SC | 主观部分 | 机器可判部分（已完成） | 状态 |
|---|---|---|---|
| SC-001 | 「1 秒内正确说出朝向与动作，成功率 100%」 | 24 个动画键存在、帧标签与 `ActionState`/`facingRadians` 一致 | **PENDING（需 ≥1 名人类观察者）** |
| SC-002 | 「关闭颜色线索识别类别正确率 ≥ 90%」 | 六类剪影两两可区分（网格 + 行剖面） | **PENDING（需 ≥1 名人类观察者）** |
| SC-009 | 「观察者判定清晰、无锯齿比例 ≥ 90%」 | meanRun 2.06–3.36 px（无像素块放大）、mipmap 生效、无摩尔纹特征 | **PENDING（需 ≥1 名人类观察者）** |
| SC-016 | 「两类掉落物视觉上清晰可辨、不混淆」 | 三类剪影两两不同 + 仅危险环为**空心**（应躲避） | **PENDING（需 ≥1 名人类观察者）** |

---

## 12. 已登记的偏离与解释（如实披露）

| # | 项 | 说明 |
|---|---|---|
| **DEV-1** | **T053 的「伤害数字改用 HD 帧」未按字面实现** | **冻结**的 `tests/render/juice-verify.test.ts`（**不在**授权更新集内，FR-028）断言浮动数字是 `Text` 节点且 `.text === '-10'`；`juice_m14` 亦以 `Text` 计数守卫粒子层。FR-028 优先级高于任务措辞，且 `contracts/hd-asset-manifest.md` §2 本身允许「`fx.damage-font`（**或等价**）」。已取「等价」分支：数字仍为 `Text`，但样式改为 HD 调色板（暖白填充 + 深色描边）。**未**新增 `fx.damage-font` 图集（无消费者 ⇒ 避免死资产与无谓的许可登记）。 |
| **DEV-2** | **`ANIM_FRAME_MS.death` 由 150 改为 45 ms** | 死亡剪辑必须**在死亡 FX 窗口内走完**（`DEATH_FADE_MS` = 400 ms），否则「停在末帧」（D13 / T015）在物理上不可达：8 帧 × 150 ms = 1200 ms > 400 ms。45 ms × 8 = 360 ms，末帧停留 40 ms。这是**表现层调参常量**，非契约。同时把死亡剪辑的推进移出 `isDying` 短路（`syncTransforms`），使剪辑真正播放而非冻结在首帧。 |
| **DEV-3** | **T049「删除占位生成器与占位图集」未执行** | 该任务的前提是「真实 HD 美术已就位」。当前**没有**真实 HD 美术，占位图集**就是**本里程碑交付的 HD 资产，其可复现来源即 `production/m18-placeholder-atlases.mjs`。因此两者**保留**；生成器已在 `assets/art/LICENSES.md` §2 与 `assets/art/hd/README.md` 中如实登记为「本仓库原创 · 程序化生成」。真实美术到位后应执行 T049。 |
| **DEV-4** | **UI 图标图集迁移路径** | `assets/art/atlas/ui.{png,json}`（被 `ui.icon.*` 引用）**字节未变**地迁移到 `assets/art/ui/icons.{png,json}`，`manifest.ts` 随之改指。这样 `assets/art/atlas/**` 才能被完整删除（T044），同时**不删任何 id**（`ui.icon.*` 仍存在），从而无需放宽「资产集合覆盖」断言。 |
| **DEV-5** | **Phase 2 的 checkpoint 无法独立达成** | `tasks.md` 要求 Phase 2 结束时「五道闸门仍全绿」。但 T009 把 `TILE_NATURAL_PX` 由 16 改为 128，**按构造**就会打破 `tests/render/player_art.test.ts` 的缩放字面量（0.625 = 10/16），而修复该字面量的 T014 属 US1。因此 Phase 2 的绿灯只能与 US1/US2/US3/US8 的测试更新**同批**达成。本实现按该合并批次推进，最终 947 例全绿。I1 真正要防的「`tests/assets/*` 长期为红」已通过把 T012/T013 并入 Phase 2 原子批而避免。 |
| **DEV-6** | **`SHEET_DATA.animations` 用 `Record<string, string[]>` 而非 `readonly string[]`** | 契约 §2 的 schema 片段写 `readonly string[]`，但同一契约的 C1 要求该接口**无需 cast** 即可结构化赋值给 PixiJS `SpritesheetData`（其 `animations` 为 `Dict<string[]>`）。二者不可兼得；取 C1（真实可检查的性质）并在代码注释中说明。 |

---

## 13. 独立评审（T067 / 宪法 Principle IV）

由**未参与实现**的独立评审方（独立 agent，无实现上下文）按 `contracts/` 四份契约 +
`spec.md` 的 16 条 SC 逐条核对。评审方**自行**读取源码、`git diff` 并运行五道闸门与性能/无损测试。

### 13.1 评审结论

> **判定：CONCERNS**（非 FAIL）
> 四条阻塞项 + 若干强度发现。评审方明确肯定：`src/` 零改动、依赖集合不变、摘要
> `f52dfdd4`、冻结套件与管道钉桩未动、F1–F6 保持、`TILE_NATURAL_PX` 与 `meta.tilePx`
> 一致、47 部件完备、gutter 有效、白名单非空真、**无恒真断言**。

### 13.2 四条阻塞项与处置（T068）

| # | 评审发现 | 处置 | 状态 |
|---|---|---|---|
| **B1** | **交付的是程序化占位美术，不是真实 HD 美术** | **接受，升级为已知限制（见 §15）** | **OPEN（需产品决策）** |
| **B2** | `production/m18-evidence.md` 不存在，但 `GameRenderer.ts` 与 `README.md` 已引用 | **STALE —— 评审在证据文档落盘（15:40）之前完成**；该文件现已存在，引用有效 | **RESOLVED** |
| **B3** | 伤害数字未 HD 化，SC-016 的该子句未满足 | **接受，登记为 DEV-1**（FR-028 冻结套件优先于任务措辞；契约 §2 允许「或等价」） | **ACCEPTED（已登记，见 §12 DEV-1）** |
| **B4** | `manifest.ts` 注释称 UI 图标「BYTES unchanged」，但 `icons.json` 的 `meta.app` 被改过 | **已修**：注释改为「PNG 逐字节相同；JSON 仅差 `meta.app` 一个字段，因为它原本指向已删除的生成器」 | **RESOLVED** |

### 13.3 强度发现与处置

| # | 评审发现 | 处置 | 状态 |
|---|---|---|---|
| **S1** | `enemy_silhouette.test.ts` / `fx_art.test.ts` 只比较 `meta.silhouettes`，未解码 PNG ⇒ 元数据若陈旧则断言会空转 | **已修**：两个套件均新增「**从 PNG alpha 通道重算剪影并与声明逐项比对**」的用例（`tests/harness/png.ts::silhouetteOf`），随后**全部两两区分断言改跑在像素重算值上**（真值），而非声明值 | **RESOLVED** |
| **S2** | `isTransparent` 对越界矩形返回 `true` ⇒ gutter 断言可能空转 | **已修**：越界矩形现在**抛 `RangeError`**（探测越界是测试缺陷，不应静默通过） | **RESOLVED** |
| **S3** | `tests/performance/stress.test.ts` G2 是墙钟断言，负载下会失败 | **既有问题，非 M18 引入**（`production/m18-baseline.md` §1 已记录：基线全量跑即失败 1 例，单跑通过 7.67 < 9） | **PRE-EXISTING** |
| **S4** | FR-019「删文件 ⇒ 构建响亮失败」未被评审方实测到 | **已实测**（T048 / §10 V3）：真删 `assets/art/hd/tiles.png` ⇒ `Could not resolve "../../assets/art/hd/tiles.png?url"`，退出码 1，随后从备份还原并 `cmp` 校验 | **EVIDENCED** |

### 13.4 评审后复跑（T068 要求的门禁重跑）

| 闸门 | 结果 |
|---|---|
| `npm test` | **948 通过 / 0 失败**（S1 新增 1 例） |
| `npm run typecheck` / `typecheck:client` / `npm run lint` | 全部 PASS |
| `npm run build` | PASS |

---

## 14. 已知限制（评审 B1 升级登记）

### L1 · 本里程碑交付的是**程序化占位 HD 美术**，不是最终美术（OPEN）

**事实**：`assets/art/hd/**` 的 9 张图集全部由 `production/m18-placeholder-atlases.mjs`
程序化绘制（本仓库原创、CC0-1.0、逐项登记）。其**结构**完整满足契约（24 个玩家动画键 /
6 类敌人各 20 键 + `dash` 别名 / 128 基准 / 格内三带 / 47 部件 autotile / 8 地面变体 /
gutter 4px / `meta.silhouettes` 与像素一致），但**画面质量是占位级**：几何化色块、
无手工描边与光影、风格统一但表现力有限。

**为什么这样交付**：`research.md` R1 已把「高清 4 向多动作 CC0 素材极稀缺」列为**最高风险**，
并给出缓解方向「优先选用开放许可的高清素材包，缺口以本仓库**原创或程序化生成**补齐」。
`tasks.md` T003/T004 本身就把「程序化占位 HD 图集」列为 Setup 阶段的交付物，T049 再在
「真实美术已就位后」删除它们。因此**管线已完整交付，美术替换是后续的内容任务**。

**未闭合的任务**：T049（删除占位生成器与占位图集）。真实美术到位后应：
① 按 `assets/art/hd/README.md` 的命名与打包契约产出真实图集；
② 执行 T049；③ 复跑五道闸门（`tests/assets/*` 的图集形态断言会自动校验新图集）。

**这需要产品决策**：是否接受「占位美术 + 完整管线」作为 M18 的交付边界，或必须在本里程碑内
补齐真实美术。**本实现不擅自把占位美术宣称为最终美术。**

### L2 · SC-016 的「伤害数字」子句未满足（已登记 DEV-1）

见 §12 DEV-1。冻结的 `tests/render/juice-verify.test.ts`（**不在**授权更新集内，FR-028）
断言浮动数字必须是 `Text` 节点且 `.text === '-10'`。**这是规格内部的真实冲突**
（FR-028 vs T053 措辞），处置为「保留 `Text`、样式 HD 化」并**如实登记该子句未满足**。
若要真正满足，需先修订 FR-028 或豁免 `juice-verify`。

### L3 · 主观判定（SC-001 / SC-002 / SC-009 / SC-016）

见 §11，全部标注 **PENDING（需 ≥1 名人类观察者）**。

### L4 · 既有墙钟断言的负载敏感性

`tests/performance/stress.test.ts` G2 为**既有**断言（M15 引入），在 CPU 争用下会失败；
M18 未改动它，且 `vitest.config.ts` 已按 M17 的先例限制 worker 并发。见 §13.3 S3。

