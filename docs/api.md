# API reference

All endpoints live under `/api/plugins/character-tools/`. Every request takes a JSON body with a `user` field matching a folder name under `data/` (e.g. `"default-user"`).

The `fix-characters`, `compress`, and `reprocess-*` endpoints respond with a [Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) stream. `stats`, `character-tags`, `users`, and `probe` return plain responses.

## The SSE stream

The stream emits a progress event periodically, followed by a single completion event:

```ts
// Sent every 50 files
{ type: 'progress', current: number, total: number, percent: number }

// Sent once at the end
{ type: 'complete', result: CompressionResult }

interface CompressionResult {
    filesScanned: number;
    filesSkipped: number;
    filesCompressed: number;
    cardsRepaired: number; // cards whose JSON was upgraded/repaired (0 for /compress)
    tagsChanged: number;   // cards whose tags were rewritten by the dictionary (0 for /compress)
    bytesSaved: number;
    errors: string[];
}
```

Because these endpoints use `POST` with a request body, consume them with `fetch` + a `ReadableStream` reader rather than `EventSource` (which only supports `GET`):

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

## Endpoints

### `POST /fix-characters`

Iterates over `characters/`, and for each card PNG runs the full character pass **in a single decode/write per card**: apply the tag dictionary, repair/upgrade the embedded card JSON, and compress the image. See [Architecture → Character pass](architecture.md#character-pass-fix-characters) for what "repair" covers.

A card is written back whenever its tags changed, it was repaired, **or** the image shrank — so no change is ever lost even when the image can't be compressed further. `cardsRepaired` counts cards whose JSON was repaired; `tagsChanged` counts cards whose tags were rewritten.

**Request body:**

```ts
{
    user: string;            // folder name under data/
    dictionary?: {           // omit for repair-only (no tag merge)
        mapping: Record<string, string[]>;  // canonical -> variants
        removedTags: string[];              // tags to delete from every card
    };
}
```

Progress uses its own `data/{user}/.repair_state.json` (independent of image compression), which also records a hash of the dictionary it was built under. **If the dictionary changes between runs, the size-based skips are dropped** so the new dictionary is re-applied to every card — no manual reprocess needed after editing the dictionary.

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/fix-characters \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user", "dictionary": {"mapping": {"Female": ["girl", "woman"]}, "removedTags": ["anypov"]}}'
```

### `POST /compress`

Compresses `user/images/` only, skipping any file processed in a previous run. Progress is stored in `data/{user}/.compress_state.json` and saved incrementally every 500 files, so a crash mid-run won't lose all progress. (Character cards are handled separately by `/fix-characters`.)

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/compress \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

### `POST /reprocess-characters`

Deletes `.repair_state.json`, then re-runs the character pass on every card from scratch. Accepts the same optional `dictionary` body as `/fix-characters`. Use after a repair-logic update or to force a re-check of previously processed cards.

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/reprocess-characters \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

### `POST /reprocess-all`

Deletes `.compress_state.json`, then re-runs `/compress` on every image from scratch. Use after changing compression settings, or to recheck previously skipped files. (Does not touch `characters/`.)

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/reprocess-all \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

### `POST /stats`

Returns file counts and total bytes per directory (`images` = `user/images/`, `characters` = `characters/`), broken down by type. Plain JSON, no SSE.

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

### `POST /character-tags`

Read-only survey of a user's character tags, used by the extension's Tag Dictionary editor so its counts and "unassigned" discovery reflect the **selected** user (SillyTavern's in-browser character list only ever holds the logged-in user). Scans `characters/` with the same scope as the character pass — **root-level PNGs only** — decodes each card, and returns its tags. Cards with no tags are omitted. Plain JSON, no SSE.

```bash
curl -X POST http://localhost:8000/api/plugins/character-tools/character-tags \
  -H "Content-Type: application/json" \
  -d '{"user": "default-user"}'
```

```ts
interface CharacterTagsResponse {
    characters: {
        avatar: string;   // card filename, e.g. "Seraphina.png"
        tags: string[];   // the card's data.tags (blank/non-string entries dropped)
    }[];
}
```

### `GET /users`

Lists folder names under `data/`, used to populate the extension's user dropdown. Plain JSON.

### `POST /probe`

Health check. Returns `204 No Content` when the plugin is loaded; the extension uses it to warn if the server isn't running.
