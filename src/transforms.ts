// ---------------------------------------------------------------------------
// Pure transform helpers
//
// This module deliberately depends only on Node built-ins (no sharp / chalk /
// pngquant-bin), so it can be imported and unit-tested in isolation without
// pulling in native binaries or ESM-only runtime deps. index.ts re-uses these.
// ---------------------------------------------------------------------------

import * as path from 'node:path';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const TEXT_CHUNK_TYPES = new Set(['tEXt', 'zTXt', 'iTXt']);

export interface Chunk {
    type: string;
    data: Buffer;
}

export type ImageKind = 'png' | 'jpg' | 'gif' | 'webp' | 'other';

// ---------------------------------------------------------------------------
// PNG chunk helpers (mirrors compress.py)
// ---------------------------------------------------------------------------

export function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

export function readPngChunks(data: Buffer): Chunk[] {
    const chunks: Chunk[] = [];
    let pos = 8; // skip 8-byte PNG signature
    while (pos + 12 <= data.length) {
        const length = data.readUInt32BE(pos);
        const type = data.subarray(pos + 4, pos + 8).toString('ascii');
        const chunkData = Buffer.from(data.subarray(pos + 8, pos + 8 + length));
        chunks.push({ type, data: chunkData });
        pos += 12 + length; // 4 length + 4 type + N data + 4 crc
    }
    return chunks;
}

export function writePngChunks(chunks: Chunk[]): Buffer {
    const parts: Buffer[] = [PNG_SIGNATURE];
    for (const chunk of chunks) {
        const typeBuffer = Buffer.from(chunk.type, 'ascii');
        const lengthBuffer = Buffer.allocUnsafe(4);
        lengthBuffer.writeUInt32BE(chunk.data.length, 0);
        const crcBuffer = Buffer.allocUnsafe(4);
        crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, chunk.data])), 0);
        parts.push(lengthBuffer, typeBuffer, chunk.data, crcBuffer);
    }
    return Buffer.concat(parts);
}

export function extractTextChunks(data: Buffer): Chunk[] {
    if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) return [];
    return readPngChunks(data).filter(c => TEXT_CHUNK_TYPES.has(c.type));
}

export function injectTextChunks(data: Buffer, textChunks: Chunk[]): Buffer {
    const chunks = readPngChunks(data);
    const result: Chunk[] = [];
    let injected = false;
    for (const chunk of chunks) {
        if (TEXT_CHUNK_TYPES.has(chunk.type)) continue; // strip old text chunks
        result.push(chunk);
        if (chunk.type === 'IHDR' && !injected) {
            result.push(...textChunks);
            injected = true;
        }
    }
    return writePngChunks(result);
}

// ---------------------------------------------------------------------------
// Classification / formatting
// ---------------------------------------------------------------------------

export function classifyExt(ext: string): ImageKind {
    switch (ext) {
        case '.png':
            return 'png';
        case '.jpg':
        case '.jpeg':
            return 'jpg';
        case '.gif':
            return 'gif';
        case '.webp':
            return 'webp';
        default:
            return 'other';
    }
}

export function computeScaledDimensions(
    w: number,
    h: number,
    maxDimension: number,
    minDimension: number,
): { newW: number; newH: number } | null {
    if (maxDimension <= 0 || Math.max(w, h) <= maxDimension) return null;
    let scale = maxDimension / Math.max(w, h);
    if (minDimension > 0 && Math.min(w, h) * scale < minDimension) {
        scale = minDimension / Math.min(w, h);
    }
    if (scale >= 1) return null;
    return { newW: Math.round(w * scale), newH: Math.round(h * scale) };
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function stateKey(filePath: string, userDir: string): string {
    return path.relative(userDir, filePath);
}
