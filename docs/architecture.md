# Architecture

The two SillyTavern data directories are handled by **separate endpoints** with different goals:

| Directory | Endpoint | PNG metadata | Max dimension | WEBP conversion | Tag merge | Card repair |
|---|---|---|---|---|---|---|
| `data/{user}/user/images/` | `/compress` | Not preserved | 2048px | Yes | No | No |
| `data/{user}/characters/` | `/fix-characters` | Preserved (`chara`/`ccv3` chunk) | 2048px | Never | Yes | Yes |

`/compress` only touches `user/images/`. Character cards are handled by `/fix-characters`, which in a **single pass per card** applies the tag dictionary, upgrades/repairs the embedded card JSON, and compresses the image. The tag dictionary is owned by the extension and passed in the request body — this plugin holds no dictionary of its own.

## Image compression (`/compress`)

For every PNG/JPG in `user/images/`, a WEBP (quality 90) encode is tried first. If it comes out smaller than the original — true for almost all photographic/AI-generated images — the file is replaced with a same-basename `.webp` and the original is deleted. If WEBP doesn't help (e.g. small flat-color icons), the file falls back to normal PNG/JPG compression: JPEGs are re-encoded at quality 75 with mozjpeg (progressive); PNGs are quantized with pngquant.

Converted files don't need separate tracking: once a file becomes `.webp` it's no longer picked up by the PNG/JPG scan, so it's automatically skipped on future runs. If a file is later redownloaded as PNG/JPG (e.g. after a manual re-fetch), it's treated as a fresh file — any stale `.webp` from a prior conversion at the same path is overwritten.

## Character pass (`/fix-characters`)

Each card runs the full pass in a **single decode/write**: tag merge, card repair, then image compression.

The character pass is **PNG-only**: a card embeds its JSON in a PNG text chunk, so only a PNG can be a card. Any jpg/webp sitting in `characters/` can't be a card — there's nothing to repair and nothing to convert — so it's left untouched. (`/compress`, by contrast, handles PNG/JPG/WEBP.)

Only files at the **root** of `characters/` are treated as cards. SillyTavern keeps a character's expression sprites in a subfolder named after it (`characters/<Name>/happy.png`, …); those aren't cards, so the character pass doesn't recurse into subfolders and never touches them. (`/compress` still walks `user/images/` recursively — both rules are specific to the character pass.)

`characters/` is **never** converted to WEBP: character cards store their JSON in a PNG `chara`/`ccv3` text chunk, which WEBP can't carry, so converting them would corrupt the card. Otherwise the image is quantized and oversized cards are downscaled, exactly as in `/compress`.

### 1. Tag merge

Only runs when a `dictionary` is supplied. Rewrites `data.tags`: each messy variant becomes its canonical, each removed tag is deleted, and the result is deduplicated case-insensitively with original order preserved. Matching is normalized (leading `#` stripped, whitespace collapsed, lowercased), so `#Female`, `  female `, and `FEMALE` all fold together.

### 2. Card repair

A *lightweight* upgrade that only fixes things that are actually broken — it never rewrites prose, clears prompts, or substitutes `{{char}}` for a name. Specifically it:

- **Upgrades V2 → V3**: `chara_card_v2` → `chara_card_v3` (spec_version `3.0`).
- **Backfills required V3 fields**: adds `data.group_only_greetings` (`[]`), `character_book.extensions` (`{}`), and `use_regex: false` on any `character_book` entry missing it.
- **Normalises malformed template tokens** in all content fields except `mes_example`:
  - `{char}` / `{user}` (single bracket) → `{{char}}` / `{{user}}`
  - `{{Char}}` / `{{USER}}` (any case) → lowercase canonical form
  - broken pronoun aliases `{{sub}}` `{{pos}}` `{{obj}}` `{{poss}}` `{{poss_p}}` `{{ref}}` (and single-bracket variants) → `{{user}}`
- **Preserves everything else**, including unknown extension metadata such as `extensions.gallery_id` / `fav` and `_meta`, by mutating the decoded card in place rather than rebuilding it. Both the `chara` and `ccv3` chunks are rewritten with the resulting JSON.

### Write-back rule

A card is written back whenever its tags changed, it was repaired, **or** the image shrank — so no change is ever lost even when the image can't be compressed further.

## Skip-state

Each pass keeps its own skip-state file under `data/{user}/`, so image and character runs never interfere:

- `.compress_state.json` — image compression; saved every 500 files so a crash mid-run doesn't lose all progress.
- `.repair_state.json` — character pass; also records a hash of the dictionary it was built under. If that hash changes between runs, size-based skips are dropped and the new dictionary is re-applied to every card.

The `reprocess-*` endpoints simply delete the relevant state file before re-running.
