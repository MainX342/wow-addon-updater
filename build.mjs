import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';

const CF_API_KEY = process.env.CF_API_KEY;
if (!CF_API_KEY) {
    console.error('CRITICAL: CF_API_KEY is not defined!');
    process.exit(1);
}

const CF_MOD_IDS = [
    1361299, 1343483, 2382, 1418323, 1477613, 1441094, 4383,
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

for (const modId of CF_MOD_IDS) {
    console.log(`[CF] Fetching metadata for mod ${modId}...`);

    const metaRes = await fetch(`https://api.curseforge.com/v1/mods/${modId}/files?pageSize=20`, {
        headers: { 'x-api-key': CF_API_KEY }
    });

    if (!metaRes.ok) {
        console.error(`[CF] Error fetching mod ${modId}: ${metaRes.status} ${metaRes.statusText}`);
        continue;
    }

    const { data: files } = await metaRes.json();
    if (!files || files.length === 0) {
        console.warn(`[CF] No files found for mod ${modId}`);
        continue;
    }

    const sortedFiles = files.sort((a, b) => {
        if (a.releaseType !== b.releaseType) return a.releaseType - b.releaseType;
        return new Date(b.fileDate) - new Date(a.fileDate);
    });

    const targetFile = sortedFiles[0];
    let downloadUrl = targetFile.downloadUrl;

    if (!downloadUrl) {
        console.log(`[CF] Direct downloadUrl is null for file ${targetFile.id}, requesting download URL...`);
        const urlRes = await fetch(`https://api.curseforge.com/v1/mods/${modId}/files/${targetFile.id}/download-url`, {
            headers: { 'x-api-key': CF_API_KEY }
        });
        if (urlRes.ok) {
            const urlData = await urlRes.json();
            downloadUrl = urlData.data;
        }
    }

    if (!downloadUrl) {
        console.error(`[CF] FAILED to get download URL for mod ${modId} (File: ${targetFile.fileName})`);
        continue;
    }

    const safeName = targetFile.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(WORK_DIR, `cf_${modId}_${safeName}`);

    console.log(`[CF] Downloading ${targetFile.fileName}...`);
    await downloadFile(downloadUrl, filePath, { 'x-api-key': CF_API_KEY });

    const zip = new AdmZip(filePath);
    zip.extractAllTo(EXTRACT_DIR, true);
    console.log(`[CF] Extracted ${targetFile.fileName} successfully.`);
}

console.log('[GH] Fetching latest release for m33shoq/M33kAuras...');
const ghRes = await fetch('https://api.github.com/repos/m33shoq/M33kAuras/releases/latest', {
    headers: {
        'User-Agent': 'WoW-Addon-Sync-Agent',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
    }
});

if (ghRes.ok) {
    const release = await ghRes.json();
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

console.log('[ZIP] Packing addons bundle...');
const bundleZip = new AdmZip();
bundleZip.addLocalFolder(EXTRACT_DIR);
bundleZip.writeZip(OUTPUT_ZIP);
console.log(`[DONE] Created ${OUTPUT_ZIP}`);