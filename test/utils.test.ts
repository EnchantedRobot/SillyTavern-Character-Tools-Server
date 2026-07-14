import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { classifyExt, formatBytes, stateKey } from '../src/transforms';

describe('classifyExt', () => {
    it('maps known extensions to their image kind', () => {
        expect(classifyExt('.png')).toBe('png');
        expect(classifyExt('.jpg')).toBe('jpg');
        expect(classifyExt('.jpeg')).toBe('jpg');
        expect(classifyExt('.gif')).toBe('gif');
        expect(classifyExt('.webp')).toBe('webp');
    });

    it('falls back to "other" for anything unrecognized', () => {
        expect(classifyExt('.txt')).toBe('other');
        expect(classifyExt('')).toBe('other');
        // note: classification is case-sensitive; callers lowercase before calling
        expect(classifyExt('.PNG')).toBe('other');
    });
});

describe('formatBytes', () => {
    it('formats bytes under 1 KB as plain bytes', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1023)).toBe('1023 B');
    });

    it('formats kilobytes with one decimal place', () => {
        expect(formatBytes(1024)).toBe('1.0 KB');
        expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('formats megabytes with one decimal place', () => {
        expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
        expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    });
});

describe('stateKey', () => {
    it('produces a path relative to the user directory', () => {
        const userDir = path.join('data', 'alice');
        const file = path.join('data', 'alice', 'characters', 'bob.png');
        expect(stateKey(file, userDir)).toBe(path.join('characters', 'bob.png'));
    });
});
