import { describe, it, expect } from 'vitest';
import {
    fixTokens,
    repairCard,
    decodeCard,
    encodeCardChunk,
    repairCardChunks,
    locateCard,
    readCardTags,
} from '../src/cardRepair';
import type { Chunk } from '../src/transforms';

// Build a tEXt chunk carrying a base64-encoded card, exactly as SillyTavern does.
function cardChunk(keyword: string, card: object): Chunk {
    return encodeCardChunk(keyword, card as Record<string, unknown>);
}

function v3Card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            name: 'Alice',
            description: 'A friendly {{char}}.',
            group_only_greetings: [],
            ...overrides,
        },
    };
}

describe('fixTokens', () => {
    it('upgrades single-bracket tokens to double-bracket', () => {
        expect(fixTokens('hi {char} and {user}')).toBe('hi {{char}} and {{user}}');
    });

    it('normalises case on double-bracket tokens', () => {
        expect(fixTokens('{{Char}} {{USER}}')).toBe('{{char}} {{user}}');
    });

    it('replaces pronoun aliases with {{user}}', () => {
        expect(fixTokens('{{sub}} {{obj}} {{poss}} {{poss_p}} {{ref}} {{pos}}')).toBe(
            '{{user}} {{user}} {{user}} {{user}} {{user}} {{user}}',
        );
        expect(fixTokens('{sub} {poss_p}')).toBe('{{user}} {{user}}');
    });

    it('does not corrupt already-correct tokens', () => {
        expect(fixTokens('{{char}} {{user}}')).toBe('{{char}} {{user}}');
    });

    it('leaves unrelated braces alone', () => {
        expect(fixTokens('function() { return {a: 1}; }')).toBe('function() { return {a: 1}; }');
    });
});

describe('repairCard — V2 → V3 upgrade', () => {
    it('bumps spec markers and backfills required fields', () => {
        const card = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: { name: 'Bob', description: 'x' },
        };
        const { changes } = repairCard(card);
        expect(card.spec).toBe('chara_card_v3');
        expect(card.spec_version).toBe('3.0');
        expect((card.data as Record<string, unknown>).group_only_greetings).toEqual([]);
        expect(changes.some(c => c.includes('chara_card_v2 → chara_card_v3'))).toBe(true);
    });

    it('adds use_regex and extensions to character_book entries', () => {
        const card = v3Card({
            character_book: { entries: [{ content: 'note', keys: ['a'] }] },
        });
        repairCard(card);
        const book = (card.data as Record<string, any>).character_book;
        expect(book.extensions).toEqual({});
        expect(book.entries[0].use_regex).toBe(false);
    });

    it('does not clobber an existing use_regex value', () => {
        const card = v3Card({
            character_book: { extensions: { foo: 1 }, entries: [{ content: 'n', use_regex: true }] },
        });
        repairCard(card);
        const book = (card.data as Record<string, any>).character_book;
        expect(book.entries[0].use_regex).toBe(true);
        expect(book.extensions).toEqual({ foo: 1 });
    });
});

describe('repairCard — token normalisation', () => {
    it('fixes tokens across data content fields', () => {
        const card = v3Card({
            description: 'You meet {char}, and {sub} greets {user}.',
            first_mes: 'Hello {User}!',
            alternate_greetings: ['Hi {obj}', 'no tokens here'],
        });
        repairCard(card);
        const data = card.data as Record<string, any>;
        expect(data.description).toBe('You meet {{char}}, and {{user}} greets {{user}}.');
        expect(data.first_mes).toBe('Hello {{user}}!');
        expect(data.alternate_greetings[0]).toBe('Hi {{user}}');
    });

    it('leaves mes_example untouched', () => {
        const card = v3Card({ mes_example: '{char}: hi\n{user}: hey' });
        repairCard(card);
        expect((card.data as Record<string, any>).mes_example).toBe('{char}: hi\n{user}: hey');
    });

    it('reports no changes for an already-clean V3 card', () => {
        const { changes } = repairCard(v3Card());
        expect(changes).toEqual([]);
    });
});

