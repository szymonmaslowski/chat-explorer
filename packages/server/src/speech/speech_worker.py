"""Chat Explorer speech worker.

Keeps the Chatterbox Multilingual model loaded and turns text into MP3 files. The daemon sends
one JSON request per line on stdin, {"id", "text", "language", "output"}, and waits for the
answer line on stdout, {"id"} or {"id", "error"}, before it sends the next one.

On Apple Silicon it runs the MLX build (chatterbox-mlx), elsewhere the PyTorch one
(chatterbox-tts). `--warm-up` loads the model, downloading it on first use, and speaks one
sentence.
"""

import json
import platform
import sys
import tempfile

import soundfile

# Libraries print progress on stdout, which carries the answers, so they get stderr instead.
answers = sys.stdout
sys.stdout = sys.stderr

uses_mlx = platform.system() == "Darwin" and platform.machine() == "arm64"


def load_model():
    if uses_mlx:
        from chatterbox.models.t3_mlx.inference import alignment_stream_analyzer_mlx
        from chatterbox.mtl_tts_mlx import ChatterboxMultilingualTTSMLX

        # chatterbox-mlx 1.0.1 passes max_new_tokens, which this class does not take.
        analyzer = alignment_stream_analyzer_mlx.AlignmentStreamAnalyzerMLX
        original_init = analyzer.__init__

        def init_without_max_new_tokens(self, *args, max_new_tokens=None, **kwargs):
            original_init(self, *args, **kwargs)

        analyzer.__init__ = init_without_max_new_tokens
        return ChatterboxMultilingualTTSMLX.from_pretrained(device="mps")

    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    return ChatterboxMultilingualTTS.from_pretrained(
        device="cuda" if torch.cuda.is_available() else "cpu"
    )


def speak(model, text, language, output):
    options = {"show_progress": False} if uses_mlx else {}
    samples = model.generate(text, language_id=language, **options).squeeze().cpu().numpy()
    soundfile.write(output, samples, model.sr, format="MP3", bitrate_mode="VARIABLE")


def answer(message):
    answers.write(json.dumps(message) + "\n")
    answers.flush()


def main():
    model = load_model()
    if "--warm-up" in sys.argv:
        with tempfile.NamedTemporaryFile(suffix=".mp3") as output:
            speak(model, "Chat Explorer can read aloud.", "en", output.name)
        return
    answer({"ready": True})
    for line in sys.stdin:
        request = json.loads(line)
        try:
            speak(model, request["text"], request["language"], request["output"])
            answer({"id": request["id"]})
        except Exception as error:
            answer({"id": request["id"], "error": str(error)})


if __name__ == "__main__":
    main()
