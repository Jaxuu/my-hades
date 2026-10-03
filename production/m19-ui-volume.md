# M19 · UI 资产体积实测（T054 · FR-053 / SC-016）

**特性**：`027-hud-boon-ui`（M19 · UI 层重构） · **任务**：T054 · **作者**：林绘澄（美术总监） · **日期**：2026-10-03
**生成器**：`production/m19-ui-frames.mjs`（Node 零依赖，`node:zlib` 手工编码 PNG，**幂等**）

> **本文件是实测记录，不是验收断言。** 用户裁定 **U2（2026-10-03）**：**不设 UI 子预算** —— M19 新增 UI 资产**仅受 M18 全局预算**（单文件 ≤ 3 MiB / 总量 ≤ 12 MiB）约束。本文件**不新增任何更严的子预算断言**（`tests/assets/licenses.test.ts` 的 `MAX_FILE_BYTES` / `MAX_TOTAL_BYTES` 保持原值）。

---

## 1. 逐文件实测

| # | 文件 | 槽位（消费方） | 字节 | 尺寸 | 格式 |
|---|---|---|---|---|---|
| 1 | `assets/art/ui/frame-health.png` | `--ui-frame-health` | **198** | 48×48 | RGBA8（ct 6 / depth 8 / 非交错） |
| 2 | `assets/art/ui/frame-dash.png` | `--ui-frame-dash` | **198** | 48×48 | RGBA8 |
| 3 | `assets/art/ui/frame-boon-common.png` | `--ui-frame-boon-common` | **175** | 48×48 | RGBA8 |
| 4 | `assets/art/ui/frame-boon-epic.png` | `--ui-frame-boon-epic` | **207** | 48×48 | RGBA8 |
| 5 | `assets/art/ui/frame-boon-legendary.png` | `--ui-frame-boon-legendary` | **243** | 48×48 | RGBA8 |
| 6 | `assets/art/ui/panel-status.png` | `--ui-panel-status` | **212** | 48×48 | RGBA8 |
| 7 | `assets/art/ui/rule-bronze.png` | `--ui-rule` | **126** | 48×48 | RGBA8 |
| | **M19 新增合计** | | **1 359 B（≈ 1.33 KiB）** | | |

**格式自证**（IHDR 解析，无图像库）：7 个文件全部 `48×48`、bit depth `8`、colour type `6`（RGBA）、interlace `0` —— 与同目录既有 `assets/art/ui/slot.png`（RGBA8）同格式；尺寸与既有 48×48 九宫格框体（`frame-reward-card.png` / `panel-hud.png` / `panel-camp.png` 等）一致，满足 `border-image-slice: 12` 的几何要求。

> **格式说明（对既有目录的读法）**：`assets/art/ui/*.png` 现有两类格式 —— 旧 M16 白描框（`frame-reward-card.png` / `panel-hud.png` / `bar.png`）为 **1-bit 索引色（ct 3 / depth 1，2 色板：透明 + 纯白）**，而 `slot.png` 为 **RGBA8（ct 6）**。M19 采用 **RGBA8**，理由：① 交付规格明确要求 RGBA；② 与同目录 `slot.png` 一致；③ **品质色必须烘进线描**（design §2.4），2 色板无法承载「基色 + 亮色 + 暗色」三层（单/双/三线 + 高光/暗影）。旧白描框继续由 CSS `border-color` 着色，M19 的框体自带颜色，两条路径互不冲突。

---

## 2. 幂等自证（重复运行逐字节相同）

连续运行 `node production/m19-ui-frames.mjs` **两次**，比对 sha256：

| 文件 | sha256（两次运行一致） |
|---|---|
| `frame-health.png` | `dcd773fd3ad23d9c1586409b79458ee3b41ae93853e1c1be4865f8988bd08604` |
| `frame-dash.png` | `dcd773fd3ad23d9c1586409b79458ee3b41ae93853e1c1be4865f8988bd08604` |
| `frame-boon-common.png` | `10f913fd6d14b497d6839b2ec7eae7fda6388a421605ae96f83c676c3e731f56` |
| `frame-boon-epic.png` | `39cf85f5f81589ab4748525e09a0394aa61cac816bad845b5ddc094ca726b944` |
| `frame-boon-legendary.png` | `318fb19f60a08632b1407b39942437f97415476e85b0075f893f03d157f48232` |
| `panel-status.png` | `549704695e59cc474c5ca95d7199cda9160d4a9557ea78631c7bfe9958b20098` |
| `rule-bronze.png` | `68f3edc90075fe13bbdd23a0ef381bf7c37cc981a093f6dc19e7390bfb77dec8` |

`diff` 两次 sha256 清单为空 ⇒ **幂等成立**（无时间戳 / 无随机 / `deflateSync(level:9)` 确定性）。

> `frame-health.png` 与 `frame-dash.png` 哈希相同属**预期**：二者同属石/羊皮纸 HUD 材质家族（design §3.1 / §3.2 同一「M16 白描同族」），几何一致、分别经 `?url` 绑定到不同槽位。`panel-status.png` 为更重的**三线**面板框，几何独立。

---

## 3. 目录总量

| 范围 | 实测 |
|---|---|
| `assets/art/ui/**`（含 M19 新增） | **7 391 B ≈ 7.2 KiB** |
| `assets/art/ui/**`（M18 存量，= 总量 − M19 增量） | 6 032 B ≈ 5.9 KiB |
| **M19 新增** | **1 359 B ≈ 1.3 KiB** |
| `assets/art/**` 合计（含 9 张世界 HD 图集） | **596 821 B ≈ 582.8 KiB** |

---

## 4. 预算判定

| 口径 | 阈值 | 实测 | 判定 |
|---|---|---|---|
| **单文件** | ≤ **3 MiB**（3 145 728 B） | 最大新增文件 **243 B**（`frame-boon-legendary.png`） | ✅ **PASS**（占用 ≈ 0.008 %） |
| **总量** | ≤ **12 MiB**（12 582 912 B） | `assets/art/**` = **596 821 B** | ✅ **PASS**（占用 **4.74 %**） |
| **UI 子预算** | **不设**（用户裁定 U2） | — | —（**不适用**，本特性不新增子预算断言） |
| 单图集像素 | ≤ 4096² | 不适用（框体为 48×48 单帧，非图集） | — |

**结论：PASS** —— 7 个新增框体合计 **1 359 B**，最大单文件 **243 B**，`assets/art/**` 总量 **≈ 583 KiB**，均**远低于** M18 全局预算（单文件 ≤ 3 MiB / 总量 ≤ 12 MiB）。因 U3 取消图标资产、框体体积极小，M19 UI 的真实增量可忽略。

---

## 5. 备注

- `assets/art/LICENSES.md` §6 的 `assets/art/ui/** ≈ 22 KB` 为 **M18 快照**（实测存量实为 ≈ 5.9 KiB，该估算偏大）；M19 后的**权威实测**以本文件为准（`assets/art/ui/**` = **7 391 B**）。
- 本文件不修改 `tests/assets/licenses.test.ts` 的任何常量；该测试对 `assets/art/**` 的 `walk()` 汇总已自动涵盖 7 个新文件（合计 +1 359 B），仍远在阈值内。
- 生成器位于 `production/`（该目录 `*.mjs` 在 ESLint `ignores` 内），**不新增运行时依赖**。
