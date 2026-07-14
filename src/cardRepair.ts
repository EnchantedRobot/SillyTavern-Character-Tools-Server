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
//   - Preserve ALL other data, including unknown extension metadata
//     (extensions.gallery_id / fav, _meta, addon fields, …) by mutating the
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
    normalizeTokens(card, changes);
    return { card, changes };
}

export interface ChunkRepairResult {
    /** The (possibly rewritten) text-chunk list. */
    chunks: Chunk[];
    /** True if a chara/ccv3 card chunk was found and decoded. */
    found: boolean;
    /** True if the processed card differs from the original (tags and/or repair). */
    changed: boolean;
    /** True if the repair step (V3 upgrade / token fixes / backfill) changed the card. */
    repaired: boolean;
    /** True if the tag dictionary changed the card's tags. */
    tagsChanged: boolean;
    /** Human-readable descriptions of every change made. */
    changes: string[];
}

/**
 * Given a PNG's text chunks, locate the character card (preferring ccv3 over
 * chara) and run it through the card-processing pass: apply the tag dictionary
 * (when provided) then repair/upgrade it. Returns an updated text-chunk list
 * with every card chunk re-encoded to the resulting JSON. Non-card text chunks
 * pass through untouched. When no card is found the chunks are returned
 * unchanged. Future card transforms slot in alongside merge + repair here.
 */
export function repairCardChunks(textChunks: Chunk[], dictionary?: TagDictionary): ChunkRepairResult {
    // Locate the card, preferring ccv3 (the newer, authoritative chunk).
    let card: Card | null = null;
    for (const keyword of ['ccv3', 'chara']) {
        for (const chunk of textChunks) {
            if (chunk.type !== 'tEXt') continue;
            const split = splitTextChunk(chunk.data);
            if (split?.keyword === keyword) {
                const decoded = decodeCard(split.value);
                if (decoded) {
                    card = decoded;
                    break;
                }
            }
        }
        if (card) break;
    }

    if (!card) {
        return { chunks: textChunks, found: false, changed: false, repaired: false, tagsChanged: false, changes: [] };
    }

    const before = JSON.stringify(card);
    const changes: string[] = [];

    // 1. Tag dictionary (extension-owned, passed in per-run). 2. Card repair.
    let tagsChanged = false;
    if (dictionary) {
        const merged = mergeCardTags(card, dictionary);
        tagsChanged = merged.changed;
        changes.push(...merged.changes);
    }

    const repair = repairCard(card);
    const repaired = repair.changes.length > 0;
    changes.push(...repair.changes);

    const changed = JSON.stringify(card) !== before;

    if (!changed) {
        return { chunks: textChunks, found: true, changed: false, repaired, tagsChanged, changes };
    }

    // Re-encode every existing card chunk (chara and/or ccv3) with the repaired
    // JSON; leave all other text chunks in place.
    const rewritten = textChunks.map((chunk) => {
        if (chunk.type !== 'tEXt') return chunk;
        const split = splitTextChunk(chunk.data);
        if (split && CARD_KEYWORDS.has(split.keyword)) {
            return encodeCardChunk(split.keyword, card as Card);
        }
        return chunk;
    });

    return { chunks: rewritten, found: true, changed: true, repaired, tagsChanged, changes };
}
