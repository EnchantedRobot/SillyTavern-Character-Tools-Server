// ---------------------------------------------------------------------------
// Tag merging (dictionary-driven)
//
// Pure logic (Node built-ins only) so it can be unit-tested without sharp /
// pngquant, and so it slots into the same card-processing pass as cardRepair.
//
// The dictionary is authored and owned by the extension; the server is stateless
// about it and receives it per-run in the request body. This mirrors the client
// tag-analysis.js logic (norm() + apply), so the SAME dictionary produces the
// same result whether previewed in the editor or applied on disk here.
//
// IMPORTANT: norm() MUST stay byte-for-byte identical to the extension's
// tag-analysis.js norm() and the categorize-tags skill scripts. If it changes in
// one place it must change in all of them.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Card = Record<string, any>;

export interface TagDictionary {
    /** canonical tag -> the messy variants that fold into it. */
    mapping: Record<string, string[]>;
    /** tags to delete from every card. */
    removedTags: string[];
}

/**
 * Normalize a tag to its match key: trim, strip leading '#', trim again,
 * collapse internal whitespace, lowercase. Applied to both dictionary entries
 * and card tags so "#Female", "  female ", and "FEMALE" all resolve alike.
 */
export function norm(t: string): string {
    return String(t)
        .trim()
        .replace(/^#+/, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

/**
 * Apply a dictionary to a tag list. Every variant (and any tag whose normalized
 * form equals a canonical) is rewritten to its canonical; a tag no canonical
 * claims is dropped when it's in the removed list; the result is deduped
 * case-insensitively with original order kept. Returns the new list and whether
 * anything changed.
 *
 * Mapping wins over removal: if a tag is claimed by a canonical/variant AND also
 * appears in removedTags (a contradictory dictionary), it is mapped, not deleted.
 * This keeps re-runs idempotent — a canonical the merge just produced is claimed
 * by itself, so it survives the next run — and matches the editor's buildBuckets
 * precedence ("mapping is the more specific intent").
 */
export function mergeTags(currentTags: string[], dict: TagDictionary): { tags: string[]; changed: boolean } {
    // Normalized variant/canonical -> canonical (canonical maps to itself so a
    // tag that already matches a canonical is normalized to its exact casing).
    const variantToCanonical = new Map<string, string>();
    for (const [canonical, variants] of Object.entries(dict.mapping ?? {})) {
        variantToCanonical.set(norm(canonical), canonical);
        for (const v of variants ?? []) variantToCanonical.set(norm(v), canonical);
    }
    const removed = new Set((dict.removedTags ?? []).map(norm));

    const result: string[] = [];
    const seen = new Set<string>();
    let changed = false;

    for (const tag of currentTags) {
        const key = norm(tag);
        const mapped = variantToCanonical.get(key);
        // Removal only applies to tags no canonical claims (mapping wins).
        if (mapped === undefined && removed.has(key)) { changed = true; continue; } // junk — drop it
        const out = mapped ?? tag;
        if (out !== tag) changed = true;
        const outKey = norm(out);
        if (seen.has(outKey)) { changed = true; continue; } // dropped a dupe
        seen.add(outKey);
        result.push(out);
    }

    return { tags: result, changed };
}

/**
 * Merge tags on a decoded card in place. Reads/writes data.tags (the real V2/V3
 * field) and keeps a root-level tags mirror in sync when one is present. Returns
 * the same change shape as repairCard so both feed one combined changes list.
 */
export function mergeCardTags(card: Card, dict: TagDictionary): { changed: boolean; changes: string[] } {
    const data: Card = card.data && typeof card.data === 'object' ? card.data : card;
    const current = Array.isArray(data.tags) ? data.tags.filter((t: unknown): t is string => typeof t === 'string') : [];
    if (current.length === 0) return { changed: false, changes: [] };

    const { tags, changed } = mergeTags(current, dict);
    if (!changed) return { changed: false, changes: [] };

    data.tags = tags;
    if (Array.isArray(card.tags)) card.tags = tags; // keep the legacy root mirror consistent

    return { changed: true, changes: [`data.tags: applied dictionary (${current.length} → ${tags.length} tags)`] };
}

/**
 * Deterministic, compact hash of a dictionary's meaningful content (keys and
 * members are sorted so ordering doesn't affect it). Used to invalidate the
 * character state file when the dictionary changes, so edits aren't hidden by
 * the size-skip. Returns 'none' when there's no dictionary to apply.
 */
export function dictionaryHash(dict?: TagDictionary): string {
    if (!dict) return 'none';
    const mapping = dict.mapping ?? {};
    const keys = Object.keys(mapping);
    if (keys.length === 0 && (dict.removedTags ?? []).length === 0) return 'none';
    const canonical = keys.sort().map(k => `${k}=${[...(mapping[k] ?? [])].map(norm).sort().join(',')}`);
    const removed = [...(dict.removedTags ?? [])].map(norm).sort();
    return createHash('sha1').update(`${canonical.join('|')}##${removed.join(',')}`).digest('hex');
}
