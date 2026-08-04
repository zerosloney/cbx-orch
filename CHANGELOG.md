# Changelog

This project follows [Semantic Versioning](https://semver.org/). User-visible behavior changes, security fixes, and migration requirements are recorded here before a release.

## Unreleased

## 0.8.0 - 2026-08-04

- Publish to npm: `npm install -g cbx-orch` provides the global `cbx` command. Plugin MCP server now calls `cbx mcp`, so dependencies resolve via the global install instead of the plugin cache (fixes `MCP error -32000: Connection closed` caused by missing `node_modules`/`better-sqlite3` in the plugin cache).
- Add `cbx mcp` subcommand as the MCP stdio entrypoint.
- Add `publish.yml` GitHub Action: pushing a `v*` tag publishes to npm automatically (requires `NPM_TOKEN` secret).
- Add SQLite-backed durable state, queue, and dead-letter storage.
- Add governed executor plugin manifests, allowlists, and provenance events.
- Add CI quality gates and package supply-chain artifacts.
