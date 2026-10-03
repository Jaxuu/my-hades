# 快速验收指南：高清 2D 美术与动画资产替换（M18）

> 本文件是**可执行的验收剧本**，用于证明本特性端到端成立。
> 结构与规则见 `data-model.md` 与 `contracts/`；不重复其中的细节。
> 全部命令在仓库根目录执行（`D:/Project/Wkbd-project/my-hades`）。

## 0. 前置条件

- Node ≥ 22，依赖已安装（`node_modules/` 就位）。
- 工作树干净或已知变更范围（`git status --short`）。
- 若要跑浏览器视觉验收：本机 Chromium 可用（M17 的 `production/m17-probe.mjs` 是既有的 CDP 客户端先例，零依赖，可复用其模式）。

## 1. 五道闸门（必过，机器判定）

```bash
npm test                 # Vitest：全部用例；要求 0 失败，总数 ≥ 893
npm run typecheck        # 逻辑内核 + DOM-less 程序（不含 client/）
npm run typecheck:client # 表现层（tsconfig.client.json）
npm run lint             # ESLint（AST 门禁，仅 src/**）
npm run build            # Vite 构建（唯一引用点 ⇒ 缺资产即失败）
```

**期望**：五条全绿。任一失败即特性未完成。

> `npm test` 摘要建议加 `NO_COLOR=1` 以便 grep。

## 2. 纯表现层证明（V1 — 对应 SC-007 / FR-011）

```bash
git diff --stat src/
```

**期望**：**空输出**（`src/` 改动文件数 = 0）。

```bash
git diff --stat -- src/ | tail -1   # 期望：无输出
git status --short -- src/          # 期望：无输出
```

## 3. 玩法逐 Tick 不变（V2 — 对应 SC-006 / FR-012）

用固定种子 + 固定输入序列，分别对「改动前」与「改动后」跑同一段模拟，比较：

1. 逐 Tick 的状态序列（差异处数 MUST = 0）；
2. **快照摘要**（`listEntities() × listComponents()` 拼串过 FNV-1a）。

**期望**：摘要**逐位相同**。已知基线摘要值：`f52dfdd4`（M15 / M16 / M17 同值）。

> ⚠️ 纪律：**既有测试全绿 ≠ 无损**。必须用摘要自证，不能用「测试通过」推断。

## 4. 旧像素资产彻底移除（V3 — 对应 SC-008 / FR-016…FR-020）

```bash
ls assets/art/atlas/ 2>/dev/null      # 期望：不存在（或为空）
ls assets/art/tools/build-atlas.py 2>/dev/null   # 期望：不存在
ls assets/art/raw/ 2>/dev/null        # 期望：不存在（或已退役）
grep -rn "build-atlas" --include="*.ts" --include="*.json" --include="*.mjs" --include="*.md" . \
  --exclude-dir=node_modules --exclude-dir=specs | grep -v "^./specs" || echo "无残留引用"
npm run build                          # 期望：成功
ls dist/ | grep -iE "atlas/(player|enemies|tiles|fx|ui)" || echo "产物中无旧像素资产"
```

**期望**：像素图集、生成器、像素源包残留数 = 0；构建成功；产物中不含旧像素资产。

> **口径（`research.md` D19）**：SC-008 的「残留数 = 0」限定为**在范围内的世界美术** —— `assets/art/atlas/**`、`assets/art/raw/**`、`assets/art/tools/build-atlas.py`。`assets/art/ui/*.png`（界面贴图）与 `assets/audio/**` 依 **FR-030 保留**，须在验收报告中显式登记为「FR-030 授权保留」，**不计入**残留数。若不显式登记口径，SC-008 会与 FR-030 相互矛盾。

## 5. 资产许可与体积（V4 — 对应 SC-013 / SC-014 / FR-023 / FR-024）

