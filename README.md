# SillyTavern Character Tools — Server Plugin

Companion server plugin for the [SillyTavern Character Tools](https://github.com/EnchantedRobot/SillyTavern-Character-Tools) extension. It performs on-disk "surgery" on a user's SillyTavern data — repairing character cards and compressing images — using [pngquant](https://pngquant.org/) and [sharp](https://sharp.pixelplumbing.com/). The extension drives it and decides *what* to do; this plugin does the file work.

> Consolidated from `SillyTavern-Image-Compressor-Server`. The plugin id (and therefore the API base path) is now `character-tools`: `/api/plugins/character-tools/…`.

## Installation

1. Set `enableServerPlugins` to `true` in SillyTavern's `config.yaml`.

2. From your SillyTavern directory:

```bash
cd plugins
git clone https://github.com/EnchantedRobot/SillyTavern-Character-Tools-Server
cd SillyTavern-Character-Tools-Server
npm install --omit=dev
```

3. Restart the SillyTavern server.

> [!NOTE]
> The pre-built `dist/plugin.js` is committed, so **no build step is required**. `npm install --omit=dev` only fetches the runtime deps (`sharp`, `pngquant-bin`), which ship their own platform binaries — no system packages needed.

## Usage

The extension talks to these endpoints for you; you don't normally call them by hand. All live under `/api/plugins/character-tools/`.

| Method & path | What it does |
|---|---|
| `POST /fix-characters` | Single pass over `characters/`: merge tags, repair/upgrade card JSON, compress the image. Skips unchanged cards. |
| `POST /compress` | Compress `user/images/` only (WEBP/PNG/JPG). Skips files processed in a previous run. |
| `POST /reprocess-characters` | Clear the character skip-state, then re-run `/fix-characters` from scratch. |
| `POST /reprocess-all` | Clear the image skip-state, then re-run `/compress` from scratch. |
| `POST /stats` | File counts and total bytes per directory, broken down by type. Plain JSON. |
| `GET /users` | List folder names under `data/` (populates the extension's user dropdown). Plain JSON. |

Each request takes a JSON body with a `user` field matching a folder name under `data/` (e.g. `"default-user"`). The `fix-characters`/`compress`/`reprocess-*` endpoints stream progress over [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events); `stats` and `users` return plain JSON.

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/stats \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

## Docs

- [API reference](docs/api.md) — every endpoint, request/response shapes, the SSE protocol, and a streaming client example.
- [Architecture](docs/architecture.md) — how compression and card repair work internally.
- [Development](docs/development.md) — building from source.

## License

MIT
