# Dependency patches

## Stylelint 17.16.0 glob matching

`stylelint@17.16.0.patch` backports [Stylelint PR #9500](https://github.com/stylelint/stylelint/pull/9500), merged at [`12c034f5db042b474126b36231bd4ffe0ccc6e8d`](https://github.com/stylelint/stylelint/commit/12c034f5db042b474126b36231bd4ffe0ccc6e8d) on its version 18 branch. It replaces `globby`, `fast-glob`, `micromatch` and `globjoin` with `tinyglobby` and `picomatch`. This removes the dependency on `braces`, whose [GHSA-vfj7-8cjw-p6xm advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no fixed release as of 2026-10-12.

The backport retains Stylelint 17's rules, configuration and CLI parser. The only adaptation to the upstream source change is the whitespace of the CLI help text. The corresponding version-scoped `packageExtensions` and removal overrides in `pnpm-workspace.yaml` update the resolved dependency graph; pnpm package patches alone cannot change dependencies. No advisory is suppressed.

### Supported glob options

As in upstream PR #9500, the Node API's `globbyOptions` and the CLI's `--globby-options` accept only `braceExpansion`, `caseSensitiveMatch`, `dot`, `extglob`, `followSymbolicLinks` and `ignore`. Unsupported options throw a configuration error.

Use the top-level `cwd` option instead of `globbyOptions.cwd`. For an explicit ignore file, use `ignorePath` or `--ignore-path`. This reads only the named files, resolves patterns from `cwd`, and replaces the default `.stylelintignore` lookup; it does not reproduce globby's recursive `gitignore` discovery. Options such as `deep` and `expandDirectories` have no equivalent.

The repository uses none of these changed options: `pnpm lint-styles` still checks `src/**/*.css`, excludes `src/userplugins`, and uses the unchanged `.stylelintrc.json`. `scripts/testAuditStylelintGlobs.ts` exercises the installed package through its public API and CLI, including ignore ordering, dot directories, literal paths, autofix and deeply nested glob input.

### Updating or removing the backport

Keep the Stylelint version, patch and dependency overrides together. When a published Stylelint release includes the migration, check its compatibility with `stylelint-config-standard`, remove this patch and the scoped dependency entries, regenerate the lockfile, and rerun the glob regressions, normal CSS lint and full dependency audit. Do not carry this patch onto an unreviewed version automatically.

### Upstream license

The copied Stylelint changes retain the upstream MIT license:

Copyright (c) 2015 - present Maxime Thirouin, David Clark & Richard Hallows

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
