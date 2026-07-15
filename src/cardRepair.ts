// ---------------------------------------------------------------------------
// Character card repair / lightweight V3 upgrade
//
// Pure logic (Node built-ins only) so it can be unit-tested without sharp /
// pngquant. This is deliberately conservative: it performs a *lightweight*
// upgrade and fixes things that are actually broken. It never rewrites prose,
// clears prompts, filters tags, or substitutes {{char}} for a name — those are
// opinionated transforms handled elsewhere (or not at all).
//
// What it does:
//   - Upgrade V2 spec markers (chara_card_v2 → chara_card_v3 / 3.0)
//   - Ensure required V3 fields exist (group_only_greetings,
//     character_book.extensions, per-entry use_regex)
//   - Normalise malformed template tokens:
//       · {char}/{user} (single bracket)      → {{char}}/{{user}}
//       · {{Char}}/{{USER}} (any case)         → {{char}}/{{user}}
//       · {{sub}} {{pos}} {{obj}} {{poss}}
//         {{poss_p}} {{ref}} (+ single-bracket) → {{user}}
//   - Heal the `fav` flag when write paths (e.g. ST's /edit-attribute, other
//     extensions) leave it malformed: coerce string booleans to real booleans,
//     drop the orphan data.fav that /edit-attribute mis-writes, and mirror the
//     canonical data.extensions.fav onto the legacy top-level fav. ST treats
//     data.extensions.fav as authoritative on load (readFromV2) and logs a
//     "Spec v2 data mismatch" warning when the two disagree.
//   - Preserve ALL other data, including unknown extension metadata
//     (extensions.gallery_id, _meta, addon fields, …) by mutating the
//     decoded card in place rather than rebuilding it.
//
// mes_example is intentionally left untouched.
// ---------------------------------------------------------------------------

import type { Chunk } from './transforms';
import { mergeCardTags, type TagDictionary } from './tagMerge';

// The card JSON is stored identically in both PNG tEXt chunks; we update both.
const CARD_KEYWORDS = new Set(['chara', 'ccv3']);

const V2_SPEC = 'chara_card_v2';
const V3_SPEC = 'chara_card_v3';
const V3_SPEC_VERSION = '3.0';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Card = Record<string, any>;

export interface CardRepairResult {
    /** The mutated card (same object reference that was passed in). */
    card: Card;
    /** Human-readable descriptions of every change made. */
    changes: string[];
}

// ---------------------------------------------------------------------------
// tEXt chunk <-> card JSON
// ---------------------------------------------------------------------------

/** Split a tEXt chunk payload into its latin1 keyword and the raw value bytes. */
function splitTextChunk(data: Buffer): { keyword: string; value: Buffer } | null {
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    return {
        keyword: data.subarray(0, nul).toString('latin1'),
        value: Buffer.from(data.subarray(nul + 1)),
    };
}

/** Decode a base64 tEXt value into a card object, or null if it isn't valid JSON. */
export function decodeCard(value: Buffer): Card | null {
    try {
        const json = Buffer.from(value.toString('latin1'), 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === 'object' ? (parsed as Card) : null;
    } catch {
        return null;
    }
}

/** Re-encode a card object into a tEXt chunk payload (keyword\0 base64-of-JSON). */
export function encodeCardChunk(keyword: string, card: Card): Chunk {
    const json = Buffer.from(JSON.stringify(card), 'utf8');
    const value = Buffer.from(json.toString('base64'), 'latin1');
    return {
        type: 'tEXt',
        data: Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), value]),
    };
}

// ---------------------------------------------------------------------------
// V2 → V3 upgrade + required-field backfill
// ---------------------------------------------------------------------------

function upgradeV2toV3(card: Card, changes: string[]): void {
    if (card.spec !== V2_SPEC) return;
    card.spec = V3_SPEC;
    card.spec_version = V3_SPEC_VERSION;
    changes.push('spec upgraded: chara_card_v2 → chara_card_v3');
}

