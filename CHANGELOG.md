# Changelog

## 1.0.0

- First public release.
- Derived from: `container/tools/hunter-mcp` at `3122d1c8` (2026-08-31) in the private ScalablyAI repository.
- Changes from production: the private tool-outcome envelope is replaced by a plain JSON reply, tool annotations added (`create_lead` is the only write tool), no functional change.
- Build changes: `fastmcp` 4 and `zod` 4 (production ran the 3.x lines); `z.record()` now takes two type arguments; a shebang line so the npm `bin` runs; the e2e test uses `localhost` and the current protocol version, and its invalid-argument assertion matches fastmcp 4's validation wording.
