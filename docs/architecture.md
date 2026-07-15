# Architecture

Work is split across **separate endpoints** with different goals:

| Directory | Endpoint | PNG metadata | Max dimension | WEBP conversion | Tag merge | Card repair | Compression |
|---|---|---|---|---|---|---|---|
| `data/{user}/user/images/` | `/compress` | Not preserved | 2048px | Yes | No | No | Yes |
| `data/{user}/characters/` | `/fix-characters` | Preserved (`chara`/`ccv3` chunk) | 2048px | Never | No | Yes | Yes |
| `data/{user}/characters/` | `/apply-tags` | Preserved (untouched) | — | Never | Yes | No | No |

`/compress` only touches `user/images/`. Character cards are handled by two **deliberately independent** passes:

- **`/fix-characters`** repairs the embedded card JSON and compresses the image. It never touches tags — it doesn't even accept a dictionary.
- **`/apply-tags`** rewrites the card's tags and nothing else, carrying the image across byte-for-byte.

Keeping them apart is a load-bearing design decision, not an accident of layout. Tag edits are frequent and cheap; repair/compression is expensive and needs skip-state to stay tolerable. When both ran in one pass they had to share a single skip-state, which then had to be invalidated whenever the dictionary changed — so every tag edit re-compressed the entire library, and alternating the two buttons thrashed the state file endlessly. Splitting the passes lets each own the right skip rule, and deletes the dictionary-hash machinery entirely. **Don't merge them back together.**

The tag dictionary is owned by the extension and passed in the `/apply-tags` request body — this plugin holds no dictionary of its own.

## Image compression (`/compress`)

For every PNG/JPG in `user/images/`, a WEBP (quality 90) encode is tried first. If it comes out smaller than the original — true for almost all photographic/AI-generated images — the file is replaced with a same-basename `.webp` and the original is deleted. If WEBP doesn't help (e.g. small flat-color icons), the file falls back to normal PNG/JPG compression: JPEGs are re-encoded at quality 75 with mozjpeg (progressive); PNGs are quantized with pngquant.

Converted files don't need separate tracking: once a file becomes `.webp` it's no longer picked up by the PNG/JPG scan, so it's automatically skipped on future runs. If a file is later redownloaded as PNG/JPG (e.g. after a manual re-fetch), it's treated as a fresh file — any stale `.webp` from a prior conversion at the same path is overwritten.

## Character repair pass (`/fix-characters`)

Each card is repaired and compressed in a **single decode/write**. Tags are not part of this pass.

The character pass is **PNG-only**: a card embeds its JSON in a PNG text chunk, so only a PNG can be a card. Any jpg/webp sitting in `characters/` can't be a card — there's nothing to repair and nothing to convert — so it's left untouched. (`/compress`, by contrast, handles PNG/JPG/WEBP.)

Only files at the **root** of `characters/` are treated as cards. SillyTavern keeps a character's expression sprites in a subfolder named after it (`characters/<Name>/happy.png`, …); those aren't cards, so the character pass doesn't recurse into subfolders and never touches them. (`/compress` still walks `user/images/` recursively — both rules are specific to the character pass.)

`characters/` is **never** converted to WEBP: character cards store their JSON in a PNG `chara`/`ccv3` text chunk, which WEBP can't carry, so converting them would corrupt the card. Otherwise the image is quantized and oversized cards are downscaled, exactly as in `/compress`.

### Card repair

A *lightweight* upgrade that only fixes things that are actually broken — it never rewrites prose, clears prompts, or substitutes `{{char}}` for a name. Specifically it:

- **Upgrades V2 → V3**: `chara_card_v2` → `chara_card_v3` (spec_version `3.0`).
- **Backfills required V3 fields**: adds `data.group_only_greetings` (`[]`), `character_book.extensions` (`{}`), and `use_regex: false` on any `character_book` entry missing it.
- **Normalises malformed template tokens** in all content fields except `mes_example`:
  - `{char}` / `{user}` (single bracket) → `{{char}}` / `{{user}}`
  - `{{Char}}` / `{{USER}}` (any case) → lowercase canonical form
  - broken pronoun aliases `{{sub}}` `{{pos}}` `{{obj}}` `{{poss}}` `{{poss_p}}` `{{ref}}` (and single-bracket variants) → `{{user}}`
- **Preserves everything else**, including unknown extension metadata such as `extensions.gallery_id` / `fav` and `_meta`, by mutating the decoded card in place rather than rebuilding it. Both the `chara` and `ccv3` chunks are rewritten with the resulting JSON.

### Write-back rule

A card is written back whenever it was repaired **or** the image shrank — so no change is ever lost even when the image can't be compressed further.

## Tag pass (`/apply-tags`)

Requires a `dictionary` in the body (400 without one). Same scope as the repair pass: root-level PNGs only.

For each card, `data.tags` is rewritten — each messy variant becomes its canonical, each removed tag is deleted, and the result is deduplicated case-insensitively with original order preserved. Matching is normalized (leading `#` stripped, whitespace collapsed, lowercased), so `#Female`, `  female `, and `FEMALE` all fold together. The legacy root-level `tags` mirror is kept in sync. **No other field is touched, and the card is not repaired.**

The image is never decoded. The new tag JSON is re-encoded into the `chara`/`ccv3` text chunks and injected back into the original file bytes, so pixel data is preserved exactly — no sharp, no pngquant, no quality loss.

A card is written back **only if its tags actually changed**, which makes the pass naturally idempotent and is why it needs no skip-state: "does this card need the dictionary?" is answered by reading the card, not by remembering a previous run. An edited dictionary therefore re-tags every card that needs it with no invalidation step, and re-applying an unchanged dictionary writes nothing.

## Skip-state

The two compressing passes each keep their own skip-state file under `data/{user}/`, so image and character runs never interfere:

- `.compress_state.json` — image compression; saved every 500 files so a crash mid-run doesn't lose all progress.
- `.repair_state.json` — character repair pass; size-based skips only.

`/apply-tags` keeps **no state file** (see above), and so has no `reprocess-` counterpart. The `reprocess-*` endpoints simply delete the relevant state file before re-running.

Older `.repair_state.json` files wrapped the file map as `{ dictHash, files }` back when tags rode along with repair. `loadState` unwraps that shape, so upgrading keeps existing skips rather than forcing one last full reprocess.

### Retagging and the repair skip — working as intended

Rewriting a card's tags changes its file size, so `/fix-characters` will re-examine that card on its next run. This is correct, not a leak: the size-skip's job is to notice a card that changed since it was last processed, and a retagged card *is* a changed card — no different from one edited in SillyTavern. The cost is bounded and self-healing: only cards whose tags actually changed are re-examined, they're re-recorded after one run, and since the image is already compressed the pass finds nothing to save and writes nothing.

That bounding is the whole point. **The invariant to protect is that neither pass may invalidate cards it didn't touch.** The old design broke it twice over: a dictionary edit dropped the skips for the *entire* library, and merely alternating the two buttons did the same, permanently, because they wrote mutually-invalidating hashes into one shared state file. In practice a settled dictionary leaves ~99% of cards untouched per apply, so the re-examined set is tiny.

For the cheapest sequence on a fresh library, **apply tags first, then run Fix Characters** — the retagged cards get compressed once, in the pass they were going to run anyway, instead of being re-examined afterwards.
