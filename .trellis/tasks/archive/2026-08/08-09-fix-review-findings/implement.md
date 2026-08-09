# Implementation Plan

1. Repair `ui/app.js` syntax, display strings, and terminal elapsed refresh behavior.
2. Update `src/ui.ts` authorization routing and extend Web UI tests for token-enabled static assets plus JavaScript syntax.
3. Fix TUI polling/manual refresh behavior and add focused tests or extract a minimal test seam if necessary.
4. Restore Node 20 dependency compatibility and synchronize all 0.11.0 manifests and lock metadata.
5. Run `node --check ui/app.js`, `npm run lint`, `npm run format:check`, and `npm test`.
6. Review the final diff for scope, security boundaries, and missing regression coverage.

## Rollback

- Revert only files changed by this task if a repair cannot preserve existing API/authentication behavior.
- Do not revert unrelated user or generated changes.