- 逐项可追溯：每个 manifest id 以 `` `id` `` 形式出现在 `assets/art/LICENSES.md`（可追溯率 100%）。
- 无商业专有资产：许可登记与代码中 MUST NOT 出现已知发行商名称（保留 `/Supergiant/i` 断言并 SHOULD 扩展为发行商名单）。
- **许可白名单**：`CC0-1.0` · `Public Domain` · `CC-BY-4.0`（显式字面量列表）。GPL 与 CC-BY-SA 默认排除（`research.md` D17）。
- **体积（构建产物实测）**：单文件 **≤ 3 MB** · 总量 **≤ 12 MB** · 单张图集 **≤ 4096²**（目标 ≤ 2048²）· 图集数 **≤ 12**（`research.md` D3）。
- 图集内相邻帧 **≥ 4px gutter**（防 mipmap 渗色，D8）。

## 6. 降级仍然可玩（V5 — 对应 SC-007 / FR-022）

1. 正常启动游戏，确认画面使用 HD 资产。
2. **人为损坏/移除单个 HD 资产文件**（保留其余），重新构建并启动。
3. **期望**：该处回退到既有 `Graphics` 几何或静默；其余部分不受影响；**崩溃 0 次、黑屏 0 次**；游戏仍可操作。

> 逐条目隔离是契约：一个坏文件 MUST NOT 拖垮整个清单。

## 7. 浏览器视觉验收（V6 — 对应 SC-001 / SC-002 / SC-003 / SC-004 / SC-005 / SC-009）

> M17 的教训：headless Chrome 的 `--virtual-time-budget` **无法**驱动异步启动 + rAF（画布恒为空）；必须用 **CDP + 真实时间**，且**跨极端尺寸原地 resize 会让 SwiftShader 丢画布** ⇒ 每个视口**独立重载**。复用 `production/m17-probe.mjs` 的模式。

| 编号 | 场景 | 判定 |
|---|---|---|
| V6-1 | 角色静止 / 四向移动 / 攻击 / 受击 / 冲刺（8 种情形） | 观察者 1 秒内正确说出朝向与动作，成功率 **100%** |
| V6-2 | 5 类敌人两两混合同屏，**关闭颜色线索** | 仅凭形态识别类别正确率 **≥ 90%** |
| V6-3 | 逐类别核验 | 每类都具备待机/移动/攻击/受击，比例 **100%** |
| V6-4 | 沿墙行走 | 视觉墙边界 == 碰撞边界，一致率 **100%** |
| V6-5 | 小型起始房 / 带柱子竞技场 / 30×30 压测房 | 拉伸·错位·空洞 **0 处** |
| V6-6 | 显示倍率 100%–400%（配合 M17 相机缩放） | 判定「清晰、无像素块放大、无可见锯齿」比例 **≥ 90%** |
| V6-7 | 墙体深度 | 能读出立面与顶面；立面**不遮挡**应可见的可通行地面（FR-010） |
| V6-8 | 命中 / 冲刺 / 危险预警 / 拾取 / 击杀 | 各类均呈现 HD 资产（无残留占位几何）；「应拾取」与「应躲避」两类**不混淆**（SC-016） |

## 8. 性能比值（V7 — 对应 SC-010 / FR-026）

- 场景：约 150 敌人同屏的压测房间（`?mode=stress`）。
- 口径：同机、同场景、同一脚本；**改动后 / 改动前** 的每帧耗时**中位数**；连续 **3 次**取中位数。
- **期望**：比值 **≤ 1.2**。
- ⚠️ **MUST NOT** 使用绝对墙钟阈值（宪法 Principle IV：绝对值随 CI 负载漂移可达 2 倍）。
- 补充：HD 图集加载 MUST NOT 阻塞游戏循环（首帧可交互）。

## 9. 离线零外部请求（V8 — 对应 SC-012 / FR-021）

