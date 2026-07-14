import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    {
        // Build output, deps, and coverage are never linted.
        ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'out/**'],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // Plain JS/CJS config files (webpack.config.js, etc.) legitimately use require().
        files: ['**/*.{js,cjs}'],
        languageOptions: {
            globals: { ...globals.node },
        },
        rules: {
            '@typescript-eslint/no-require-imports': 'off',
        },
    },
    {
        files: ['src/**/*.ts', 'test/**/*.ts'],
        languageOptions: {
            globals: { ...globals.node },
        },
        rules: {
            // The code intentionally uses `any` at the express / fs / native-binary
            // boundaries, so flag it as a warning rather than failing the build.
            '@typescript-eslint/no-explicit-any': 'warn',
            // Allow intentionally-unused args/vars when prefixed with an underscore.
            '@typescript-eslint/no-unused-vars': [
                'warn',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
);
