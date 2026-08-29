from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/apply-secure-messaging-performance-test.yml"
SCRIPT = Path(__file__)


def replace_once(path: str, old: str, new: str) -> None:
    file = ROOT / path
    source = file.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old.splitlines()[0]!r}")
    file.write_text(source.replace(old, new, 1))


replace_once(
    "package.json",
    '        "testSecureMessaging": "tsx scripts/testSecureMessaging.ts",\n',
    '        "testSecureMessaging": "tsx scripts/testSecureMessaging.ts",\n        "testSecureMessagingPerformance": "tsx scripts/testSecureMessagingPerformance.ts",\n',
)
replace_once(
    "package.json",
    "pnpm testMessageEventsPriority && pnpm testMainProcessStdio && pnpm testSecureMessagingOptimisticRendering",
    "pnpm testMessageEventsPriority && pnpm testMainProcessStdio && pnpm testSecureMessagingPerformance && pnpm testSecureMessagingOptimisticRendering",
)
replace_once(
    ".github/workflows/test.yml",
    '''            - name: Test Secure Messaging layout stability
              run: pnpm exec tsx scripts/testSecureMessagingLayoutStability.ts

            - name: Benchmark Secure Messaging
''',
    '''            - name: Test Secure Messaging layout stability
              run: pnpm exec tsx scripts/testSecureMessagingLayoutStability.ts

            - name: Test Secure Messaging performance boundaries
              run: pnpm testSecureMessagingPerformance

            - name: Benchmark Secure Messaging
''',
)

WORKFLOW.unlink()
SCRIPT.unlink()
