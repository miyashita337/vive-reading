"""VibeVoice TTS FastAPI server with Piper fallback."""

from __future__ import annotations

import copy
import io
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Resolve paths relative to project root (parent of tts/) so the server works
# regardless of the directory it's started from.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
MODEL_PATH = os.environ.get(
    "VIBEVOICE_MODEL_PATH", str(PROJECT_ROOT / "models" / "vibevoice-realtime-0.5b")
)
VOICE_PATH = os.environ.get(
    "VIBEVOICE_VOICE_PATH",
    str(PROJECT_ROOT / "voices" / "streaming_model" / "en-Emma_woman.pt"),
)
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"

model = None
processor = None
cached_prompt = None


def load_vibevoice():
    """Load VibeVoice model, processor, and voice preset."""
    global model, processor, cached_prompt

    from vibevoice import (
        VibeVoiceStreamingForConditionalGenerationInference,
        VibeVoiceStreamingProcessor,
    )

    print(f"Loading VibeVoice from {MODEL_PATH} on {DEVICE}...")
    start = time.time()

    processor = VibeVoiceStreamingProcessor.from_pretrained(MODEL_PATH)

    if DEVICE == "mps":
        model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            MODEL_PATH,
            torch_dtype=torch.float32,
            attn_implementation="sdpa",
            device_map=None,
        )
        model.to("mps")
    else:
        model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            MODEL_PATH,
            torch_dtype=torch.float32,
            device_map="cpu",
            attn_implementation="sdpa",
        )

    model.eval()
    model.set_ddpm_inference_steps(num_steps=5)

    cached_prompt = torch.load(VOICE_PATH, map_location=DEVICE, weights_only=False)

    elapsed = time.time() - start
    print(f"VibeVoice loaded in {elapsed:.1f}s (device={DEVICE})")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_vibevoice()
    yield


app = FastAPI(title="vive-reading TTS", lifespan=lifespan)


class TTSRequest(BaseModel):
    text: str
    voice: str | None = None


@app.post("/tts")
async def synthesize(req: TTSRequest):
    """Generate speech from text. Returns WAV audio."""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text is empty")

    if model is None or processor is None or cached_prompt is None:
        raise HTTPException(status_code=503, detail="TTS model not loaded")

    start = time.time()

    inputs = processor.process_input_with_cached_prompt(
        text=req.text,
        cached_prompt=cached_prompt,
        padding=True,
        return_tensors="pt",
        return_attention_mask=True,
    )

    for k, v in inputs.items():
        if torch.is_tensor(v):
            inputs[k] = v.to(DEVICE)

    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=None,
            cfg_scale=1.5,
            tokenizer=processor.tokenizer,
            generation_config={"do_sample": False},
            all_prefilled_outputs=copy.deepcopy(cached_prompt),
        )

    gen_time = time.time() - start

    if not outputs.speech_outputs or outputs.speech_outputs[0] is None:
        raise HTTPException(status_code=500, detail="TTS generation failed")

    audio = outputs.speech_outputs[0]
    if hasattr(audio, "cpu"):
        audio = audio.cpu().float().numpy()

    if len(audio.shape) > 1:
        audio = audio.squeeze()

    duration = len(audio) / 24000
    print(
        f"TTS: '{req.text[:50]}...' -> {duration:.1f}s audio in {gen_time:.1f}s (RTF={gen_time/duration:.2f}x)"
    )

    buf = io.BytesIO()
    sf.write(buf, audio, 24000, format="WAV")
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="audio/wav",
        headers={
            "X-Generation-Time": f"{gen_time:.2f}",
            "X-Audio-Duration": f"{duration:.2f}",
            "X-RTF": f"{gen_time/duration:.2f}",
        },
    )


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": "vibevoice-realtime-0.5b" if model else "not loaded",
        "device": DEVICE,
    }