describe('repairCard — fav normalisation', () => {
    it('syncs the top-level fav down to the canonical data.extensions.fav (nested wins)', () => {
        const card = v3Card({ extensions: { fav: false } });
        card.fav = true; // the mismatch ST warns about
        const { changes } = repairCard(card);
        expect(card.fav).toBe(false);
        expect((card.data as Record<string, any>).extensions.fav).toBe(false);
        expect(changes.some(c => c.includes('synced top-level to data.extensions.fav'))).toBe(true);
    });

    it('coerces string booleans and resolves the mismatch to the nested value', () => {
        const card = v3Card({ extensions: { fav: 'false' } });
        card.fav = 'true';
        repairCard(card);
        expect((card.data as Record<string, any>).extensions.fav).toBe(false);
        expect(card.fav).toBe(false);
    });

    it('removes the orphan data.fav that /edit-attribute mis-writes', () => {
        const card = v3Card({ fav: true, extensions: { fav: true } });
        card.fav = true;
        const { changes } = repairCard(card);
        expect('fav' in (card.data as Record<string, any>)).toBe(false);
        expect(changes.some(c => c.includes('data.fav: removed'))).toBe(true);
        // consistent values are left in place
        expect(card.fav).toBe(true);
        expect((card.data as Record<string, any>).extensions.fav).toBe(true);
    });

    it('coerces a lone top-level string fav when there is no nested value', () => {
        const card = v3Card();
        card.fav = 'true';
        repairCard(card);
        expect(card.fav).toBe(true);
    });

    it('leaves a consistent fav untouched (no reported change)', () => {
        const card = v3Card({ extensions: { fav: true } });
        card.fav = true;
        const { changes } = repairCard(card);
        expect(changes).toEqual([]);
        expect(card.fav).toBe(true);
    });

    it('does not add a top-level fav when only the nested value exists', () => {
        const card = v3Card({ extensions: { fav: true } });
        const { changes } = repairCard(card);
        expect('fav' in card).toBe(false);
        expect(changes).toEqual([]);
    });
});

describe('repairCard — metadata preservation', () => {
    it('preserves extension metadata and _meta untouched', () => {
        const card = v3Card({
            description: 'meet {char}',
            extensions: { gallery_id: 'a9swrGctBQmI', fav: false },
            _meta: { source: 'CharacterLibrary' },
        });
        repairCard(card);
        const data = card.data as Record<string, any>;
        expect(data.extensions).toEqual({ gallery_id: 'a9swrGctBQmI', fav: false });
        expect(data._meta).toEqual({ source: 'CharacterLibrary' });
    });
});

describe('encode / decode round-trip', () => {
    it('round-trips a card through a tEXt chunk payload', () => {
        const card = v3Card();
        const chunk = encodeCardChunk('chara', card);
        const nul = chunk.data.indexOf(0);
        const value = chunk.data.subarray(nul + 1);
        expect(decodeCard(value)).toEqual(card);
    });

    it('returns null for non-JSON base64', () => {
        expect(decodeCard(Buffer.from('bm90LWpzb24=', 'latin1'))).toBeNull();
    });
});

