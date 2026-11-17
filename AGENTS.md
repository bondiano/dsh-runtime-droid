# dsh-runtime-droid Contributor Guide

Cordis `agentRuntime` adapter (`@local/dsh-runtime-droid`) wrapping local Factory `droid exec` over bidirectional NDJSON `stream-jsonrpc`. See [README.md](README.md) and [../AGENTS.md](../AGENTS.md).

## Layout

- `index.ts`: Cordis plugin `apply` and `droid` runtime registration (`catalog({cwd})` via `droid.list_models`).
- `lib/`: `adapter.ts`, `rpc.ts`, `run.machine.ts` (`droidRuntimeSession` XState v5 machine).
- `test/`: `run-machine.test.ts`, `runtime.test.ts`.
- `dist/`: compiled TypeScript output (`tsc`).

## Invariants

- **JSON-RPC settings:** Droid 1.10.0 ignores CLI flags in JSON-RPC mode; pass `modelId`, `interactionMode`, `autonomyLevel`, `specModeModelId`, and compiled `disabledToolIds` through JSON-RPC (`load_session` reapplies tool allowlists).
- **Mission confirmation & Extra Usage:** Only supply `missionConfirmed: true` after real host user confirmation (never from an agent tool argument). Never auto-enable Factory Extra Usage.
- **Read-only review & spec:** Review/spec use `autonomyLevel: "off"` and explicit read-only tool lists; cancel `ExitSpecMode` in spec mode so approving a plan cannot trigger implementation.
- **Auth & usage honesty:** Rely strictly on local Factory auth; report only the last Factory usage notification (`raw` notifications preserved).
- **Committed `dist/`:** Commit compiled `dist/` after every edit.

## Verification

```sh
npm ci
npm run check     # tsc --noEmit && tsc && node --test dist/test/*.test.js
```

Sync `../machines` if `lib/run.machine.ts` changes, and update `../repositories.json` snapshot metadata when files here change.
