# vive-reading

外出中（ウォーキング、ジム）にClaude Code出力を「賢く読み上げ」するWebベースTTSシステム。

## Architecture

```
Discord (claude-hub) → webhook → Bun Server → LLM Filter → TTS Engine → WebSocket → iPhone PWA
```

- **server/**: Bun HTTP + WebSocket + SQLite Message Store
- **tts/**: Python FastAPI (VibeVoice / Piper TTS)
- **client/**: PWA (HTML/CSS/JS)
- **filter/**: LLM Filter (Claude Haiku)

## Tech Stack

- Server: Bun + TypeScript
- TTS: Python + VibeVoice Realtime 0.5B (MPS) / Piper TTS (CPU fallback)
- Client: Vanilla HTML/JS PWA
- DB: SQLite (via bun:sqlite)
- Network: Tailscale

## Design Documents

- Design doc: `~/.gstack/projects/miyashita337-vive-reading/harieshokunin-worktree-init-design-20260411-030236.md`
- CEO plan: `~/.gstack/projects/miyashita337-vive-reading/ceo-plans/2026-04-11-intelligent-tts.md`

## Known Issues

- VibeVoice on MPS: RTF ~2.88x (not realtime). Short texts OK, long texts need Piper fallback.
