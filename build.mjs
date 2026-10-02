import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';

const CF_API_KEY = process.env.CF_API_KEY;
if (!CF_API_KEY) {
    console.error('CRITICAL: CF_API_KEY is not defined!');
    process.exit(1);
}

// Список CurseForge Mod ID (числовые ID проектов)
// ID можно взять на странице аддона на CurseForge в блоке About Project -> Project ID
const CF_MOD_IDS = [
    // Пример: 3358 (Details!), 24542 (Deadly Boss Mods), 1888 (Bagnon) и т.д.
    // Замени на свои:
    3358,
];

const WORK_DIR = path.resolve('temp_downloads');
const EXTRACT_DIR = path.resolve('temp_extracted');
const OUTPUT_ZIP = path.resolve('addons-bundle.zip');

fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(EXTRACT_DIR, { recursive: true });

async function downloadFile(url, destPath, headers = {}) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    await pipeline(res.body, fs.createWriteStream(destPath));
}

// 1. CurseForge Addons
for (const modId of CF_MOD_IDS) {
    console.log(`[CF] Fetching metadata for mod ${modId}...`);
    // Эндпоинт v1 Core API CurseForge
    const metaRes = await fetch(`https://api.curseforge.com/v1/mods/${modId}/files`, {
        headers: { 'x-api-key': CF_API_KEY }
    });
    if (!metaRes.ok) {
        console.error(`[CF] Error fetching mod ${modId}: ${metaRes.statusText}`);
        continue;
    }
    const { data: files } = await metaRes.json();
    // Берём самый свежий релизный файл (releaseType 1 = release, 2 = beta, 3 = alpha)
    const latestFile = files.sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate))[0];
    if (!latestFile || !latestFile.downloadUrl) {
        console.warn(`[CF] No valid downloadUrl for ${modId}`);
        continue;
    }

    const filePath = path.join(WORK_DIR, `cf_${modId}_${latestFile.fileName}`);
    console.log(`[CF] Downloading ${latestFile.fileName}...`);

    // Согласно блогу: передаем x-api-key заголовок на CDN edge.forgecdn.net
    await downloadFile(latestFile.downloadUrl, filePath, { 'x-api-key': CF_API_KEY });

    const zip = new AdmZip(filePath);
    zip.extractAllTo(EXTRACT_DIR, true);
}

// 2. GitHub: m33shoq/M33kAuras (latest release)
console.log('[GH] Fetching latest release for m33shoq/M33kAuras...');
const ghRes = await fetch('https://api.github.com/repos/m33shoq/M33kAuras/releases/latest', {
    headers: {
        'User-Agent': 'WoW-Addon-Sync-Agent',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
});

if (ghRes.ok) {
    const release = await ghRes.json();
    // Ищем прикрепленный .zip в release assets, либо берем zipball_url
    const asset = release.assets?.find(a => a.name.endsWith('.zip'));
    const zipUrl = asset ? asset.browser_download_url : release.zipball_url;

    if (zipUrl) {
        const ghFilePath = path.join(WORK_DIR, 'M33kAuras.zip');
        console.log(`[GH] Downloading M33kAuras from ${zipUrl}...`);
        await downloadFile(zipUrl, ghFilePath, { 'User-Agent': 'WoW-Addon-Sync-Agent' });

        const zip = new AdmZip(ghFilePath);
        zip.extractAllTo(EXTRACT_DIR, true);
    }
} else {
    console.error(`[GH] Failed to fetch M33kAuras release: ${ghRes.statusText}`);
}

// 3. Формируем единый бандл
console.log('[ZIP] Packing addons bundle...');
const bundleZip = new AdmZip();
bundleZip.addLocalFolder(EXTRACT_DIR);
bundleZip.writeZip(OUTPUT_ZIP);
console.log(`[DONE] Created ${OUTPUT_ZIP}`);