- 断网启动游戏，完整走一遍「开局 → 战斗 → 清房 → 三选一 → 终局 → 营地 → 再开局」。
- **期望**：全部画面可用；对外部服务的请求数 = 0（DevTools Network 过滤 `http(s)` 应为空）。

## 10. 渲染场景图冻结契约（V9 — 对应 FR-027 / SC-011）

以下 6 条在改动后 MUST 继续成立（由 `tests/render/*` 守护）：

1. `stage` 唯一子节点 = camera；
2. `camera.children[last]` = root；
3. `root.children[last]` = fxLayer；
4. `root.children[0]` = 首个实体视图；
5. 无墙时 `camera.children` 长**恰 1**；
6. 空闲时 `fxLayer.children` 长**恰 0**。

**HD 墙体深度分层的注意点**：新增常驻节点必撞坏第 5 条 ⇒ 只能**惰性挂载**（先例：`staticLayer`、粒子层）或**常驻 + 显式同步钉桩**。墙体深度 SHOULD 落在**既有 wall node 内部**（wall node = Container，内部含顶面/立面子精灵），从而保持 `staticLayer.children.length === 1 + wallCount`。

## 11. 变异实验（门控类改动必做）

对每处门控/条件分支改动：

1. 临时破坏该条件；
2. 确认**预期断言确实失败**（记录失败用例数）；
3. 从**备份**还原（⚠️ MUST NOT 用 `git checkout --`）。

**期望**：每处改动都有对应的失败证据，证明断言真的在守护该行为。

## 12. 动画连续性量化验收（V11 — 对应 SC-015 / FR-006）

在连续 **600 帧**（约 10 秒）的观察窗口内，对玩家与敌人的动画逐项计数，三项 MUST 全部为 **0**：

| # | 计数项 | 阈值 |
|---|---|---|
| 1 | 相邻帧显示间隔 > 该动作标称帧时长 × **1.5** 的次数（跳帧） | 0 |
| 2 | 空白帧次数（动作切换前后出现无纹理帧 / 闪烁） | 0 |
| 3 | 除 `death` 外动作的单次连续显示时长 > 标称总时长 × **2** 的次数（僵直） | 0 |

- 机器判定：`tests/render/player_animation_continuity.test.ts`（US1 阶段产出）。
- 标称帧时长取自 `ANIM_FRAME_MS`（`client/GameRenderer.ts`）；**MUST NOT** 由逻辑 tick 推导（ADR-002）。

## 验收对照总表

| 编号 | 场景 | 对应 SC | 判定方式 |
|---|---|---|---|
| V1 | `src/` 零改动 | SC-007 | 机器（git diff） |
| V2 | 逐 Tick 不变 + 摘要逐位 | SC-006 | 机器（摘要比对） |
| V3 | 像素资产与生成器残留 = 0 | SC-008 | 机器（文件系统 + 构建） |
| V4 | 许可可追溯 / 体积达标 | SC-013 / SC-014 | 机器（构建产物实测） |
| V5 | 降级仍可玩 | SC-007 | 机器 + 人工 |
| V6 | HD 视觉验收（8 项） | SC-001…SC-005 / SC-009 / SC-016 | **人工观察者**（客观部分可机器判定） |
| V7 | 性能比值 ≤ 1.2 | SC-010 | 机器（比值口径） |
| V8 | 离线零外部请求 | SC-012 | 机器（Network） |
| V9 | 场景图 6 条冻结契约 | SC-011 | 机器（既有测试） |
| V10 | 变异实验证据 | 宪法 Principle IV | 人工评审 |
| V11 | 动画连续性三项计数 = 0 | SC-015 | 机器（600 帧窗口逐项计数） |

> ⚠️ **主观判定登记**：V6 的「清晰」「可区分」「不遮挡」含主观成分。按 M17 的既有做法，**客观部分机器判定、主观部分需 ≥1 名人类观察者**并如实登记 PENDING，不得以机器结果冒充主观通过。
