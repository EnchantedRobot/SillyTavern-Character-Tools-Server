# Development

The committed `dist/plugin.js` is what SillyTavern loads at runtime, so end users never build. To work on the plugin itself:

```bash
git clone https://github.com/EnchantedRobot/SillyTavern-Character-Tools-Server
cd SillyTavern-Character-Tools-Server
npm install
```

## Building

```bash
npm run build:dev   # debug build
npm run build       # production build
```

## Testing

```bash
npm test
```

Source lives in `src/` (`index.ts` routes + orchestration, `cardRepair.ts`, `tagMerge.ts`, `transforms.ts`) and is bundled to `dist/plugin.js` with webpack.
