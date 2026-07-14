import bodyParser from 'body-parser';
import { Router } from 'express';
import { Chalk } from 'chalk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import {
    ImageKind,
    Chunk,
    extractTextChunks,
    injectTextChunks,
    classifyExt,
    computeScaledDimensions,
    formatBytes,
    stateKey,
} from './transforms';
import { repairCardChunks } from './cardRepair';
import { dictionaryHash, type TagDictionary } from './tagMerge';

const execFileAsync = promisify(execFile);
// pngquant-bin is a CommonJS module exporting the binary path; require keeps the interop simple
// eslint-disable-next-line @typescript-eslint/no-require-imports
const _pngquantModule = require('pngquant-bin');
const pngquantBin: string = _pngquantModule?.default ?? _pngquantModule;

const chalk = new Chalk();
const MODULE_NAME = '[SillyTavern-Character-Tools]';

interface PluginInfo {
    id: string;
    name: string;
    description: string;
}

interface Plugin {
    init: (router: Router) => Promise<void>;
    exit: () => Promise<void>;
    info: PluginInfo;
}

interface CompressionResult {
    filesScanned: number;
    filesSkipped: number;
    filesCompressed: number;
    /** Character cards whose embedded JSON was upgraded/repaired (character flow only). */
    cardsRepaired: number;
    /** Character cards whose tags were rewritten by the dictionary (character flow only). */
    tagsChanged: number;
    bytesSaved: number;
    errors: string[];
}

function emptyResult(filesScanned: number): CompressionResult {
    return {
        filesScanned,
        filesSkipped: 0,
        filesCompressed: 0,
        cardsRepaired: 0,
        tagsChanged: 0,
        bytesSaved: 0,
        errors: [],
    };
}

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------

const STATE_FILENAME = '.compress_state.json';
// Character repair tracks its own state so a card already touched by the image
// compressor isn't pre-skipped before it can be upgraded/repaired.
const REPAIR_STATE_FILENAME = '.repair_state.json';
const STATE_SAVE_INTERVAL = 500;

type State = Record<string, { size: number }>;

function loadState(stateFile: string): State {
    try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
    } catch {
        return {};
    }
}

function saveState(stateFile: string, state: State): void {
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// The character state additionally records the dictionary hash it was built
// under, so a dictionary edit invalidates the size-skips (see runCharacterUpgrade).
interface CharacterState {
    dictHash: string | null;
    files: State;
}

function loadCharacterState(stateFile: string): CharacterState {
    try {
        const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object') {
            return { dictHash: typeof raw.dictHash === 'string' ? raw.dictHash : null, files: raw.files as State };
        }
        // Legacy flat shape ({ "relpath": { size } }) from before dict tracking.
        return { dictHash: null, files: (raw && typeof raw === 'object' ? raw : {}) as State };
    } catch {
        return { dictHash: null, files: {} };
    }
}

function saveCharacterState(stateFile: string, dictHash: string, files: State): void {
    fs.writeFileSync(stateFile, JSON.stringify({ dictHash, files }, null, 2));
}

function alreadyProcessed(filePath: string, userDir: string, state: State): boolean {
    const entry = state[stateKey(filePath, userDir)];
    if (!entry) return false;
    try {
        return entry.size === fs.statSync(filePath).size;
    } catch {
        return false;
    }
}

function recordProcessed(filePath: string, userDir: string, state: State): void {
    try {
        state[stateKey(filePath, userDir)] = { size: fs.statSync(filePath).size };
    } catch {
        // file may have been removed; skip recording
    }
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

async function collectFiles(root: string): Promise<{ pngs: string[]; jpgs: string[]; webps: string[] }> {
    const pngs: string[] = [];
    const jpgs: string[] = [];
    const webps: string[] = [];
    const PNG_EXTS = new Set(['.png']);
    const JPG_EXTS = new Set(['.jpg', '.jpeg']);
    const WEBP_EXTS = new Set(['.webp']);

    async function walk(dir: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (PNG_EXTS.has(ext)) pngs.push(fullPath);
                else if (JPG_EXTS.has(ext)) jpgs.push(fullPath);
                else if (WEBP_EXTS.has(ext)) webps.push(fullPath);
            }
        }
    }

    await walk(root);
    return { pngs, jpgs, webps };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface TypeStat {
    count: number;
    bytes: number;
}

