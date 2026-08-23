# Claude backend profiles

Claude backend profiles keep the agent type, executable, stream-json session,
AWB MCP tools, heartbeat, and tool loop on Claude CLI. They change only the LLM
endpoint and model used by that CLI.

Profiles are stored in Workspace Settings. Selection inherits in this order:
one-run manager override (when supplied), Agent, Board, then Workspace default.
`none` explicitly keeps Claude's normal Anthropic configuration. A selected
profile is a public declarative snapshot on SSE; `credential_ref` is an id and
the referenced secret is resolved only on the manager host.

## Anthropic-compatible endpoint

No backend process is started by AWB. Claude receives `ANTHROPIC_BASE_URL`, a
CLI-recognized model alias (see [Model alias](#model-alias) below) through its
existing `--model` argument, optional public env/args, and the referenced
credential:

```json
[
  {
    "id": "local-anthropic-model-a",
    "kind": "claude-backend",
    "protocol": "anthropic-compatible",
    "base_url": "http://127.0.0.1:8080",
    "model": "model-a",
    "credential_ref": "00000000-0000-4000-8000-000000000001",
    "credential_required": true,
    "auth_env": "ANTHROPIC_AUTH_TOKEN"
  },
  {
    "id": "remote-anthropic-model-b",
    "kind": "claude-backend",
    "protocol": "anthropic-compatible",
    "base_url": "https://models.example.test/anthropic",
    "model": "model-b"
  }
]
```

The second backend/model is configuration only; no core provider registration
or agent-type change is required.

## OpenAI-compatible endpoint through an adapter

Claude CLI does not speak the OpenAI API directly. Declare a small
OpenAI-to-Anthropic adapter and its Anthropic-facing local URL. AWB supervises
only this adapter process when needed; it does not start or own the vLLM
backend:

```json
[
  {
    "id": "existing-vllm-via-adapter",
    "kind": "claude-backend",
    "protocol": "openai-compatible",
    "base_url": "http://gpu-host:8000/v1",
    "model": "Qwen/Qwen3-Coder",
    "credential_ref": "00000000-0000-4000-8000-000000000001",
    "auth_env": "OPENAI_API_KEY",
    "adapter": {
      "venv": "/opt/claude-openai-adapter/.venv",
      "module": "claude_openai_adapter",
      "args": [
        "--upstream",
        "{backend_base_url}",
        "--model",
        "{model}",
        "--listen",
        "127.0.0.1:18080"
      ],
      "base_url": "http://127.0.0.1:18080",
      "health_check": "/health",
      "startup_timeout_ms": 30000,
      "lifecycle": "on_release"
    }
  }
]
```

Adapters also receive non-secret `AWB_BACKEND_BASE_URL` and
`AWB_BACKEND_MODEL`. The placeholders `{backend_base_url}`, `{model}`, and
`{adapter_base_url}` can be used in adapter args and public env values.
`lifecycle: reuse` connects to an already-running adapter after a health check;
`on_release` and `manager_exit` reuse the existing shared process supervisor
and process-tree cleanup.

## Model alias

`model` is the raw provider model id the *backend* serves (a vLLM
`--served-model-name`, an OpenAI-compatible model string, ...). Claude Code CLI
itself only recognizes a fixed alias family for `--model`: `opus`, `sonnet`,
`haiku`, `fable`. Passing `model` straight through to `--model` makes the CLI
reject its own internal helper calls (session-title generation and similar)
with `unrecognized_model`, failing the very first turn.

To avoid this, a profile's `--model` argument is always one of the four
aliases — `model_alias` if set, otherwise `sonnet`:

```json
{
  "id": "vllm-qwen3-coder",
  "kind": "claude-backend",
  "protocol": "anthropic-compatible",
  "base_url": "http://gpu-host:8000",
  "model": "qwen3-coder-next",
  "model_alias": "sonnet"
}
```

The alias only has to be something the CLI accepts — it does not change which
backend model actually serves the request, but the environment variables that
carry it split into two roles:

- **Selection** (`ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`) — Claude
  Code's internal helper calls (session-title generation and similar) read
  these directly, bypassing `--model` argv entirely. They default to the same
  alias as `--model`, never to `model`. A raw provider id here reproduces the
  exact `unrecognized_model` failure this section exists to prevent, even
  when `--model` itself is already alias-safe — only fixing `--model` and
  leaving these two on the raw id is the round-1 regression that reopened
  this ticket.
- **Override** (`ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_FABLE_MODEL`) — the
  CLI's official mechanism (see [Claude Code docs, Model configuration →
  Restrict model selection](https://code.claude.com/docs/en/model-config#restrict-model-selection))
  for mapping a resolved tier alias to the model actually requested. These
  default to `model`, so regardless of which alias tier gets selected (via
  `--model`, `ANTHROPIC_MODEL`, or `ANTHROPIC_SMALL_FAST_MODEL`), every
  request — main turn or internal aux call — still routes to the one
  configured backend model, `fable` included.

Set `env` to override any of those variables individually (e.g. a genuinely
multi-model backend).

A board's harness `fallback_models` (a model-retry chain for transient
usage-limit / model-unavailable deaths) is ignored while a profile is bound:
the profile serves exactly one model behind one endpoint, so there is nothing
else on that backend to fall back to, and those entries were never validated
as CLI-recognized aliases. A fallback-eligible death on a profile-bound
session is treated as an ordinary single failure instead of retrying with a
different `--model`.

## Claude wrapper and public configuration

`claude_executable` optionally selects Claude CLI or a Claude-compatible
wrapper. Top-level `cwd`, `env`, and `args` apply to that Claude process.
Adapter process settings live only under `adapter`, so a vLLM server command is
never confused with the Claude executable.

Environment keys containing token/secret/password/key/credential terms are
rejected. Put the value in a Credential, reference its id with
`credential_ref`, and name only the destination variable with `auth_env`.
Reserved AWB and CLI-home variables cannot be overridden. Secrets are not
returned in profile REST/SSE payloads or logs.

Changing a Workspace, Board, or Agent selection affects newly spawned
sessions. Restart an already-running managed agent/session to apply it.
