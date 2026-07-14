import { describe, it, expect } from 'vitest';
import {
    crc32,
    readPngChunks,
    writePngChunks,
    extractTextChunks,
    injectTextChunks,
    type Chunk,
} from '../src/transforms';

// Build a minimal-but-valid PNG byte stream: signature + IHDR + optional text + IEND.
function buildPng(extra: Chunk[] = []): Buffer {
    const ihdr: Chunk = {
        type: 'IHDR',
        // 13-byte IHDR payload: 1x1, 8-bit, truecolor — contents don't matter for chunk parsing
        data: Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
    };
    const iend: Chunk = { type: 'IEND', data: Buffer.alloc(0) };
    return writePngChunks([ihdr, ...extra, iend]);
}

function textChunk(keyword: string, value: string): Chunk {
    return { type: 'tEXt', data: Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]) };
}

describe('crc32', () => {
    it('matches the known PNG IEND CRC-32 (0xAE426082)', () => {
        // The CRC is computed over the chunk type bytes ("IEND") with no data.
        expect(crc32(Buffer.from('IEND', 'ascii'))).toBe(0xae426082);
    });

    it('is stable and unsigned for arbitrary input', () => {
        const value = crc32(Buffer.from('hello world'));
        expect(value).toBe(crc32(Buffer.from('hello world')));
        expect(value).toBeGreaterThanOrEqual(0); // never returns a negative (>>> 0)
    });
});

describe('readPngChunks / writePngChunks round-trip', () => {
    it('parses the chunks it writes back identically', () => {
        const png = buildPng([textChunk('Comment', 'hi')]);
        const chunks = readPngChunks(png);
        expect(chunks.map(c => c.type)).toEqual(['IHDR', 'tEXt', 'IEND']);

        const rewritten = writePngChunks(chunks);
        expect(rewritten.equals(png)).toBe(true);
    });
});

describe('extractTextChunks / injectTextChunks', () => {
    it('extracts only text chunks from a PNG', () => {
        const png = buildPng([textChunk('chara', 'eyJuYW1lIjoiQSJ9')]);
        const text = extractTextChunks(png);
        expect(text).toHaveLength(1);
        expect(text[0].type).toBe('tEXt');
    });

    it('returns nothing for a buffer without a PNG signature', () => {
        expect(extractTextChunks(Buffer.from('not a png'))).toEqual([]);
    });

    it('preserves character-card metadata across a strip-and-reinject cycle', () => {
        // Simulates the real flow: a card PNG carries embedded JSON in a tEXt chunk,
        // the image is recompressed (losing text chunks), then metadata is re-injected.
        const cardJson = 'chara';
        const original = buildPng([textChunk(cardJson, 'eyJuYW1lIjoiQ2hhcmFjdGVyIn0=')]);
        const savedText = extractTextChunks(original);

        const recompressed = buildPng(); // no text chunks (as sharp/pngquant would output)
        expect(extractTextChunks(recompressed)).toHaveLength(0);

        const restored = injectTextChunks(recompressed, savedText);
        const restoredText = extractTextChunks(restored);
        expect(restoredText).toHaveLength(1);
        expect(restoredText[0].data.equals(savedText[0].data)).toBe(true);
    });

    it('injects text chunks immediately after IHDR', () => {
        const restored = injectTextChunks(buildPng(), [textChunk('chara', 'x')]);
        const types = readPngChunks(restored).map(c => c.type);
        expect(types).toEqual(['IHDR', 'tEXt', 'IEND']);
    });
});
