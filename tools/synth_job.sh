#!/usr/bin/env bash
# Run the line synthesis on a machine that has a GPU, and get the clips back.
#
# The models are a few GB of weights and no serverless provider hosts either
# one, so this is a one-off batch on a rented GPU rather than anything the app
# talks to. 56 lines takes minutes; the expensive part is downloading weights.
#
# Hugging Face Jobs — bills your HF credits, and the container is destroyed the
# moment the command exits, so UPLOAD_REPO is not optional there: it is the only
# way the clips get out. `--timeout` is, because Jobs defaults to 30 minutes and
# weight downloads alone can outlast that. The pytorch images have no git, hence
# the apt line.
#
#   hf jobs run --flavor a10g-small --timeout 2h --secrets HF_TOKEN \
#     pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime bash -c '
#       apt-get update -qq && apt-get install -y -qq git &&
#       git clone --depth 1 -b claude/tts-model-integration-8vzkfe \
#         https://github.com/alex-o-748/levantine.git /src &&
#       UPLOAD_REPO=<your-hf-username>/yalla-synth /src/tools/synth_job.sh'
#
#   hf jobs logs <job-id>     # follow it; Ctrl-C stops watching, not the job
#
# Colab / vast.ai / any box with a GPU and the repo already checked out:
#
#   ./tools/synth_job.sh
#   BACKENDS=omnivoice ./tools/synth_job.sh     # one backend only
#
# Then bring build/synth/ back to a checkout, listen to
# `python3 tools/synth_lines.py --compare`, and ship the winner with
# `python3 tools/synth_lines.py --promote <backend>`. Nothing here writes to
# audio/ — promotion is a decision made after listening, not a build step.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKENDS="${BACKENDS:-omnivoice leva}"
UPLOAD_REPO="${UPLOAD_REPO:-}"

echo "== environment =="
python3 -c 'import sys; print("python", sys.version.split()[0])'
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
else
  # CPU works and is how you'd rehearse the pipeline, but OmniVoice at 32
  # diffusion steps is minutes per line rather than seconds.
  echo "no GPU detected — this will be slow"
fi

# ffmpeg does the trim/level/transcode that makes a synthetic line sit at the
# same loudness as the Lingua Libre word clips. imageio-ffmpeg ships a static
# binary, which is the one dependency that reliably is not in a CUDA image.
# Not `pip install -U pip` first: on a Debian-packaged pip that fails outright
# ("RECORD file not found"), and under `set -e` it takes the whole run with it.
pip install --quiet imageio-ffmpeg soundfile

for backend in $BACKENDS; do
  echo
  echo "== install $backend =="
  case "$backend" in
    omnivoice) pip install --quiet lahgtna-omnivoice ;;
    # coqui-tts is the maintained fork of the (archived) coqui-ai/TTS package
    # that still installs against current torch.
    leva)      pip install --quiet coqui-tts huggingface_hub ;;
    *) echo "unknown backend: $backend" >&2; exit 2 ;;
  esac

  echo "== synthesise with $backend =="
  python3 tools/synth_lines.py --backend "$backend"
done

python3 tools/synth_lines.py --compare

echo
echo "== package =="
tar -czf build/synth.tar.gz -C build synth synth-compare.html
ls -lh build/synth.tar.gz

if [ -n "$UPLOAD_REPO" ]; then
  # A Jobs container is thrown away the moment the command exits, so the clips
  # have to leave before it does. A private dataset repo is the cheapest place
  # to put them; download it, unpack into build/, then --compare locally.
  echo "== upload to $UPLOAD_REPO =="
  pip install --quiet huggingface_hub          # ships the `hf` command itself
  hf upload "$UPLOAD_REPO" build/synth.tar.gz synth.tar.gz --repo-type dataset --private
  echo
  echo "Fetch it back into a checkout with:"
  echo "  hf download $UPLOAD_REPO synth.tar.gz --repo-type dataset --local-dir ."
  echo "  mkdir -p build && tar -xzf synth.tar.gz -C build"
  echo "  python3 tools/synth_lines.py --compare"
fi
