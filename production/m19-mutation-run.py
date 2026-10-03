"""M19 · T055 mutation experiments M1-M6 (one-off driver).

For each mutation: back up -> break -> run the guarding test -> record the failure ->
restore BYTE-FOR-BYTE from the backup -> verify the sha256 is back to the original.

`git checkout --` / `git restore` / `git stash` are NEVER used: the restore is a plain
file copy from a snapshot taken before the first mutation, and every restore is
verified by hash. The driver deletes itself' — no, it stays until the operator removes it.

Run: <python> production/m19-mutation-run.py
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys

ROOT = r"D:\Project\Wkbd-project\my-hades"
os.chdir(ROOT)

BACKUP = os.path.join("production", "m19-mutation-backup")
LOG = os.path.join("production", "m19-mutation-log.md")

# The files any mutation touches. A fresh snapshot is taken at the start so the
# restore is a copy from a known-good state, not a reconstruction.
FILES = [
    "index.html",
    "client/UIManager.ts",
    "client/ui/quality.ts",
    "client/ui/boon-presentation.ts",
    "client/ui/status-panel.ts",
]

MUTATIONS = [
    {
        "id": "M1",
        "what": "品质 → class 映射塌缩（UIManager 的 RARITY_CLASSES.epic 改成 common 的类名）",
        "file": "client/UIManager.ts",
        "old": "  epic: 'boon-rarity-epic',",
        "new": "  epic: 'boon-rarity-common',",
        "test": "tests/ui/boon-card.test.ts",
        "guard": "T023 · maps each card rarity to the `boon-rarity-*` class the manager emits",
    },
    {
        "id": "M2",
        "what": "描述数值脱离逻辑层（zeus_strike 的 damage 硬编码成 999）",
        "file": "client/ui/boon-presentation.ts",
        "old": "      return { damage: config.damage };",
        "new": "      return { damage: 999 };",
        "test": "tests/ui/boon-description.test.ts",
        "guard": "描述数值与逻辑层一致（双通道，含真实掉血）",
    },
    {
        "id": "M3",
        "what": "Tab 面板获得通往模拟的通道（togglePanel 签名加上 world 形参）",
        "file": "client/UIManager.ts",
        "old": "  public togglePanel(): void {",
        "new": "  public togglePanel(world: unknown): void {",
        "test": "tests/ui/status-panel-nopause.test.ts",
        "guard": "T031 · togglePanel takes no World / simulator and cannot reach one",
    },
    {
        "id": "M4",
        "what": "降级回退被移除（品质卡片在无框体图时的实心品质边框改成 transparent）",
        "file": "index.html",
        "old": "        border-color: var(--rarity-common);",
        "new": "        border-color: transparent;",
        "test": "tests/ui/ui_degradation.test.ts",
        "guard": "T047 · falls the boon card back to a solid quality border when the frame is `none`",
    },
    {
        "id": "M5",
        "what": "面板集合不一致（readOwnedBoonIds 只返回第一个已拥有祝福）",
        "file": "client/ui/status-panel.ts",
        "old": "  return modifiers?.modifiers ?? [];",
        "new": "  return (modifiers?.modifiers ?? []).slice(0, 1);",
        "test": "tests/ui/status-panel.test.ts",
        "guard": "面板集合 == 玩家实际拥有集合（SC-005）",
    },
    {
        "id": "M6",
        "what": "槽位只声明不消费（.hud-dash 不再引用 var(--ui-frame-dash)）",
        "file": "index.html",
        "old": "        border-image-source: var(--ui-frame-dash);",
        "new": "        border-image-source: none;",
        "test": "tests/ui/ui_degradation.test.ts",
        "guard": "T047 · every M19 slot is CONSUMED, not merely declared",
    },
]


def sha256(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def run_test(test_path: str) -> tuple[int, str]:
    env = dict(os.environ, NO_COLOR="1")
    proc = subprocess.run(
        ["npx", "vitest", "run", test_path, "--reporter=basic"],
        capture_output=True,
        text=True,
        env=env,
        shell=True,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main() -> int:
    # ---- fresh snapshot -------------------------------------------------------
    os.makedirs(BACKUP, exist_ok=True)
    original: dict[str, str] = {}
    for path in FILES:
        target = os.path.join(BACKUP, path)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(path, target)
        original[path] = sha256(path)
    with open(os.path.join(BACKUP, "ORIGINAL-SHA256.txt"), "w", encoding="utf-8") as handle:
        for path, digest in original.items():
            handle.write(f"{digest} *{path}\n")

    rows: list[dict[str, object]] = []

    for mutation in MUTATIONS:
        path = str(mutation["file"])
        with open(path, "r", encoding="utf-8", newline="") as handle:
            before = handle.read()
        if before.count(str(mutation["old"])) != 1:
            rows.append(
                {
                    **mutation,
                    "applied": False,
                    "failed": None,
                    "detail": f"锚点不唯一/未找到（count={before.count(str(mutation['old']))}）",
                    "restored": False,
                }
            )
            continue

        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(before.replace(str(mutation["old"]), str(mutation["new"])))

        code, output = run_test(str(mutation["test"]))
        failed = code != 0
        failed_names = re.findall(r"^\s*(?:FAIL|×|✗)\s+(.+)$", output, re.MULTILINE)[:4]

        # ---- restore BYTE-FOR-BYTE from the snapshot --------------------------
        shutil.copy2(os.path.join(BACKUP, path), path)
        restored = sha256(path) == original[path]

        rows.append(
            {
                **mutation,
                "applied": True,
                "failed": failed,
                "detail": " | ".join(n.strip() for n in failed_names) or "(no failing test name parsed)",
                "exit": code,
                "tail": "\n".join(output.strip().splitlines()[-6:]),
                "restored": restored,
            }
        )

    # ---- final integrity ------------------------------------------------------
    final = {path: sha256(path) for path in FILES}
    all_restored = all(final[path] == original[path] for path in FILES)

    lines: list[str] = []
    lines.append("# M19 · T055 变异实验日志（M1–M6）\n")
    lines.append(
        "> 纪律：每次「破坏 → 确认对应断言**真的失败** → **从快照逐字节还原** → 以 sha256 校验还原」。\n"
        "> **未**使用 `git checkout --` / `git restore` / `git stash`。\n"
        "> 驱动脚本：`production/m19-mutation-run.py`（一次性工具）。\n"
    )
    lines.append("## 结果总表\n")
    lines.append("| # | 破坏点 | 目标文件 | 守卫测试 | 断言是否失败 | 还原是否逐位一致 |")
    lines.append("|---|---|---|---|---|---|")
    for row in rows:
        if not row.get("applied"):
            ok = "**未应用（锚点未命中，需修正实验）**"
        elif row.get("failed"):
            ok = "**是（断言有效）**"
        else:
            ok = "**否 ⇒ 断言无效，记为缺陷**"
        if not row.get("applied"):
            rest = "n/a（未应用）"
        else:
            rest = "是" if row.get("restored") else "**否 ⇒ 严重**"
        lines.append(
            f"| {row['id']} | {row['what']} | `{row['file']}` | `{row['test']}` | {ok} | {rest} |"
        )

    lines.append("\n## 逐条证据\n")
    for row in rows:
        lines.append(f"### {row['id']} · {row['what']}\n")
        lines.append(f"- 目标文件：`{row['file']}`")
        lines.append(f"- 守卫测试：`{row['test']}`")
        lines.append(f"- 期望守卫的断言：{row['guard']}")
        lines.append(f"- 破坏：`{row['old']}` → `{row['new']}`")
        lines.append(f"- 实测退出码：`{row.get('exit', 'n/a')}`；捕获到的失败用例：{row['detail']}")
        if row.get("tail"):
            lines.append("- 测试输出尾部：\n\n```text\n" + str(row["tail"]) + "\n```\n")
        lines.append(f"- 还原后 sha256 与快照一致：{'是' if row.get('restored') else '否'}\n")

    lines.append("## 还原完整性（实验结束后全量校验）\n")
    lines.append("| 文件 | 快照 sha256 | 实验后 sha256 | 一致 |")
    lines.append("|---|---|---|---|")
    for path in FILES:
        lines.append(
            f"| `{path}` | `{original[path][:16]}…` | `{final[path][:16]}…` | "
            f"{'是' if final[path] == original[path] else '**否**'} |"
        )
    lines.append(f"\n**结论：{'全部逐字节还原成功' if all_restored else '存在未还原文件（严重）'}。**\n")

    with open(LOG, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))

    print("\n".join(lines[: 3 + len(rows) + 2]))
    print(f"\n[log] {LOG}")
    print(f"[integrity] all_restored={all_restored}")
    return 0 if all_restored else 1


if __name__ == "__main__":
    sys.exit(main())
