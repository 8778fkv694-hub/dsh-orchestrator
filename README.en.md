# DSH Orchestrator

[简体中文](README.md) | **English**

Turn confirmed intent into observable, verifiable, recoverable pipelines. A host-independent core, delivered first as a DeepSeek Harness plugin.

**Developer preview.** Runnable core and adapter code exists. Three primary real-model GUI scenarios passed on `66d252f`; on `67e0f7c` (cancellation-reconciliation fix) an additional real-GUI adverse suite passed (intent reject, no-answer skip, missing delivery, in-flight cancel, verified-after-cancel regression, gate reject). The three primary scenarios were not re-run on the fixed commit, and the cards were clicked by an authorized acceptance operator rather than the owner; see [status](STATUS.md) and [verification](docs/sdlc/test/verification.md).

## Principles

Human words are input. AI clarifies and restates a candidate; only human confirmation establishes formal Intent. Runs pin definition snapshots. The host retains control of tool execution and permissions. The `harness.userQuestions` source proves routing through the question channel, not who physically clicked; use additional identity and audit controls when delegated actions must be distinguished. Persist action IDs before dispatch, inspect unknown effects before recovery, and verify declared artifacts independently of model completion claims.

The method draws on Digital Employee's pipeline practice. This is an original implementation with no dependency on that application. [Pre-flight](https://github.com/8778fkv694-hub/pre-flight) provides the project guide, Intent, Spec and Plan; pipeline references pin their content hashes.

## Install in an isolated Harness profile

Requires Node 22+ and Harness plugin-bundle support. Runtime integration has been checked against `0.2.1-rc.3`; other versions require verification.

Download the repository and run:

```sh
npm test
npm run demo
npm pack
dsh plugin --profile orch-acceptance add /absolute/path/dsh-orchestrator-0.1.0-alpha.1.tgz
```

Use a new acceptance profile. Override its `cordis.patch.yml` with an existing dedicated project directory:

```yaml
- id: evidence-orchestrator
  config:
    workspace: /absolute/path/test-project
    questionTimeoutMs: 90000
```

Check that profile's surface, model, question service and port configuration before starting it. Follow the installed Harness version's profile instructions. The default workspace is blank; tools become usable after configuration. Preserve existing profiles.

## Use in Harness

Ask the agent to read `examples/pipeline.json`, adapt it to your goal, then call `orch_create`. The plugin displays the restatement, steps and acceptance criteria and asks the actual person through the host question service. Rejection, timeout or no answer never establishes an accepted run.

Typical flow: `orch_create` → `orch_next` → perform the work using authorized host tools → `orch_complete` → `orch_next`. Use `orch_gate` at human gates and `orch_status` to inspect progress.

`orch_pause` and `orch_resume` control scheduling. `orch_recover` reads existing state and action IDs without replay. Inspect the execution endpoint and artifacts before `orch_reconcile` asks the person to attest verification or actual stoppage. `orch_cancel` records a request when external work may still be active; it does not prove that work has stopped.

## Local dashboard (read-only + scheduling entry)

```sh
orch view /absolute/project/path            # loopback only; picks a port and prints a token URL
orch view /absolute/project/path --port 8899 --read-only   # disable scheduling actions
npm run view -- /absolute/project/path
```

The dashboard reads run snapshots from `<project>/.orchestrator/` and shows run status, node progress, event timeline, receipts and artifact hashes (current files are compared with the recorded hashes). It updates in real time (SSE plus file watching, with reconnect and polling fallback) and offers scheduling buttons: **start (issue the next work order) / resume / pause / cancel**. Buttons only persist core scheduling state and show the operation ID; they never execute a task, call a model or start external commands. Intent confirmation, human gates, reconciliation and delivery proof stay in the Harness session.

Security: loopback addresses only (default `127.0.0.1`; `--host` accepts only `127.0.0.1`/`::1`/`localhost` and rejects `0.0.0.0`, LAN and other host names); the access token is generated per process (or supplied via `--token`, at least 16 characters), stays valid for the process lifetime and appears in the startup URL, so do not share it or leak it in screenshots; POST requires the token header plus Origin/Host checks, no CORS, all dynamic text escaped; `--read-only` disables actions. The dashboard is a trusted local operator surface (same trust level as filesystem access), not a security boundary and not a replacement for Harness human confirmation; LAN access, multi-user accounts and permissions are out of scope. If a scheduling action reports a stale lock, confirm no writer remains and handle `<project>/.orchestrator/<runId>.json.lock` manually as described above; the dashboard never deletes locks automatically. Evidence: [docs/evidence/2026-10-30-viewer](docs/evidence/2026-10-30-viewer/README.md).

## Script-only execution

The core never evaluates instructions or executes arbitrary shell. Trusted applications supply explicit functions keyed by node ID and call `driveScripts` from `dsh-orchestrator/driver`. `examples/script-demo.js` is a zero-model demonstration using an explicitly synthetic confirmation fixture. The driver refuses to replay a previously issued action.

The CLI supports creation, observation, advancing, submission and pause/resume. Run `node src/cli.js` for usage. The CLI and core are trusted local programming interfaces, not a security boundary against same-privilege processes. Agents must not use CLI confirmation flags to replace actual human confirmation.

## Data, limits and recovery

Run state lives in `.orchestrator/` beneath the configured workspace, owned by the originating session. Do not publish that directory. Paths reject traversal and symlinks; artifact reads are capped at 4MB. Nodes are currently linear task/gate/check. Task output must differ from its pre-dispatch baseline; identical-byte rewrites are conservatively refused.

File checks establish only their declared file properties, not success in an external business system. DAGs, distributed concurrency/transactions, automatic compensation and exactly-once execution are not provided. Crash-left locks are not automatically deleted: confirm no writer remains, back up state, then have an operator remove the lock and inspect the run. Storage behavior under machine failure or power loss requires separate verification.

Remove the plugin from the acceptance profile with:

```sh
dsh plugin --profile orch-acceptance remove dsh-orchestrator
```

Unloading unregisters tools and aborts plugin-owned waits. It does not stop external tasks started through host tools. Inspect those tasks first; retain run state for recovery.

## Engineering records

[Intent](docs/sdlc/plan/intent.md) · [Intent-002 dashboard](docs/sdlc/plan/intent-002-viewer.md) · [Spec](docs/sdlc/design/spec.md) · [Plan](docs/sdlc/build/plan.md) · [Verification](docs/sdlc/test/verification.md) · [Delivery](docs/sdlc/deploy/delivery.md)

[MIT licensed](LICENSE). An independent community project, not an official DeepSeek plugin. Packaging follows the [official guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).