function ensureV3Fields(card: Card, changes: string[]): void {
    if (card.spec !== V3_SPEC) return;
    if (typeof card.data !== 'object' || card.data === null) return;
    const data: Card = card.data;

    // group_only_greetings MUST be present in V3 (may be an empty array).
    if (!Array.isArray(data.group_only_greetings)) {
        data.group_only_greetings = [];
        changes.push('data.group_only_greetings: added ([])');
    }

    const book = data.character_book;
    if (book && typeof book === 'object') {
        if (typeof book.extensions !== 'object' || book.extensions === null) {
            book.extensions = {};
            changes.push('character_book.extensions: added ({})');
        }
        const entries = Array.isArray(book.entries) ? book.entries : [];
        let patched = 0;
        for (const entry of entries) {
            if (entry && typeof entry === 'object' && !('use_regex' in entry)) {
                entry.use_regex = false;
                patched++;
            }
        }
        if (patched > 0) {
            changes.push(`character_book: added use_regex=false to ${patched} entr${patched === 1 ? 'y' : 'ies'}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Favorite flag normalisation
//
// The `fav` flag lives in two places on a V2/V3 card: the canonical
// data.extensions.fav and the legacy top-level mirror card.fav. SillyTavern
// treats data.extensions.fav as authoritative on load and logs a noisy
// "Spec v2 data mismatch" warning whenever the mirror disagrees. Several write
// paths update only one location — ST's /edit-attribute even mis-writes a
// data.fav that violates the spec — and some store the value as the string
// "true"/"false". We heal to match ST's own resolution: nested wins.
// ---------------------------------------------------------------------------

/** Coerce ST's occasional string booleans to real booleans; pass anything else through. */
function coerceFav(value: unknown): unknown {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
}

function normalizeFav(card: Card, changes: string[]): void {
    const data = card.data;
    if (typeof data !== 'object' || data === null) return;

    // Remove the spec-violating orphan data.fav that /edit-attribute mis-writes;
    // the canonical location is data.extensions.fav.
    if ('fav' in data) {
        delete data.fav;
        changes.push('data.fav: removed (orphan; canonical field is data.extensions.fav)');
    }

    const ext = data.extensions;
    const hasNested = !!ext && typeof ext === 'object' && 'fav' in ext;

    // Coerce the canonical nested value to a real boolean.
    if (hasNested) {
        const coerced = coerceFav(ext.fav);
        if (coerced !== ext.fav) {
            ext.fav = coerced;
            changes.push(`data.extensions.fav: coerced to boolean (${coerced})`);
        }
    }

    // Nothing to mirror onto when there's no top-level fav.
    if (card.fav === undefined) return;

    // data.extensions.fav wins (matches ST's readFromV2); with no canonical
    // value present, just fix the top-level mirror's own type.
    const desired = hasNested ? ext.fav : coerceFav(card.fav);
    if (card.fav !== desired) {
        card.fav = desired;
        changes.push(
            hasNested
                ? `fav: synced top-level to data.extensions.fav (${desired})`
                : `fav: coerced top-level to boolean (${desired})`,
        );
    }
}

// ---------------------------------------------------------------------------
// Token normalisation
// ---------------------------------------------------------------------------

// Double-bracket forms (any case) → canonical lowercase. Alias pronouns → user.
const RE_DOUBLE: [RegExp, string][] = [
    [/\{\{poss_p\}\}/gi, '{{user}}'], // longest alias first
    [/\{\{poss\}\}/gi, '{{user}}'],
    [/\{\{sub\}\}/gi, '{{user}}'],
    [/\{\{pos\}\}/gi, '{{user}}'],
    [/\{\{obj\}\}/gi, '{{user}}'],
    [/\{\{ref\}\}/gi, '{{user}}'],
    [/\{\{char\}\}/gi, '{{char}}'],
    [/\{\{user\}\}/gi, '{{user}}'],
];

// Single-bracket forms → correct double-bracket lowercase. The lookbehind /
// lookahead ensure we only touch genuinely single-bracketed tokens and never
// corrupt an already-correct {{char}} / {{user}}.
const RE_SINGLE: [RegExp, string][] = [
    [/(?<!\{)\{poss_p\}(?!\})/gi, '{{user}}'],
    [/(?<!\{)\{poss\}(?!\})/gi, '{{user}}'],
    [/(?<!\{)\{sub\}(?!\})/gi, '{{user}}'],
    [/(?<!\{)\{pos\}(?!\})/gi, '{{user}}'],
    [/(?<!\{)\{obj\}(?!\})/gi, '{{user}}'],
    [/(?<!\{)\{ref\}(?!\})/gi, '{{user}}'],
    [/(?<!\{)\{char\}(?!\})/gi, '{{char}}'],
    [/(?<!\{)\{user\}(?!\})/gi, '{{user}}'],
];

/** Apply every token correction to a single string. */
export function fixTokens(text: string): string {
    let out = text;
    for (const [re, repl] of RE_DOUBLE) out = out.replace(re, repl);
    for (const [re, repl] of RE_SINGLE) out = out.replace(re, repl);
    return out;
}

// Content fields to normalise — everything except mes_example (left untouched).
const TOKEN_FIELDS = [
    'description', 'personality', 'scenario', 'first_mes',
    'creator_notes', 'system_prompt', 'post_history_instructions',
];

// Fields mirrored at the top level on V2/V3 cards; kept in sync with data.*.
const MIRROR_FIELDS = ['description', 'personality', 'scenario', 'first_mes'];

function normalizeTokens(card: Card, changes: string[]): void {
    const data: Card = card.data && typeof card.data === 'object' ? card.data : card;

    for (const field of TOKEN_FIELDS) {
        if (typeof data[field] === 'string') {
            const fixed = fixTokens(data[field]);
            if (fixed !== data[field]) {
                data[field] = fixed;
                changes.push(`data.${field}: fixed malformed tokens`);
            }
        }
    }

    if (Array.isArray(data.alternate_greetings)) {
        data.alternate_greetings = data.alternate_greetings.map((g: unknown, i: number) => {
            if (typeof g !== 'string') return g;
            const fixed = fixTokens(g);
            if (fixed !== g) changes.push(`data.alternate_greetings[${i}]: fixed malformed tokens`);
            return fixed;
        });
    }

    const book = data.character_book;
    if (book && typeof book === 'object' && Array.isArray(book.entries)) {
        book.entries.forEach((entry: Card, i: number) => {
            if (entry && typeof entry.content === 'string') {
                const fixed = fixTokens(entry.content);
                if (fixed !== entry.content) {
                    entry.content = fixed;
                    changes.push(`character_book.entries[${i}].content: fixed malformed tokens`);
                }
            }
        });
    }

    // Keep the legacy top-level mirror fields consistent with data.* (silent —
    // already reported via data.* above).
    for (const field of MIRROR_FIELDS) {
        if (typeof card[field] === 'string') {
            card[field] = fixTokens(card[field]);
        }
    }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Repair a decoded card in place. Returns the same card object plus a list of
 * changes (empty when nothing needed fixing).
 */
export function repairCard(card: Card): CardRepairResult {
    const changes: string[] = [];
    upgradeV2toV3(card, changes);
    ensureV3Fields(card, changes);
    normalizeFav(card, changes);
    normalizeTokens(card, changes);
    return { card, changes };
}

export interface ChunkRepairResult {
    /** The (possibly rewritten) text-chunk list. */
    chunks: Chunk[];
    /** True if a chara/ccv3 card chunk was found and decoded. */
    found: boolean;
    /** True if the repair changed the card. */
    changed: boolean;
    /** Human-readable descriptions of every change made. */
    changes: string[];
}

/**
 * Locate the character card in a PNG's text chunks, preferring the newer,
 * authoritative `ccv3` chunk over the legacy `chara` chunk. Returns the decoded
 * card, or null when no chunk holds valid card JSON.
 */
export function locateCard(textChunks: Chunk[]): Card | null {
    for (const keyword of ['ccv3', 'chara']) {
        for (const chunk of textChunks) {
            if (chunk.type !== 'tEXt') continue;
            const split = splitTextChunk(chunk.data);
            if (split?.keyword === keyword) {
                const decoded = decodeCard(split.value);
                if (decoded) return decoded;
            }
        }
    }
    return null;
}

/**
 * Read a card's tag list from a PNG's text chunks: `data.tags` (the real V2/V3
 * field, falling back to a root-level `tags` mirror), with non-string/blank
 * entries dropped. Returns [] when there's no card or no tags. Read-only — used
 * by the `/character-tags` survey that feeds the extension's dictionary editor.
 */
export function readCardTags(textChunks: Chunk[]): string[] {
    const card = locateCard(textChunks);
    if (!card) return [];
    const data: Card = card.data && typeof card.data === 'object' ? card.data : card;
    const tags = Array.isArray(data.tags) ? data.tags : Array.isArray(card.tags) ? card.tags : [];
    return tags.filter((t: unknown): t is string => typeof t === 'string' && t.trim() !== '');
}

/**
 * Re-encode every existing card chunk (chara and/or ccv3) with `card`'s JSON;
 * leave all other text chunks in place.
 */
function rewriteCardChunks(textChunks: Chunk[], card: Card): Chunk[] {
    return textChunks.map((chunk) => {
        if (chunk.type !== 'tEXt') return chunk;
        const split = splitTextChunk(chunk.data);
        if (split && CARD_KEYWORDS.has(split.keyword)) {
            return encodeCardChunk(split.keyword, card);
        }
        return chunk;
    });
}

/**
 * Given a PNG's text chunks, locate the character card (preferring ccv3 over
 * chara) and repair/upgrade it. Returns an updated text-chunk list with every
 * card chunk re-encoded to the resulting JSON; non-card text chunks pass
 * through untouched, and when no card is found the chunks are returned
 * unchanged.
 *
 * Tags are deliberately NOT touched here — merging tags is `mergeTagChunks`,
 * driven by the separate /apply-tags pass. Keeping the two apart is what lets
 * each own its own skip/idempotence rules.
 */
export function repairCardChunks(textChunks: Chunk[]): ChunkRepairResult {
    // Locate the card, preferring ccv3 (the newer, authoritative chunk).
    const card = locateCard(textChunks);

    if (!card) {
        return { chunks: textChunks, found: false, changed: false, changes: [] };
    }

    const before = JSON.stringify(card);
    const { changes } = repairCard(card);

    if (JSON.stringify(card) === before) {
        return { chunks: textChunks, found: true, changed: false, changes };
    }

    return { chunks: rewriteCardChunks(textChunks, card), found: true, changed: true, changes };
}

export interface ChunkTagResult {
    /** The (possibly rewritten) text-chunk list. */
    chunks: Chunk[];
    /** True if the dictionary changed the card's tags. */
    changed: boolean;
    /** Human-readable descriptions of every change made. */
    changes: string[];
}

/**
 * Apply the tag dictionary to the card in a PNG's text chunks, and nothing
 * else. Only the card's tag array is touched (see `mergeCardTags`); no repair,
 * no upgrade, no other field. Returns the chunks unchanged when there's no
 * card or the dictionary is a no-op for it — which makes the pass idempotent,
 * so re-applying an unchanged dictionary rewrites nothing and needs no
 * skip-state to be fast.
 */
export function mergeTagChunks(textChunks: Chunk[], dictionary: TagDictionary): ChunkTagResult {
    const card = locateCard(textChunks);
    if (!card) return { chunks: textChunks, changed: false, changes: [] };

    const { changed, changes } = mergeCardTags(card, dictionary);
    if (!changed) return { chunks: textChunks, changed: false, changes };

    return { chunks: rewriteCardChunks(textChunks, card), changed: true, changes };
}
