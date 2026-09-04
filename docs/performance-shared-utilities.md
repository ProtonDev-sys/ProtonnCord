# Shared utility work counts, 4 September 2026

Actual source from `9ac53cac3` and the working tree runs through the same synthetic fixture. Across 100 renders of one unchanged offscreen element, `useIntersection` produces these counts, including final unmount:

| Metric | Before | After |
| --- | ---: | ---: |
| Observer constructions | 100 | 1 |
| Observer disconnections | 100 | 1 |
| `checkIntersecting` calls | 100 | 1 |

The geometry check normally calls `getBoundingClientRect`; this fixture counts calls and mocks the result. These are deterministic work counts, not browser layout timings, CPU usage, or FPS measurements. Separately, dispatching the synthetic file input cancellation leaves the baseline `chooseFile` promise pending; the fixed version resolves `null`.

Run from the repository root with dependencies installed and the baseline commit available. This command reads both implementations without changing files and reuses the regression fixture:

```powershell
@'
const { readFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const baseline = '9ac53cac3';
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const harness = readFileSync('scripts/testUseIntersection.ts', 'utf8')
  .split('\ntest("')[0].replace(/^const source = .*;$/m, '') + '\nexports.fixture = fixture;';
const load = (name, before) => before ? execFileSync('git', ['show', `${baseline}:src/utils/${name}`], { encoding: 'utf8' }) : readFileSync(`src/utils/${name}`, 'utf8');
async function measure(before) {
  const exports = {};
  runInNewContext(compile(harness), { exports, require, source: load('react.tsx', before) });
  const { render, unmount, metrics } = exports.fixture();
  const target = { visible: false };
  for (let i = 0; i < 100; i++) render(target);
  unmount();
  let input, settled = false, result = 'pending';
  const web = {};
  runInNewContext(compile(load('web.ts', before)), {
    exports: web, setImmediate,
    document: { createElement: () => input = { style: {}, files: [], click() {} }, body: { appendChild() {}, removeChild() {} } }
  });
  web.chooseFile('text/plain').then(value => { settled = true; result = value; });
  await new Promise(setImmediate);
  input.oncancel?.();
  await new Promise(setImmediate);
  console.log(JSON.stringify({ source: before ? baseline : 'working tree', renders: 100, ...metrics, cancellation: { settled, result } }));
}
(async () => { await measure(true); await measure(false); })();
'@ | node
```

Expected output:

```json
{"source":"9ac53cac3","renders":100,"observers":100,"disconnects":100,"layoutReads":100,"cancellation":{"settled":false,"result":"pending"}}
{"source":"working tree","renders":100,"observers":1,"disconnects":1,"layoutReads":1,"cancellation":{"settled":true,"result":null}}
```

Run the seven focused regression checks with `pnpm exec tsx --test scripts/testChooseFile.ts scripts/testUseIntersection.ts`. They also cover file selection, empty selection, element replacement, observer mode changes, one-shot visibility, and cleanup. No application interaction or network access is required.
