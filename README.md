# SillyTavern Character Tools

Companion server plugin for the [SillyTavern Character Tools](https://github.com/EnchantedRobot/SillyTavern-Character-Tools) extension. It performs on-disk "surgery" on a user's SillyTavern data — repairing character cards and compressing images — using [pngquant](https://pngquant.org/) and [sharp](https://sharp.pixelplumbing.com/). The extension drives it and tells it *what* to do; this plugin does the file work.

> **Note:** This plugin was consolidated from `SillyTavern-Image-Compressor-Server`. The plugin id (and therefore the API base path) is now `character-tools`: `/api/plugins/character-tools/…`. Tag merging is being folded into the character pass — see the extension repo for the current roadmap.

The two directories are handled by **separate endpoints** with different goals:

| Directory | Endpoint | PNG metadata | Max dimension | WEBP conversion | Card repair |
|---|---|---|---|---|---|
| `data/{user}/user/images/` | `/compress` | Not preserved | 2048px | Yes | No |
| `data/{user}/characters/` | `/upgrade-characters` | Preserved (`chara`/`ccv3` chunk) | 2048px | Never | Yes |

`/compress` only touches `user/images/`. Character cards are handled by `/upgrade-characters`, which compresses the image **and** upgrades/repairs the embedded card JSON in the same pass (see [Upgrade and repair characters](#upgrade-and-repair-characters)).

JPEG files are re-encoded at quality 75 with mozjpeg (progressive). `characters/` is never converted to WEBP: character cards store their JSON in a PNG `chara`/`ccv3` text chunk, which WEBP can't carry, so converting them would corrupt the card.

For every PNG/JPG in `user/images/`, a WEBP (quality 90) encode is tried first. If it comes out smaller than the original — true for almost all photographic/AI-generated images — the file is replaced with a same-basename `.webp` and the original is deleted. If WEBP doesn't help (e.g. small flat-color icons), the file falls back to the normal PNG/JPG compression above.

Converted files don't need separate tracking: once a file becomes `.webp` it's no longer picked up by the PNG/JPG scan, so it's automatically skipped on future runs. If a file is later redownloaded as PNG/JPG (e.g. after a manual re-fetch), it's treated as a fresh file — any stale `.webp` from a prior conversion at the same path is overwritten.

## How to use

The compression endpoints accept a JSON body with a `user` field matching the folder name under `data/` (e.g. `"default-user"`), and respond with a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream.

The stream emits a progress event after every file, followed by a single completion event:

```ts
// Sent every 50 files
{ type: 'progress', current: number, total: number, percent: number }

// Sent once at the end
{ type: 'complete', result: CompressionResult }

interface CompressionResult {
    filesScanned: number;
    filesSkipped: number;
    filesCompressed: number;
    cardsRepaired: number; // character cards whose JSON was upgraded/repaired (0 for /compress)
    bytesSaved: number;
    errors: string[];
}
```

Because the endpoints use `POST` with a request body, use `fetch` with a `ReadableStream` reader rather than `EventSource` (which only supports `GET`):

```js
const response = await fetch('/api/plugins/character-tools/compress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'default-user' }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ')) {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'progress') {
                console.log(`${event.percent}% (${event.current}/${event.total})`);
            } else if (event.type === 'complete') {
                console.log('Done:', event.result);
            }
        }
    }
    buffer = buffer.includes('\n') ? buffer.slice(buffer.lastIndexOf('\n') + 1) : buffer;
}
```

### Stats

`POST /api/plugins/character-tools/stats`

Returns file counts and total bytes per directory (`images` = `user/images/`, `characters` = `characters/`), broken down by type (`png`, `jpg`, `gif`, `webp`, `other`). Plain JSON response, no SSE.

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/stats \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

```ts
interface StatsResponse {
    images: DirStats;
    characters: DirStats;
}

interface DirStats {
    totalFiles: number;
    totalBytes: number;
    byType: Record<'png' | 'jpg' | 'gif' | 'webp' | 'other', { count: number; bytes: number }>;
}
```

### Compress

`POST /api/plugins/character-tools/compress`

Compresses `user/images/` only, skipping any file that was already processed in a previous run. Progress is stored in `data/{user}/.compress_state.json` and saved incrementally every 500 files, so a crash mid-run won't lose all progress. (Character cards are handled separately by `/upgrade-characters`.)

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/compress \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

### Reprocess all

`POST /api/plugins/character-tools/reprocess-all`

Deletes the `.compress_state.json` state file for the given user, then re-runs `/compress` on every image from scratch. Use this after updating compression settings or if you want to recheck previously skipped files. (Does not touch `characters/`; use `/reprocess-characters` for that.)

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/reprocess-all \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

### Upgrade and repair characters

`POST /api/plugins/character-tools/upgrade-characters`

Iterates over `characters/`, and for each card PNG **compresses the image and repairs/upgrades the embedded card JSON in a single pass**. This is a *lightweight* upgrade that only fixes things that are actually broken — it never rewrites prose, clears prompts, filters tags, or substitutes `{{char}}` for a name. Specifically it:

- **Upgrades V2 → V3**: `chara_card_v2` → `chara_card_v3` (spec_version `3.0`).
- **Backfills required V3 fields**: adds `data.group_only_greetings` (`[]`), `character_book.extensions` (`{}`), and `use_regex: false` on any `character_book` entry missing it.
- **Normalises malformed template tokens** in all content fields except `mes_example`:
  - `{char}` / `{user}` (single bracket) → `{{char}}` / `{{user}}`
  - `{{Char}}` / `{{USER}}` (any case) → lowercase canonical form
  - broken pronoun aliases `{{sub}}` `{{pos}}` `{{obj}}` `{{poss}}` `{{poss_p}}` `{{ref}}` (and single-bracket variants) → `{{user}}`
- **Preserves everything else**, including unknown extension metadata such as `extensions.gallery_id` / `fav` and `_meta`, by mutating the decoded card in place rather than rebuilding it. Both the `chara` and `ccv3` chunks are rewritten with the repaired JSON.

A card is written back whenever it changed **or** the image shrank — so a repair is never lost even when the image can't be compressed further. `cardsRepaired` in the result counts how many cards were changed. Progress uses its own `data/{user}/.repair_state.json` (independent of image compression), so a card already compressed by `/compress` in an older combined run isn't skipped before it can be repaired.

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/upgrade-characters \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

### Reprocess characters

`POST /api/plugins/character-tools/reprocess-characters`

Deletes the `.repair_state.json` state file, then re-runs `/upgrade-characters` on every card from scratch. Use this after a repair-logic update or to re-check previously processed cards.

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/reprocess-characters \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

## How to install

1. Before you begin, make sure you set `enableServerPlugins` to `true` in the `config.yaml` file of SillyTavern.

2. Open a terminal in your SillyTavern directory, then run the following:

```bash
cd plugins
git clone https://github.com/EnchantedRobot/SillyTavern-Character-Tools-Server
cd SillyTavern-Character-Tools-Server
npm install --omit=dev
```

3. Restart the SillyTavern server.

> [!NOTE]
> The pre-built `dist/plugin.js` is included in the repository — **no build step is required after cloning**. `npm install --omit=dev` only installs the runtime dependencies (`sharp` and `pngquant-bin`), which ship their own platform binaries and are downloaded automatically. No system packages are required.

## How to build

Clone the repository, then run `npm install`.

```bash
# Debug build
npm run build:dev
# Prod build
npm run build
```

## License

MIT
