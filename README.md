# Droid runtime

Cordis runtime adapter using the authenticated local Factory Droid CLI and its
bidirectional NDJSON JSON-RPC protocol. No Factory API key or alternative model
inference endpoint is introduced. Configure `command` when Droid is not on PATH.

Protocol checked against the official `@factory/droid-sdk@0.11.0` published
artifact and local Droid 1.10.0 help. The SDK is a reference, not a dependency.
Settings use `modelId`, `interactionMode`, `autonomyLevel`, `specModeModelId`;
JSON-RPC mode ignores corresponding CLI flags. Tool allowlists are compiled into
`disabledToolIds` using the runtime catalog and reapplied with load_session.

- [Exec protocol](https://docs.factory.com/droid-exec/overview)
- [Official SDK](https://docs.factory.com/sdk/typescript)
- [Plans and Missions Extra Usage](https://docs.factory.com/pricing/individuals)

The registry must supply `missionConfirmed: true` only following its actual user
confirmation. This internal marker is not an agent tool input. Missions use the
Factory scheduler and `interactionMode: mission`; Extra Usage is never enabled
by this plugin. Normal autonomy defaults to high, matching workstation allow.
Review/spec use autonomy off and should receive an explicit read-only tool list.
Spec ExitSpecMode is cancelled so that accepting a plan cannot start execution.

Permission and AskUser requests are emitted with their original payload and
answered by `respond(sessionId, requestId, result)`. Only offered permission
outcomes are accepted. Original notification payloads are retained in `raw`,
including Mission worker/feature state. Token usage is the last reported Factory
notification, not an invented session aggregate or subscription quota.

Run `npm test` for hermetic protocol/lifecycle fixtures. Live authenticated
inference and billable Mission execution are separate smoke checks.

## Model catalog

`catalog({cwd})` opens one temporary JSON-RPC session, reads `droid.list_models`,
closes the transport in `finally`, and sends no inference. The role-team
settings picker uses it for Factory model ids.
