import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { extractTextChunks, injectTextChunks } from '../src/transforms';
import { encodeCardChunk, repairCardChunks, decodeCard } from '../src/cardRepair';

// End-to-end: a real PNG carrying a dirty V2 card is recompressed by sharp
// (which strips text chunks), then the repaired card is re-injected. Verifies
// the card survives the real image pipeline and comes out V3-clean.
describe('character card survives a real sharp recompression', () => {
    it('repairs the card and preserves it through re-encoding', async () => {
        const dirtyCard = {
            spec: 'chara_card_v2',
            spec_version: '2.0',
            data: {
                name: 'Alice',
                description: 'You meet {char}. {sub} waves at {user}.',
                extensions: { gallery_id: 'keepme', fav: true },
            },
        };

        // Build a genuine PNG and embed the card as SillyTavern would.
        const basePng = await sharp({
            create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 20, b: 30 } },
        }).png().toBuffer();
        const withCard = injectTextChunks(basePng, [encodeCardChunk('chara', dirtyCard)]);

        // Repair the embedded card from the extracted chunks.
        const repair = repairCardChunks(extractTextChunks(withCard));
        expect(repair.found).toBe(true);
        expect(repair.changed).toBe(true);

        // Recompress the pixels, then re-inject. injectTextChunks strips any
        // pre-existing text chunks first, so exactly one card chunk remains
        // regardless of whether the encoder happened to carry the old one over.
        const recompressed = await sharp(withCard).png({ compressionLevel: 9 }).toBuffer();
        const final = injectTextChunks(recompressed, repair.chunks);
        expect(extractTextChunks(final).filter(c => c.data.toString('latin1').startsWith('chara\0'))).toHaveLength(1);

        // The final PNG is valid and still carries the repaired V3 card.
        const meta = await sharp(final).metadata();
        expect(meta.format).toBe('png');

        const chunk = extractTextChunks(final).find(c => c.data.toString('latin1').startsWith('chara\0'))!;
        const card = decodeCard(chunk.data.subarray(chunk.data.indexOf(0) + 1)) as Record<string, any>;
        expect(card.spec).toBe('chara_card_v3');
        expect(card.data.description).toBe('You meet {{char}}. {{user}} waves at {{user}}.');
        expect(card.data.group_only_greetings).toEqual([]);
        expect(card.data.extensions).toEqual({ gallery_id: 'keepme', fav: true });
    });
});
