# vive-reading

外出中（ウォーキング、ジム）にClaude Code出力を「賢く読み上げ」するWebベースTTSシステム。

コードブロックをスキップし、長文を要約し、VibeVoice Realtime 0.5Bの自然な声で読み上げる。
iPhoneのSafariで開いてメッセージをタップするだけ。

## Quick Start

### 1. セットアップ（初回のみ）

```bash
# Python仮想環境 + 依存関係
python3 -m venv .venv
source .venv/bin/activate
pip install -r tts/requirements.txt

# VibeVoiceモデル（~2GB）
python3 -c "
from huggingface_hub import snapshot_download
snapshot_download('microsoft/VibeVoice-Realtime-0.5B', local_dir='models/vibevoice-realtime-0.5b')
"

# ボイスプリセット
mkdir -p voices/streaming_model
# VibeVoiceリポジトリからコピー or:
git clone --depth 1 https://github.com/microsoft/VibeVoice.git /tmp/vibevoice-src
cp /tmp/vibevoice-src/demo/voices/streaming_model/en-Emma_woman.pt voices/streaming_model/
rm -rf /tmp/vibevoice-src
```

### 2. サーバー起動

2つのターミナルが必要:

```bash
# Terminal 1: TTS server（初回起動は~6秒でモデルロード）
source .venv/bin/activate
cd tts && uvicorn server:app --host 0.0.0.0 --port 8000

# Terminal 2: Bun server
bun run server/src/index.ts
```

### 3. 使う

iPhone Safari で `http://[Mac-IP]:3456/` を開く。

- 「vive-reading を開始」をタップ（iOS音声コンテキスト初期化）
- メッセージをタップ → そこから最後まで連続読み上げ
- ■ ボタンで停止

## Architecture

```
Discord (claude-hub) ──webhook──→ Bun Server (port 3456)
                                       │
                                 Message Store (SQLite)
                                       │
                                 LLM Filter (code skip / summarize)
                                       │
                                 TTS Engine (VibeVoice / port 8000)
                                       │
                                 GET /api/audio/:id ──→ iPhone PWA
```

## Components

| Directory | Tech | Purpose |
|-----------|------|---------|
| `server/` | Bun + TypeScript | HTTP/WebSocket server + SQLite |
| `tts/` | Python + FastAPI | VibeVoice TTS wrapper |
| `client/` | HTML/JS | PWA (tap to play) |
| `filter/` | TypeScript | LLM filter (regex + Haiku API) |

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook` | POST | メッセージ受信（claude-hub等から） |
| `/api/messages` | GET | メッセージ一覧 |
| `/api/play` | POST | 読み上げ開始（`{from_id}`) |
| `/api/stop` | POST | 読み上げ停止 |
| `/api/audio/:id` | GET | メッセージの音声を生成・返却（WAV） |
| `/ws` | WS | 新着メッセージ通知 |
| `/health` (port 8000) | GET | TTS server health check |

## Performance (M1 Max, MPS)

| Input | Audio | Gen time | RTF |
|-------|-------|----------|-----|
| "Tests passed." | ~1.2s | 4.0s | 2.88x |
| 長文 + code block | ~12s | 14.3s | 1.19x |

RTF > 1.0 = リアルタイムより遅い。短文は実用範囲。

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_URL` | `http://localhost:8000/tts` | TTS server URL |
| `VIBEVOICE_MODEL_PATH` | `models/vibevoice-realtime-0.5b` | VibeVoice model path |
| `VIBEVOICE_VOICE_PATH` | `voices/streaming_model/en-Emma_woman.pt` | Voice preset |
| `ANTHROPIC_API_KEY` | (required for long text) | Claude Haiku API key for summarization |

## Related

- [claude-hub#30](https://github.com/miyashita337/claude-hub/pull/30) — Discord → vive-reading webhook連携
