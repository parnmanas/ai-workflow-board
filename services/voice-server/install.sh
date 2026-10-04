#!/usr/bin/env bash
# Install / update the AWB voice server on a GPU host (ragnar). Idempotent.
#   ./install.sh            copy files, (re)write units, restart services
# Expects: ~/.venvs/voice-asr (vLLM + librosa/soundfile/av), docker with --gpus,
#          ~/.config/awb-voice/env (AWB_VOICE_KEY, VOICE_BIND, ASR_URL, TTS_URL, TTS_MODEL).
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/voice-server"
UNITS="$HOME/.config/systemd/user"
mkdir -p "$DEST/logs" "$UNITS" "$HOME/.config/awb-voice"
install -m 644 "$SRC/awb_voice_server.py" "$SRC/voices.json" "$DEST/"
install -m 755 "$SRC/tts-container.sh" "$DEST/"
install -m 644 "$SRC/systemd/awb-voice-asr.service" "$SRC/systemd/awb-voice-gateway.service" "$UNITS/"
if [ ! -f "$HOME/.config/awb-voice/env" ]; then
  umask 077
  cat > "$HOME/.config/awb-voice/env" <<ENV
AWB_VOICE_KEY=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)
VOICE_BIND=0.0.0.0
ASR_URL=http://127.0.0.1:8411/v1
ASR_MODEL=qwen3-asr
TTS_URL=http://127.0.0.1:8421
TTS_MODEL=qwen3-tts
ENV
  echo "wrote $HOME/.config/awb-voice/env (new AWB_VOICE_KEY)"
fi
systemctl --user daemon-reload
systemctl --user enable --now awb-voice-asr.service
docker inspect awb-voice-tts >/dev/null 2>&1 || "$DEST/tts-container.sh"
systemctl --user enable awb-voice-gateway.service
systemctl --user restart awb-voice-gateway.service
systemctl --user --no-pager status awb-voice-asr.service awb-voice-gateway.service | grep -E "●|Active:" || true
