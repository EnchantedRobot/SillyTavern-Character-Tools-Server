import { describe, it, expect } from 'vitest';
import { computeScaledDimensions } from '../src/transforms';

describe('computeScaledDimensions', () => {
    it('returns null when the image already fits within maxDimension', () => {
        expect(computeScaledDimensions(2048, 1024, 2048, 512)).toBeNull();
        expect(computeScaledDimensions(800, 600, 2048, 512)).toBeNull();
    });

    it('returns null when maxDimension is disabled (<= 0)', () => {
        expect(computeScaledDimensions(5000, 5000, 0, 512)).toBeNull();
    });

    it('scales the longest edge down to maxDimension', () => {
        // 4096x2048 capped at 2048 -> scale 0.5
        expect(computeScaledDimensions(4096, 2048, 2048, 0)).toEqual({ newW: 2048, newH: 1024 });
    });

    it('scales a portrait image by its longest (height) edge', () => {
        expect(computeScaledDimensions(2048, 4096, 2048, 0)).toEqual({ newW: 1024, newH: 2048 });
    });

    it('does not let the shortest edge fall below minDimension', () => {
        // 4000x600 capped at 2048 would scale to 0.512 -> short edge ~307 (< 512).
        // The min-cap bumps scale to 512/600 = 0.8533 so the short edge lands on 512.
        const result = computeScaledDimensions(4000, 600, 2048, 512);
        expect(result).not.toBeNull();
        expect(result!.newH).toBe(512); // short edge pinned to the minimum
        expect(result!.newW).toBe(3413); // long edge follows the min-driven scale
    });

    it('returns null if honoring minDimension would require upscaling (scale >= 1)', () => {
        // 3000x300 capped at 2048 scales the short edge to ~205; the min-cap would
        // then demand scale 512/300 = 1.7 (upscaling), which must be rejected.
        expect(computeScaledDimensions(3000, 300, 2048, 512)).toBeNull();
    });

    it('rounds fractional dimensions to the nearest integer', () => {
        // 3000x2000 capped at 2048 -> scale 0.682666..., height 1365.33 -> 1365
        const result = computeScaledDimensions(3000, 2000, 2048, 0);
        expect(result).toEqual({ newW: 2048, newH: 1365 });
    });
});
