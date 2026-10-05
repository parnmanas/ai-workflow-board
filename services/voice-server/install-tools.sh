#!/usr/bin/env bash
# Optional CPU speaker filter + Whisper comparison. Does not restart running services.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
TASK_VENV="$HOME/.venvs/voice-tools"
TASK_MODELS="$HOME/voice-server/models"
mkdir -p "$TASK_MODELS" "$HOME/.config/awb-voice" "$HOME/.config/systemd/user/awb-voice-gateway.service.d"
python3 -m venv "$TASK_VENV"
"$TASK_VENV/bin/pip" install -r "$SRC/requirements-tools.txt"
if [ ! -s "$TASK_MODELS/speaker.onnx" ]; then
  curl -fL https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx -o "$TASK_MODELS/speaker.onnx.tmp"
  mv "$TASK_MODELS/speaker.onnx.tmp" "$TASK_MODELS/speaker.onnx"
fi
"$TASK_VENV/bin/python" -c 'from faster_whisper import WhisperModel; WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=4)'
cat > "$HOME/.config/awb-voice/tools-env" <<ENV
SPEAKER_MODEL_PATH=$TASK_MODELS/speaker.onnx
WHISPER_MODEL=large-v3-turbo
ENV
cat > "$HOME/.config/systemd/user/awb-voice-gateway.service.d/tools.conf" <<UNIT
[Service]
EnvironmentFile=%h/.config/awb-voice/tools-env
ExecStart=
ExecStart=%h/.venvs/voice-tools/bin/uvicorn awb_voice_server:app --host \${VOICE_BIND} --port 8410 --workers 1
UNIT
echo 'CPU tools ready. Run install.sh to update and restart the gateway.'