interface DirStats {
    totalFiles: number;
    totalBytes: number;
    byType: Record<ImageKind, TypeStat>;
}

function emptyDirStats(): DirStats {
    return {
        totalFiles: 0,
        totalBytes: 0,
        byType: {
            png: { count: 0, bytes: 0 },
            jpg: { count: 0, bytes: 0 },
            gif: { count: 0, bytes: 0 },
            webp: { count: 0, bytes: 0 },
            other: { count: 0, bytes: 0 },
        },
    };
}

async function collectDirStats(root: string): Promise<DirStats> {
    const stats = emptyDirStats();
    if (!fs.existsSync(root)) return stats;

    async function walk(dir: string): Promise<void> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(fullPath);
            } else if (entry.isFile()) {
                if (entry.name === STATE_FILENAME) continue;
                let size: number;
                try {
                    size = (await fs.promises.stat(fullPath)).size;
                } catch {
                    continue;
                }
                const kind = classifyExt(path.extname(entry.name).toLowerCase());
                stats.byType[kind].count++;
                stats.byType[kind].bytes += size;
                stats.totalFiles++;
                stats.totalBytes += size;
            }
        }
    }

    await walk(root);
    return stats;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

function tmpPath(suffix: string): string {
    return path.join(os.tmpdir(), `st-chartools-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
}

const WEBP_QUALITY = 90;
const WEBP_EFFORT = 6;

/**
 * Tries converting a PNG/JPG to WEBP in place (same basename, .webp extension).
 * Overwrites any stale .webp at the destination — that only happens when the
 * source was freshly (re)downloaded as PNG/JPG, which we treat as the newer copy.
 * Returns true if the conversion happened (caller should skip further compression).
 */
async function tryConvertToWebp(
    filePath: string,
    maxDimension: number,
    minDimension: number,
    result: CompressionResult,
): Promise<boolean> {
    const originalData = await fs.promises.readFile(filePath);
    const originalSize = originalData.length;

    const meta = await sharp(originalData).metadata();
    let pipeline = sharp(originalData);
    const dims = computeScaledDimensions(meta.width ?? 0, meta.height ?? 0, maxDimension, minDimension);
    if (dims) {
        pipeline = pipeline.resize(dims.newW, dims.newH, { kernel: 'lanczos3' });
    }

    const webpData = await pipeline.webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT }).toBuffer();
    // when we downscaled, accept even if the byte count didn't shrink — the smaller
    // dimensions are the win; otherwise only convert if WEBP is actually smaller
    if (!dims && webpData.length >= originalSize) return false;

    const destPath = path.join(path.dirname(filePath), `${path.parse(filePath).name}.webp`);
    await fs.promises.writeFile(destPath, webpData);
    await fs.promises.unlink(filePath);

    result.filesCompressed++;
    result.bytesSaved += originalSize - webpData.length;
    console.log(chalk.green(MODULE_NAME), `WEBP ${path.basename(filePath)} -> ${path.basename(destPath)}: ${formatBytes(originalSize)} -> ${formatBytes(webpData.length)}`);
    return true;
}

/**
 * Resize (if oversized) and quantize a PNG's pixel data, returning the best
 * image-only bytes (text chunks stripped by sharp/pngquant). `resized` reports
 * whether we downscaled; `imageBytes` is null when neither resize nor pngquant
 * produced usable output (i.e. leave the original pixels untouched). Callers own
 * text-chunk handling and the decision to write.
 */
async function optimizePngImage(
    filePath: string,
    originalData: Buffer,
    maxDimension: number,
    minDimension: number,
): Promise<{ imageBytes: Buffer | null; resized: boolean }> {
    let tmpResized: string | null = null;
    let tmpOut: string | null = null;

    try {
        let pngquantInput = filePath;
        let resized = false;

        const meta = await sharp(originalData).metadata();
        const dims = computeScaledDimensions(meta.width ?? 0, meta.height ?? 0, maxDimension, minDimension);
        if (dims) {
            const resizedBuf = await sharp(originalData)
                .resize(dims.newW, dims.newH, { kernel: 'lanczos3' })
                .png()
                .toBuffer();
            tmpResized = tmpPath('.png');
            await fs.promises.writeFile(tmpResized, resizedBuf);
            pngquantInput = tmpResized;
            resized = true;
        }

        tmpOut = tmpPath('.png');

        let pngquantSucceeded = false;
        try {
            await execFileAsync(pngquantBin, ['--force', '--skip-if-larger', '--output', tmpOut, '--', pngquantInput]);
            pngquantSucceeded = true;
        } catch (err: any) {
            // exit code 98 means pngquant skipped because output would be larger — not an error
            if (err.code !== 98) throw err;
        }

        let candidatePath: string | null = null;
        if (pngquantSucceeded && fs.existsSync(tmpOut) && fs.statSync(tmpOut).size > 0) {
            candidatePath = tmpOut;
        } else if (tmpResized) {
            // pngquant skipped but we still have the resized version to keep
            candidatePath = tmpResized;
        }

        const imageBytes = candidatePath ? await fs.promises.readFile(candidatePath) : null;
        return { imageBytes, resized };
    } finally {
        if (tmpResized) await fs.promises.unlink(tmpResized).catch(() => {});
        if (tmpOut) await fs.promises.unlink(tmpOut).catch(() => {});
    }
}

async function compressPng(
    filePath: string,
    preserveMetadata: boolean,
    maxDimension: number,
    minDimension: number,
    result: CompressionResult,
): Promise<void> {
    const originalData = await fs.promises.readFile(filePath);
    const originalSize = originalData.length;
    const textChunks = preserveMetadata ? extractTextChunks(originalData) : [];

    const { imageBytes, resized } = await optimizePngImage(filePath, originalData, maxDimension, minDimension);
    if (!imageBytes) return;

    const candidateData = textChunks.length > 0 ? injectTextChunks(imageBytes, textChunks) : imageBytes;

    const newSize = candidateData.length;
    if (newSize < originalSize || resized) {
        await fs.promises.writeFile(filePath, candidateData);
        const saved = originalSize - newSize;
        result.filesCompressed++;
        if (saved > 0) {
            result.bytesSaved += saved;
            console.log(chalk.green(MODULE_NAME), `PNG  ${path.basename(filePath)}: ${formatBytes(originalSize)} -> ${formatBytes(newSize)}`);
        }
    }
}

/**
 * Character-card flow: repair/upgrade the embedded card JSON to V3 and compress
 * the image in one pass. Unlike plain compression, this writes whenever the card
 * changed — even if the image can't shrink — so the repair is never lost. The
 * repaired (or, if unchanged, original) text chunks are always re-injected,
 * since recompressing the pixels strips them.
 */
async function repairAndCompressCharacter(
    filePath: string,
    maxDimension: number,
    minDimension: number,
    result: CompressionResult,
    dictionary?: TagDictionary,
): Promise<void> {
    const originalData = await fs.promises.readFile(filePath);
    const originalSize = originalData.length;

    const textChunks = extractTextChunks(originalData);
    const repair = repairCardChunks(textChunks, dictionary);

    const { imageBytes, resized } = await optimizePngImage(filePath, originalData, maxDimension, minDimension);
    const baseImage = imageBytes ?? originalData;

    // Always carry the card metadata across the (re)compression.
    const finalChunks: Chunk[] = repair.found ? repair.chunks : textChunks;
    const candidateData = injectTextChunks(baseImage, finalChunks);
    const newSize = candidateData.length;

    const imageShrank = imageBytes !== null && newSize < originalSize;
    if (!repair.changed && !imageShrank && !resized) return; // nothing to do

    await fs.promises.writeFile(filePath, candidateData);

    if (repair.repaired) result.cardsRepaired++;
    if (repair.tagsChanged) result.tagsChanged++;
    if (repair.changed) {
        console.log(chalk.green(MODULE_NAME), `CARD ${path.basename(filePath)}: ${repair.changes.join('; ')}`);
    }
    const saved = originalSize - newSize;
    if (imageShrank || resized) {
        result.filesCompressed++;
        if (saved > 0) {
            result.bytesSaved += saved;
            console.log(chalk.green(MODULE_NAME), `PNG  ${path.basename(filePath)}: ${formatBytes(originalSize)} -> ${formatBytes(newSize)}`);
        }
    }
}

async function compressJpg(
    filePath: string,
    quality: number,
    maxDimension: number,
    minDimension: number,
    result: CompressionResult,
): Promise<void> {
    const originalData = await fs.promises.readFile(filePath);
    const originalSize = originalData.length;

    const meta = await sharp(originalData).metadata();
    let pipeline = sharp(originalData);

    const dims = computeScaledDimensions(meta.width ?? 0, meta.height ?? 0, maxDimension, minDimension);
    if (dims) {
        pipeline = pipeline.resize(dims.newW, dims.newH, { kernel: 'lanczos3' });
    }

    const compressed = await pipeline.jpeg({ quality, mozjpeg: true, progressive: true }).toBuffer();
    if (compressed.length < originalSize) {
        await fs.promises.writeFile(filePath, compressed);
        result.bytesSaved += originalSize - compressed.length;
        result.filesCompressed++;
        console.log(chalk.green(MODULE_NAME), `JPG  ${path.basename(filePath)}: ${formatBytes(originalSize)} -> ${formatBytes(compressed.length)}`);
    }
}

/**
 * Existing WEBP files are already in our target format, so we don't re-encode
 * for quality. We only touch them when they're oversized, downscaling to the
 * dimension caps (this also catches full-resolution WEBPs left by the earlier
 * conversion bug). Correctly-sized WEBPs are left untouched.
 */
async function compressWebp(
    filePath: string,
    maxDimension: number,
    minDimension: number,
    result: CompressionResult,
): Promise<void> {
    const originalData = await fs.promises.readFile(filePath);
    const originalSize = originalData.length;

    const meta = await sharp(originalData).metadata();
    const dims = computeScaledDimensions(meta.width ?? 0, meta.height ?? 0, maxDimension, minDimension);
    if (!dims) return; // not oversized — leave it alone

    const resized = await sharp(originalData)
        .resize(dims.newW, dims.newH, { kernel: 'lanczos3' })
        .webp({ quality: WEBP_QUALITY, effort: WEBP_EFFORT })
        .toBuffer();

    await fs.promises.writeFile(filePath, resized);
    result.filesCompressed++;
    const saved = originalSize - resized.length;
    if (saved > 0) result.bytesSaved += saved;
    console.log(chalk.green(MODULE_NAME), `WEBP ${path.basename(filePath)}: ${formatBytes(originalSize)} -> ${formatBytes(resized.length)} (resized to ${dims.newW}x${dims.newH})`);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const PROGRESS_INTERVAL = 1; // send a progress update after every file

interface FileTask {
    filePath: string;
    type: 'png' | 'jpg' | 'webp';
    preserveMetadata: boolean;
    maxDim: number;
    minDim: number;
    allowWebp: boolean;
    // Character cards: upgrade/repair the embedded JSON alongside compression.
    repair: boolean;
}

type ProgressSender = (current: number, total: number) => void;

const IMAGES_SUBDIR = ['user', 'images'];
const CHARACTERS_SUBDIR = ['characters'];
const DEFAULT_MAX_DIM = 2048;
const DEFAULT_MIN_DIM = 512;

function resolveUserDir(user: string): { userDir: string; status: number; error?: string } {
    if (!user || user.includes('..') || path.isAbsolute(user)) {
        return { userDir: '', status: 400, error: 'Invalid user value' };
    }
    const userDir = path.join(process.cwd(), 'data', user);
    if (!fs.existsSync(userDir)) {
        return { userDir: '', status: 404, error: `User directory not found: data/${user}` };
    }
    return { userDir, status: 200 };
}

/**
 * Pull an optional tag dictionary out of a request body. Returns undefined when
 * absent or empty, so the character pass runs as repair-only. Shapes are
 * validated defensively since this comes straight off the wire.
 */
function parseDictionary(body: unknown): TagDictionary | undefined {
    const d = (body as { dictionary?: unknown })?.dictionary;
    if (!d || typeof d !== 'object') return undefined;
    const src = d as { mapping?: unknown; removedTags?: unknown };

    const mapping: Record<string, string[]> = {};
    if (src.mapping && typeof src.mapping === 'object') {
        for (const [canonical, variants] of Object.entries(src.mapping as Record<string, unknown>)) {
            if (Array.isArray(variants)) {
                mapping[canonical] = variants.filter((v): v is string => typeof v === 'string');
            }
        }
    }
    const removedTags = Array.isArray(src.removedTags)
        ? src.removedTags.filter((t): t is string => typeof t === 'string')
        : [];

    if (Object.keys(mapping).length === 0 && removedTags.length === 0) return undefined;
    return { mapping, removedTags };
}

async function collectTasks(
    dir: string,
    opts: { preserveMetadata: boolean; allowWebp: boolean; repair: boolean },
): Promise<FileTask[]> {
    if (!fs.existsSync(dir)) {
        console.log(chalk.yellow(MODULE_NAME), `Skipping missing directory: ${dir}`);
        return [];
    }
    const base = { maxDim: DEFAULT_MAX_DIM, minDim: DEFAULT_MIN_DIM, ...opts };
    const { pngs, jpgs, webps } = await collectFiles(dir);
    return [
        ...pngs.map((f): FileTask => ({ filePath: f, type: 'png', ...base })),
        ...jpgs.map((f): FileTask => ({ filePath: f, type: 'jpg', ...base })),
        ...webps.map((f): FileTask => ({ filePath: f, type: 'webp', ...base })),
    ];
}

/** `user/images/` — plain compression with WEBP conversion, no metadata to keep. */
function buildImageTaskList(userDir: string): Promise<FileTask[]> {
    return collectTasks(path.join(userDir, ...IMAGES_SUBDIR), {
        preserveMetadata: false,
        allowWebp: true,
        repair: false,
    });
}

/**
 * `characters/` — cards embed their JSON in PNG text chunks (which WEBP has no
 * equivalent for), so we never convert to WEBP; PNGs are repaired/upgraded and
 * their metadata preserved.
 */
function buildCharacterTaskList(userDir: string): Promise<FileTask[]> {
    return collectTasks(path.join(userDir, ...CHARACTERS_SUBDIR), {
        preserveMetadata: true,
        allowWebp: false,
        repair: true,
    });
}

async function processTask(task: FileTask, result: CompressionResult, dictionary?: TagDictionary): Promise<void> {
    if (task.type === 'webp') {
        await compressWebp(task.filePath, task.maxDim, task.minDim, result);
        return;
    }
    if (task.repair && task.type === 'png') {
        await repairAndCompressCharacter(task.filePath, task.maxDim, task.minDim, result, dictionary);
        return;
    }
    const converted = task.allowWebp && (await tryConvertToWebp(task.filePath, task.maxDim, task.minDim, result));
    if (converted) return;
    if (task.type === 'png') {
        await compressPng(task.filePath, task.preserveMetadata, task.maxDim, task.minDim, result);
    } else {
        await compressJpg(task.filePath, 75, task.maxDim, task.minDim, result);
    }
}

async function runTasks(
    userDir: string,
    files: State,
    persist: () => void,
    tasks: FileTask[],
    onProgress?: ProgressSender,
    dictionary?: TagDictionary,
): Promise<CompressionResult> {
    const total = tasks.length;
    const result = emptyResult(total);

    let current = 0;
    let stateSaveCounter = 0;

    for (const task of tasks) {
        current++;

        if (alreadyProcessed(task.filePath, userDir, files)) {
            result.filesSkipped++;
        } else {
            try {
                await processTask(task, result, dictionary);
            } catch (err) {
                const msg = `${task.type.toUpperCase()} error ${path.basename(task.filePath)}: ${err}`;
                result.errors.push(msg);
                console.error(chalk.red(MODULE_NAME), msg);
            }
            recordProcessed(task.filePath, userDir, files);
            stateSaveCounter++;
            if (stateSaveCounter % STATE_SAVE_INTERVAL === 0) {
                persist();
            }
        }

        if (current % PROGRESS_INTERVAL === 0 || current === total) {
            onProgress?.(current, total);
        }
    }

    persist();

    console.log(
        chalk.green(MODULE_NAME),
        `Done — scanned: ${result.filesScanned}, skipped: ${result.filesSkipped}, compressed: ${result.filesCompressed}, repaired: ${result.cardsRepaired}, tags: ${result.tagsChanged}, saved: ${formatBytes(result.bytesSaved)}`,
    );

    return result;
}

/** Compress `user/images/` only. */
async function runImageCompression(userDir: string, onProgress?: ProgressSender): Promise<CompressionResult> {
    const stateFile = path.join(userDir, STATE_FILENAME);
    const files = loadState(stateFile);
    return runTasks(userDir, files, () => saveState(stateFile, files), await buildImageTaskList(userDir), onProgress);
}

/**
 * Merge tags + repair + compress `characters/`. The dictionary is passed in by
 * the caller (extension-owned). Its hash is stored in the state file: if it
 * differs from the last run's, the size-skips are dropped so the changed
 * dictionary is re-applied to every card.
 */
async function runCharacterUpgrade(
    userDir: string,
    dictionary?: TagDictionary,
    onProgress?: ProgressSender,
): Promise<CompressionResult> {
    const stateFile = path.join(userDir, REPAIR_STATE_FILENAME);
    const hash = dictionaryHash(dictionary);
    const loaded = loadCharacterState(stateFile);
    const files = loaded.dictHash === hash ? loaded.files : {};
    if (loaded.dictHash !== hash && loaded.dictHash !== null) {
        console.log(chalk.yellow(MODULE_NAME), 'Tag dictionary changed — reprocessing all characters');
    }
    const persist = () => saveCharacterState(stateFile, hash, files);
    return runTasks(userDir, files, persist, await buildCharacterTaskList(userDir), onProgress, dictionary);
}

function startSse(res: import('express').Response): (data: object) => void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    return (data: object) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        // flush through any compression middleware that may be buffering the stream
        if (typeof (res as any).flush === 'function') {
            (res as any).flush();
        }
    };
}

export async function init(router: Router): Promise<void> {
    const jsonParser = bodyParser.json();

    router.post('/probe', (_req, res) => res.sendStatus(204));

    router.get('/users', async (_req, res) => {
        try {
            const dataDir = path.join(process.cwd(), 'data');
            const entries = await fs.promises.readdir(dataDir, { withFileTypes: true });
            const users = (await Promise.all(
                entries
                    .filter(e => e.isDirectory())
                    .map(async e => {
                        const hasSettings = await fs.promises.access(path.join(dataDir, e.name, 'settings.json')).then(() => true).catch(() => false);
                        return hasSettings ? e.name : null;
                    }),
            )).filter((name): name is string => name !== null).sort();
            return res.json({ users });
        } catch (err) {
            console.error(chalk.red(MODULE_NAME), 'Failed to list users', err);
            return res.status(500).json({ error: 'Could not read data directory' });
        }
    });

    router.post('/stats', jsonParser, async (req, res) => {
        const user = String(req.body?.user ?? '').trim();
        const { userDir, status, error } = resolveUserDir(user);
        if (error) return res.status(status).json({ error });

        const [images, characters] = await Promise.all([
            collectDirStats(path.join(userDir, 'user', 'images')),
            collectDirStats(path.join(userDir, 'characters')),
        ]);

        return res.json({ images, characters });
    });

    // Stream a compression/repair job to the client over SSE.
    async function streamJob(
        res: import('express').Response,
        run: (onProgress: ProgressSender) => Promise<CompressionResult>,
    ): Promise<void> {
        const send = startSse(res);
        const result = await run((current, total) => {
            send({ type: 'progress', current, total, percent: total > 0 ? Math.round((current / total) * 100) : 100 });
        });
        send({ type: 'complete', result });
        res.end();
    }

    async function clearState(userDir: string, filename: string, user: string): Promise<void> {
        try {
            await fs.promises.unlink(path.join(userDir, filename));
            console.log(chalk.yellow(MODULE_NAME), `Cleared ${filename} for user: ${user}`);
        } catch {
            // no state file yet — that's fine
        }
    }

    // Compress user/images/ only. Character cards are handled by /fix-characters.
    router.post('/compress', jsonParser, async (req, res) => {
        const user = String(req.body?.user ?? '').trim();
        const { userDir, status, error } = resolveUserDir(user);
        if (error) return res.status(status).json({ error });
        return streamJob(res, (onProgress) => runImageCompression(userDir, onProgress));
    });

    router.post('/reprocess-all', jsonParser, async (req, res) => {
        const user = String(req.body?.user ?? '').trim();
        const { userDir, status, error } = resolveUserDir(user);
        if (error) return res.status(status).json({ error });
        await clearState(userDir, STATE_FILENAME, user);
        return streamJob(res, (onProgress) => runImageCompression(userDir, onProgress));
    });

    // The combined character pass: merge tags (from the posted dictionary),
    // repair/upgrade the card (V2→V3, token fixes, backfill), and compress the
    // image — one decode/write per card. The dictionary is optional; without it
    // this is repair-only.
    router.post('/fix-characters', jsonParser, async (req, res) => {
        const user = String(req.body?.user ?? '').trim();
        const { userDir, status, error } = resolveUserDir(user);
        if (error) return res.status(status).json({ error });
        const dictionary = parseDictionary(req.body);
        return streamJob(res, (onProgress) => runCharacterUpgrade(userDir, dictionary, onProgress));
    });

    router.post('/reprocess-characters', jsonParser, async (req, res) => {
        const user = String(req.body?.user ?? '').trim();
        const { userDir, status, error } = resolveUserDir(user);
        if (error) return res.status(status).json({ error });
        const dictionary = parseDictionary(req.body);
        await clearState(userDir, REPAIR_STATE_FILENAME, user);
        return streamJob(res, (onProgress) => runCharacterUpgrade(userDir, dictionary, onProgress));
    });

    console.log(chalk.green(MODULE_NAME), 'Plugin loaded!');
}

export async function exit(): Promise<void> {
    console.log(chalk.yellow(MODULE_NAME), 'Plugin exited');
}

export const info: PluginInfo = {
    id: 'character-tools',
    name: 'Character Tools',
    description: 'Repair character cards and compress images in SillyTavern user directories.',
};

const plugin: Plugin = {
    init,
    exit,
    info,
};

export default plugin;
