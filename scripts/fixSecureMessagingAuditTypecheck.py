from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"expected exactly one match in {path}: {old!r}")
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
replace_once(
    decrypt_path,
    """            result = expanded.status === \"decrypted\"\n                ? { ...result, plaintext: expanded.plaintext }\n                : expanded;""",
    """            result = expanded.status === \"decrypted\"\n                ? { ...result, plaintext: expanded.plaintext }\n                : expanded as DecryptIncomingResult;""",
)

Path(__file__).unlink()
