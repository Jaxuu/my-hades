# 音效资产许可登记（Audio Asset Licenses）

本文件是 **SC-010 的载体**：`client/assets/manifest.ts` 中每一个 `sfx.*` id 都必须能在此
反查到「来源素材包 / 作者 / 来源 URL / 许可 / 本项目做过的修改」。

**许可白名单**：`CC0-1.0`（Kenney 全部素材包均为 CC0，可商用、可再分发、无需署名）。
本仓库**不含**任何商业游戏的专有音频（FR-020）。

---

## 1. 来源素材包

| packName | author | sourceUrl | license |
|---|---|---|---|
| RPG Audio | Kenney | https://kenney.nl/assets/rpg-audio | CC0-1.0 |
| Digital Audio | Kenney | https://kenney.nl/assets/digital-audio | CC0-1.0 |
| UI Audio | Kenney | https://kenney.nl/assets/ui-audio | CC0-1.0 |

逐包 `License.txt` 随包保留：`raw/kenney_rpg-audio/License.txt`、
`raw/kenney_digital-audio/License.txt`、`raw/kenney_ui-audio/License.txt`。

## 2. 逐资产登记

| assetId | packName | author | sourceUrl | license | modifications |
|---|---|---|---|---|---|
| `sfx.hit` | RPG Audio | Kenney | https://kenney.nl/assets/rpg-audio | CC0-1.0 | 取 `knifeSlice.ogg`，原样复制 |
| `sfx.dash` | Digital Audio | Kenney | https://kenney.nl/assets/digital-audio | CC0-1.0 | 取 `phaserUp1.ogg`，原样复制 |
| `sfx.coin` | RPG Audio | Kenney | https://kenney.nl/assets/rpg-audio | CC0-1.0 | 取 `handleCoins.ogg`，原样复制 |
| `sfx.enemy-death` | Digital Audio | Kenney | https://kenney.nl/assets/digital-audio | CC0-1.0 | 取 `spaceTrash1.ogg`，原样复制 |
| `sfx.hazard-blast` | Digital Audio | Kenney | https://kenney.nl/assets/digital-audio | CC0-1.0 | 取 `lowRandom.ogg`，原样复制 |
| `sfx.ui-click` | UI Audio | Kenney | https://kenney.nl/assets/ui-audio | CC0-1.0 | 取 `click1.ogg`，原样复制 |
| `sfx.reward-select` | Digital Audio | Kenney | https://kenney.nl/assets/digital-audio | CC0-1.0 | 取 `powerUp1.ogg`，原样复制 |
| `sfx.death` | Digital Audio | Kenney | https://kenney.nl/assets/digital-audio | CC0-1.0 | 取 `lowDown.ogg`，原样复制 |
| `sfx.win` | Digital Audio | Kenney | https://kenney.nl/assets/digital-audio | CC0-1.0 | 取 `threeTone1.ogg`，原样复制 |

全部音效均为 **`.ogg`（Vorbis）**，经 Vite `?url` 静态导入，运行期零外部请求（FR-012）。

## 3. 体积（SC-011）

| 范围 | 实测 |
|---|---|
| `assets/audio/sfx/**`（随包分发） | 91 KB |
| 单文件最大 | `coin.ogg` 25 KB（预算 1 MB） |

`assets/audio/raw/**` 只保留实际使用的 9 个源文件与 3 份 `License.txt`（上游 `License.txt`
随包保留），供人工复核来源；未使用的音效已删除（体积从 1.9 MB 降到 167 KB）。

> **M18 注（FR-017）**：原先用于复制/派生这些音效的构建期脚本
> `assets/art/tools/build-atlas.py` 已随像素管线一并删除。音频资产本身**未改动**
> （FR-030 明确音频不在 M18 范围内），其来源仍可逐项追溯至下方素材包。
