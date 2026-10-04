#!/usr/bin/env bash
# (Re)create the Qwen3-TTS container — vLLM-Omni serving Qwen3-TTS-12Hz-1.7B-CustomVoice
# on 127.0.0.1:8421 (localhost only; the gateway is the LAN-facing surface).
#
# vLLM-Omni is pinned to its matching vLLM (0.30.0) and lives in its own image so it
# never touches the host's vLLM venvs. Docker restarts it on boot (--restart).
#
# Memory: the bundled stage config asks for 0.3 of *total* unified memory per stage
# (~72 GiB for two stages) — the overrides below are mandatory on a shared GB10.
set -euo pipefail
IMAGE="${IMAGE:-vllm/vllm-omni:v0.30.0}"
MODEL="${MODEL:-Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice}"
DEFAULT_STAGES='{"0":{"gpu_memory_utilization":0.06,"max_num_seqs":4},"1":{"gpu_memory_utilization":0.04,"max_num_seqs":1}}'
STAGES="${STAGES:-$DEFAULT_STAGES}"

docker rm -f awb-voice-tts >/dev/null 2>&1 || true
docker run -d --name awb-voice-tts --restart unless-stopped --gpus all --ipc=host \
  -p 127.0.0.1:8421:8091 \
  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
  -e VLLM_USE_FLASHINFER_SAMPLER=0 \
  "$IMAGE" \
  vllm serve "$MODEL" --omni --trust-remote-code --port 8091 --served-model-name qwen3-tts \
  --stage-overrides "$STAGES"
echo "started awb-voice-tts ($IMAGE, $MODEL) — logs: docker logs -f awb-voice-tts"
