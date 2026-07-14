import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // The plugin is server-side Node code (fs, sharp, pngquant-bin), so run
        // tests in a Node environment rather than a browser/jsdom one.
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