describe('repairCardChunks', () => {
    it('rewrites both chara and ccv3 chunks with the repaired card', () => {
        const dirty = v3Card({ description: 'meet {char} and {sub}' });
        const chunks: Chunk[] = [
            { type: 'IHDR', data: Buffer.alloc(13) } as Chunk, // ignored (not tEXt)
            cardChunk('chara', dirty),
            cardChunk('ccv3', dirty),
            { type: 'tEXt', data: Buffer.concat([Buffer.from('Comment'), Buffer.from([0]), Buffer.from('keep me')]) },
        ];
        const result = repairCardChunks(chunks);
        expect(result.found).toBe(true);
        expect(result.changed).toBe(true);

        // both card chunks now decode to the repaired JSON
        for (const keyword of ['chara', 'ccv3']) {
            const chunk = result.chunks.find(c => c.type === 'tEXt' && c.data.toString('latin1').startsWith(`${keyword}\0`));
            const value = chunk!.data.subarray(chunk!.data.indexOf(0) + 1);
            const decoded = decodeCard(value) as Record<string, any>;
            expect(decoded.data.description).toBe('meet {{char}} and {{user}}');
        }

        // the unrelated Comment chunk is untouched
        expect(result.chunks.some(c => c.data.toString('latin1') === 'Comment\0keep me')).toBe(true);
    });

    it('prefers the ccv3 chunk when both are present', () => {
        const charaVersion = v3Card({ description: 'from chara' });
        const ccv3Version = v3Card({ description: 'from ccv3 {char}' });
        const result = repairCardChunks([cardChunk('chara', charaVersion), cardChunk('ccv3', ccv3Version)]);
        const ccv3 = result.chunks.find(c => c.data.toString('latin1').startsWith('ccv3\0'))!;
        const decoded = decodeCard(ccv3.data.subarray(ccv3.data.indexOf(0) + 1)) as Record<string, any>;
        expect(decoded.data.description).toBe('from ccv3 {{char}}');
    });

    it('returns found=false with chunks untouched when no card is present', () => {
        const chunks: Chunk[] = [{ type: 'tEXt', data: Buffer.from('Comment\0hi', 'latin1') }];
        const result = repairCardChunks(chunks);
        expect(result.found).toBe(false);
        expect(result.changed).toBe(false);
        expect(result.chunks).toBe(chunks);
    });

    it('returns changed=false for an already-clean card', () => {
        const result = repairCardChunks([cardChunk('ccv3', v3Card())]);
        expect(result.found).toBe(true);
        expect(result.changed).toBe(false);
        expect(result.repaired).toBe(false);
        expect(result.tagsChanged).toBe(false);
    });

    it('merges tags and repairs in one pass, reporting each independently', () => {
        const dict = { mapping: { Female: ['girl'] }, removedTags: ['anypov'] };
        const card = v3Card({ description: 'meet {char}', tags: ['girl', 'anypov', 'dragons'] });
        const result = repairCardChunks([cardChunk('ccv3', card)], dict);

        expect(result.changed).toBe(true);
        expect(result.tagsChanged).toBe(true);
        expect(result.repaired).toBe(true);

        const chunk = result.chunks.find(c => c.data.toString('latin1').startsWith('ccv3\0'))!;
        const decoded = decodeCard(chunk.data.subarray(chunk.data.indexOf(0) + 1)) as Record<string, any>;
        expect(decoded.data.tags).toEqual(['Female', 'dragons']);
        expect(decoded.data.description).toBe('meet {{char}}');
    });

    it('reports tagsChanged without repaired when only tags change', () => {
        const dict = { mapping: { Female: ['girl'] }, removedTags: [] };
        const card = v3Card({ tags: ['girl'] }); // already clean prose/spec
        const result = repairCardChunks([cardChunk('ccv3', card)], dict);
        expect(result.tagsChanged).toBe(true);
        expect(result.repaired).toBe(false);
        expect(result.changed).toBe(true);
    });
});

describe('locateCard', () => {
    it('prefers the ccv3 chunk over the legacy chara chunk', () => {
        const chunks = [
            cardChunk('chara', v3Card({ name: 'old' })),
            cardChunk('ccv3', v3Card({ name: 'new' })),
        ];
        const card = locateCard(chunks) as Record<string, any>;
        expect(card?.data.name).toBe('new');
    });

    it('falls back to chara when there is no ccv3 chunk', () => {
        const card = locateCard([cardChunk('chara', v3Card({ name: 'only' }))]) as Record<string, any>;
        expect(card?.data.name).toBe('only');
    });

    it('returns null when no chunk holds a valid card', () => {
        expect(locateCard([])).toBeNull();
        expect(locateCard([{ type: 'tEXt', data: Buffer.from('foo\0not-base64-json', 'latin1') }])).toBeNull();
    });
});

describe('readCardTags', () => {
    it('reads data.tags from the located card', () => {
        expect(readCardTags([cardChunk('ccv3', v3Card({ tags: ['Female', 'Romance'] }))]))
            .toEqual(['Female', 'Romance']);
    });

    it('drops non-string and blank/whitespace tags', () => {
        const card = { data: { tags: ['a', '', '  ', 3, null, 'b'] } };
        expect(readCardTags([cardChunk('chara', card)])).toEqual(['a', 'b']);
    });

    it('falls back to a root-level tags mirror', () => {
        expect(readCardTags([cardChunk('ccv3', { tags: ['x', 'y'] })])).toEqual(['x', 'y']);
    });

    it('returns [] when there is no card or no tags', () => {
        expect(readCardTags([])).toEqual([]);
        expect(readCardTags([cardChunk('ccv3', v3Card())])).toEqual([]);
    });
});
