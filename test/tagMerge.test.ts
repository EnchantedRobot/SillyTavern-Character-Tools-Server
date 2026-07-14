import { describe, it, expect } from 'vitest';
import { norm, mergeTags, mergeCardTags, dictionaryHash, type TagDictionary } from '../src/tagMerge';

const dict: TagDictionary = {
    mapping: {
        Female: ['female', 'girl', 'woman'],
        Romance: ['romantic', 'love'],
    },
    removedTags: ['anypov', 'oc'],
};

describe('norm', () => {
    it('strips a leading #, trims, collapses whitespace, and lowercases', () => {
        expect(norm('#Female')).toBe('female');
        expect(norm('  Arranged   Marriage ')).toBe('arranged marriage');
        expect(norm('##FOO')).toBe('foo');
    });

    // CRITICAL INVARIANT: this normalization must stay byte-identical to the
    // extension's norm() (tag-analysis.js) and the categorize-tags skill. The
    // same golden table is pinned in the extension's test suite. If you change
    // one, change all three, or the client will merge tags differently than the
    // server applies them.
    it.each([
        ['#Female', 'female'],
        ['female', 'female'],
        ['FEMALE', 'female'],
        ['  Arranged   Marriage ', 'arranged marriage'],
        ['##FOO', 'foo'],
        ['#  Spaced', 'spaced'],
        ['Multi   Word', 'multi word'],
        ['a\tb  c', 'a b c'],
        ['  #  ', ''],
        ['AnyPOV', 'anypov'],
    ])('normalizes %j -> %j (cross-repo invariant)', (input, expected) => {
        expect(norm(input)).toBe(expected);
    });
});

describe('mergeTags', () => {
    it('renames variants to their canonical', () => {
        const { tags, changed } = mergeTags(['girl', 'romantic'], dict);
        expect(tags).toEqual(['Female', 'Romance']);
        expect(changed).toBe(true);
    });

    it('matches variants regardless of case / # / spacing', () => {
        expect(mergeTags(['#Woman', '  LOVE '], dict).tags).toEqual(['Female', 'Romance']);
    });

    it('normalises a tag that already equals a canonical (case fix)', () => {
        const { tags, changed } = mergeTags(['female'], dict);
        expect(tags).toEqual(['Female']);
        expect(changed).toBe(true);
    });

    it('drops removed tags', () => {
        const { tags, changed } = mergeTags(['AnyPOV', 'girl'], dict);
        expect(tags).toEqual(['Female']);
        expect(changed).toBe(true);
    });

    it('dedupes case-insensitively after merging, keeping first order', () => {
        const { tags } = mergeTags(['girl', 'Female', 'woman'], dict);
        expect(tags).toEqual(['Female']);
    });

    it('preserves unrelated tags and their order', () => {
        const { tags, changed } = mergeTags(['dragons', 'girl', 'space opera'], dict);
        expect(tags).toEqual(['dragons', 'Female', 'space opera']);
        expect(changed).toBe(true);
    });

    it('reports changed=false when nothing matches', () => {
        const { tags, changed } = mergeTags(['dragons', 'space opera'], dict);
        expect(tags).toEqual(['dragons', 'space opera']);
        expect(changed).toBe(false);
    });
});

describe('mergeCardTags', () => {
    it('rewrites data.tags in place and reports the change', () => {
        const card: Record<string, any> = { data: { name: 'A', tags: ['girl', 'anypov'] } };
        const res = mergeCardTags(card, dict);
        expect(res.changed).toBe(true);
        expect(card.data.tags).toEqual(['Female']);
        expect(res.changes[0]).toContain('data.tags');
    });

    it('keeps a root-level tags mirror in sync when present', () => {
        const card: Record<string, any> = { tags: ['girl'], data: { tags: ['girl'] } };
        mergeCardTags(card, dict);
        expect(card.data.tags).toEqual(['Female']);
        expect(card.tags).toEqual(['Female']);
    });

    it('is a no-op for a card with no tags', () => {
        const card: Record<string, any> = { data: { name: 'A' } };
        expect(mergeCardTags(card, dict).changed).toBe(false);
    });

    it('reports changed=false when the dictionary changes nothing', () => {
        const card: Record<string, any> = { data: { tags: ['dragons'] } };
        expect(mergeCardTags(card, dict).changed).toBe(false);
        expect(card.data.tags).toEqual(['dragons']);
    });
});

describe('dictionaryHash', () => {
    it('is stable regardless of key/variant ordering', () => {
        const a: TagDictionary = { mapping: { Female: ['girl', 'woman'], Romance: ['love'] }, removedTags: ['oc', 'anypov'] };
        const b: TagDictionary = { mapping: { Romance: ['love'], Female: ['woman', 'girl'] }, removedTags: ['anypov', 'oc'] };
        expect(dictionaryHash(a)).toBe(dictionaryHash(b));
    });

    it('returns "none" for an undefined or empty dictionary', () => {
        expect(dictionaryHash(undefined)).toBe('none');
        expect(dictionaryHash({ mapping: {}, removedTags: [] })).toBe('none');
    });

    it('changes when the content changes', () => {
        const base = dictionaryHash(dict);
        expect(dictionaryHash({ ...dict, removedTags: ['anypov'] })).not.toBe(base);
        expect(dictionaryHash({ mapping: { ...dict.mapping, Female: ['female'] }, removedTags: dict.removedTags })).not.toBe(base);
    });
});
