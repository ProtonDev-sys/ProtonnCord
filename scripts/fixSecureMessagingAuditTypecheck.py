import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"expected exactly one match in {path}, found {count}: {old!r}")
    path.write_text(text.replace(old, new, 1))


test_path = ROOT / "scripts/testSecureMessaging.ts"
replace_once(
    test_path,
    """    reviewGate.begin(ALICE_ID, BOB_ID);\n    reviewGate.fail(ALICE_ID, BOB_ID, \"new-key-message\");\n    reviewGate.finish(ALICE_ID, BOB_ID);""",
    """    reviewGate.begin(ALICE_ID, BOB_ID, \"new-key-message\", 20);\n    reviewGate.fail(ALICE_ID, BOB_ID, \"new-key-message\");\n    reviewGate.finish(ALICE_ID, BOB_ID, \"new-key-message\");""",
)
replace_once(
    test_path,
    """    reviewGate.begin(ALICE_ID, BOB_ID);\n    reviewGate.begin(ALICE_ID, BOB_ID);\n    reviewGate.finish(ALICE_ID, BOB_ID);""",
    """    reviewGate.begin(ALICE_ID, BOB_ID, \"retry-key-message\", 30);\n    reviewGate.begin(ALICE_ID, BOB_ID, \"retry-key-message\", 30);\n    reviewGate.finish(ALICE_ID, BOB_ID, \"retry-key-message\");""",
)
replace_once(
    test_path,
    "    reviewGate.finish(ALICE_ID, BOB_ID);\n    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), false);",
    "    reviewGate.finish(ALICE_ID, BOB_ID, \"retry-key-message\");\n    assert.equal(reviewGate.isBlocked(ALICE_ID, BOB_ID), false);",
)

decrypt_path = ROOT / "src/equicordplugins/secureMessaging.desktop/decryptCache.ts"
decrypt_text = decrypt_path.read_text()
cast_count = 0
for pattern, replacement in (
    (r"(?m)^(\s*result\s*=\s*)expanded(\s*;)", r"\1expanded as DecryptIncomingResult\2"),
    (r"(?m)^(\s*:\s*)expanded(?=\s*[,;)])", r"\1(expanded as DecryptIncomingResult)"),
    (r"(?m)^(\s*return\s+)expanded(\s*;)", r"\1expanded as DecryptIncomingResult\2"),
):
    decrypt_text, count = re.subn(pattern, replacement, decrypt_text)
    cast_count += count

if cast_count == 0:
    print("No expansion cast was applied; generated decryptCache.ts lines 60-100 follow:")
    for line_number, line in enumerate(decrypt_text.splitlines()[59:100], start=60):
        print(f"{line_number:4}: {line}")
else:
    print(f"Applied {cast_count} DecryptIncomingResult expansion cast(s).")

decrypt_path.write_text(decrypt_text)
Path(__file__).unlink()
