# CLI runtime profiles

Claude agents can start or reuse an external model runtime selected from the
workspace runtime-profile registry. Selection precedence is run override,
Agent, Board, Workspace default, then none. The model precedence remains run
override, effort preset, harness, Agent model, then profile model.

## vLLM in a virtual environment

```json
{
  {
    "id": "local-vllm",
    "provider": "vllm",
    "model": "Qwen/Qwen3-8B",
    "venv": "/models/vllm/.venv",
    "module": "vllm.entrypoints.openai.api_server",
    "cwd": "/models/vllm",
    "port": 8000,
    "base_url": "http://127.0.0.1:8000",
    "health_check": "/health",
    "startup_timeout_ms": 180000,
    "extra_args": ["--dtype", "auto"],
    "shutdown_policy": "on_release"
  }
}
```

The manager executes `.venv/bin/python -m ...` (or
`.venv/Scripts/python.exe` on Windows) directly. It never runs `source` or a
shell activation script. It waits for the health endpoint before starting
Claude and terminates the owned process group when Claude exits.

Use `"shutdown_policy": "reuse"` with `base_url` to require an already-running
endpoint. If an owned profile finds a healthy endpoint, it reuses it and does
not terminate that external process.

## Credentials

Store only the id of an existing workspace Credential:

```json
{
  "credential_required": true,
  "credential_ref": "00000000-0000-4000-8000-000000000000"
}
```

The server validates workspace ownership. Dispatch carries only the reference;
plaintext is never returned by the profile API or printed in runtime logs.

## Adding a provider

Providers implement `RuntimeProvider` and call `registerRuntimeProvider()`.
They supply validation, command construction, capabilities, and the
endpoint/model environment injected into Claude. The built-in `generic`
provider is also usable declaratively for a second server or model:

```json
{
  "id": "second-instance",
  "provider": "generic",
  "model": "my-model",
  "executable": "/opt/runtime/bin/server",
  "extra_args": ["--port", "8010"],
  "base_url": "http://127.0.0.1:8010"
}
```

Invalid providers, virtual environments, executables, ports, missing secrets,
early exits, unhealthy endpoints, and startup timeouts fail before Claude is
spawned with a field-specific error.
