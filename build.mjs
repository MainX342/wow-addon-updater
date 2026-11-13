import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';

const CF_API_KEY = process.env.CF_API_KEY;
if (!CF_API_KEY) {
    console.error('CRITICAL: CF_API_KEY is not defined!');
    process.exit(1);
}

const COMMON_MOD_IDS = [1361299, 1343483, 2382, 1418323, 1477613, 4383];
const BUNDLES = [
    {
        name: 'Retail',
        versionTypeId: 517,
        modIds: [...COMMON_MOD_IDS, 1441094],
        output: 'addons-bundle.zip',
        includeM33: true,
    },
    {
        name: 'Forever',
        versionTypeId: 88568,
        modIds: [...COMMON_MOD_IDS, 1707971],
        output: 'addons-bundle-forever.zip',
    },
];

const CF_HEADERS = { 'x-api-key': CF_API_KEY };
const GH_HEADERS = { 'User-Agent': 'WoW-Addon-Sync-Agent' };
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wow-addon-updater-'));
const cfDownloads = new Map();

async function downloadFile(url, destPath, headers = {}) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    await pipeline(res.body, fs.createWriteStream(destPath));
}

async function getCurseForgeArchive(modId, bundle) {
    const api = `https://api.curseforge.com/v1/mods/${modId}/files`;
    const metaRes = await fetch(`${api}?pageSize=20&gameVersionTypeId=${bundle.versionTypeId}`, {
        headers: CF_HEADERS,
    });
    if (!metaRes.ok) {
        throw new Error(`[CF] ${bundle.name} mod ${modId}: ${metaRes.status} ${metaRes.statusText}`);
    }

    const { data: files } = await metaRes.json();
    const targetFile = files?.sort((a, b) =>
        a.releaseType - b.releaseType || Date.parse(b.fileDate) - Date.parse(a.fileDate)
    )[0];
    if (!targetFile) throw new Error(`[CF] No ${bundle.name} files found for mod ${modId}`);

    console.log(`[CF] ${bundle.name}: ${targetFile.fileName}`);
    if (cfDownloads.has(targetFile.id)) return cfDownloads.get(targetFile.id);

    let downloadUrl = targetFile.downloadUrl;
    if (!downloadUrl) {
        const urlRes = await fetch(`${api}/${targetFile.id}/download-url`, { headers: CF_HEADERS });
        if (urlRes.ok) downloadUrl = (await urlRes.json()).data;
    }
    if (!downloadUrl) {
        const part1 = Math.floor(targetFile.id / 1000);
        const part2 = targetFile.id % 1000;
        downloadUrl = `https://edge.forgecdn.net/files/${part1}/${part2}/${encodeURIComponent(targetFile.fileName)}`;
    }

    const filePath = path.join(WORK_DIR, `cf-${targetFile.id}.zip`);
    await downloadFile(downloadUrl, filePath);
    cfDownloads.set(targetFile.id, filePath);
    return filePath;
}

async function getM33Archive() {
    const headers = {
        ...GH_HEADERS,
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    };
    const releaseRes = await fetch('https://api.github.com/repos/m33shoq/M33kAuras/releases/latest', { headers });
    if (!releaseRes.ok) {
        throw new Error(`[GH] M33kAuras: ${releaseRes.status} ${releaseRes.statusText}`);
    }
    const release = await releaseRes.json();
    const asset = release.assets?.find(a => a.name.endsWith('.zip'));
    if (!asset) throw new Error('[GH] No installable ZIP found for M33kAuras');

    const filePath = path.join(WORK_DIR, 'M33kAuras.zip');
    console.log(`[GH] Retail: ${asset.name}`);
    await downloadFile(asset.browser_download_url, filePath, GH_HEADERS);
    return filePath;
}

try {
    for (const bundle of BUNDLES) {
        const extractDir = path.join(WORK_DIR, bundle.name);
        fs.mkdirSync(extractDir);

        for (const modId of bundle.modIds) {
            const archive = await getCurseForgeArchive(modId, bundle);
            new AdmZip(archive).extractAllTo(extractDir, true);
        }
        if (bundle.includeM33) {
            const archive = await getM33Archive();
            new AdmZip(archive).extractAllTo(extractDir, true);
        }

        const output = new AdmZip();
        output.addLocalFolder(extractDir);
        output.writeZip(bundle.output);
        console.log(`[ZIP] Created ${bundle.output}`);
    }
} finally {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
}
