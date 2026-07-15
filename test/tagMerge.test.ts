import { describe, it, expect } from 'vitest';
import { norm, mergeTags, mergeCardTags, type TagDictionary } from '../src/tagMerge';

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

    // A dictionary can contradict itself: a tag listed as a canonical (things map
    // INTO it) while ALSO sitting in the removed list. Mapping must win, or the
    // merge deletes a canonical it just produced and re-runs aren't idempotent.
    describe('mapping wins over removal (idempotency)', () => {
        const contradictory: TagDictionary = {
            mapping: { 'Forced Proximity': ['sharingabed'] },
            removedTags: ['forced proximity'],
        };

        it('keeps a canonical even when it also appears in removedTags', () => {
            const { tags } = mergeTags(['Forced Proximity'], contradictory);
            expect(tags).toEqual(['Forced Proximity']);
        });

        it('maps a variant to its canonical rather than removing it', () => {
            const { tags } = mergeTags(['#sharingabed'], contradictory);
            expect(tags).toEqual(['Forced Proximity']);
        });

        it('is idempotent: re-applying the merged output changes nothing', () => {
            const once = mergeTags(['#sharingabed', 'girl'], contradictory).tags;
            const twice = mergeTags(once, contradictory);
            expect(twice.tags).toEqual(once);
            expect(twice.changed).toBe(false);
        });

        it('still drops a removed tag that no canonical claims', () => {
            const { tags, changed } = mergeTags(['forced proximity', 'oc'], dict);
            expect(tags).toEqual(['forced proximity']); // not in `dict`'s mapping, and 'oc' is removed
            expect(changed).toBe(true);
        });
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
