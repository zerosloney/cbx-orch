# Fix 24-hour review findings

## Goal

Repair all confirmed defects from the review of commits made during the preceding 24 hours and restore the v0.11.0 release checks.

## Requirements

- Make the external Web UI JavaScript syntactically valid and remove template-extraction residue.
- Preserve readable Chinese labels after moving JavaScript out of the TypeScript template.
- Allow the browser to load Web UI static assets when token authentication is enabled while keeping API and SSE authentication behavior intact.
- Keep terminal job elapsed time fixed after a job reaches a terminal status.
- Honor the TUI `--interval-ms` polling option and make manual refresh fetch current data.
- Keep the documented Node 20 runtime contract by selecting dependencies whose engine ranges support Node 20.
- Synchronize package, lockfile, marketplace, Claude, and ZCode versions at 0.11.0.
- Add focused regression coverage for the repaired behavior and strengthen the static Web UI validation gate.

## Acceptance Criteria

- [ ] `node --check ui/app.js` succeeds.
- [ ] The Web UI static JavaScript no longer contains copied HTML/template terminators or double-escaped display labels.
- [ ] With a configured UI token, `/`, `/style.css`, and `/app.js` load successfully without weakening authentication for `/api/*` or `/events`.
- [ ] Terminal job elapsed values remain based on `totalSeconds` during client-side refreshes.
- [ ] TUI polling uses the caller-provided interval and the refresh key triggers an immediate data fetch.
- [ ] All runtime dependencies support the package's declared Node `>=20` engine range.
- [ ] All release manifests and `package-lock.json` report version `0.11.0`.
- [ ] `npm run lint`, `npm run format:check`, and `npm test` pass.
- [ ] The working tree contains no unrelated changes.

## Constraints

- Preserve current API response contracts and the existing loopback-only Web UI binding.
- Do not expose authenticated API data through newly public routes; only immutable UI shell assets may be unauthenticated.
- Work with existing repository changes and do not revert unrelated work.
