# Complete source audit

The review is complete. See [results, validation and remaining limits](RESULTS.md).

This audit starts at `441b6a60c1e2e8242e54478d00247e2a6384661d` and covers every one of its 1,746 tracked files. Installed dependencies, Git internals, downloaded artifacts, and build outputs are outside the source inventory. Newly added implementation and test files also require a review record.

`inventory.json` freezes the path, owner, byte length, and SHA-256 of each baseline file. The owner ledgers in `reviews/` record only completed reviews, with a file-specific decision, evidence, and SHA-256 of the reviewed version. Any later edit invalidates that record until the change has been reviewed. Reading a filename, finding a search match, or passing a linter does not constitute a semantic review. Code reviews cover purpose, current callers, retained behavior, state ownership, asynchronous lifetime, error handling, and avoidable work. Generated data and assets are checked according to their format, generation path, and use.

Use `node scripts/checkSourceAudit.mjs` for progress, `--pending` for the unreviewed baseline paths, and `--require-complete` for the final coverage gate. The checker verifies the record structure; it cannot replace the underlying review. A completed review can retain a file or document a limitation without claiming a fix.

Changes remain in the isolated audit checkout until validation is complete. The installed official nightly client is separate from this checkout. Refactoring may replace internals, but must retain useful features and saved preferences or provide a tested migration. Performance claims require a stated workload and measurement limits.
