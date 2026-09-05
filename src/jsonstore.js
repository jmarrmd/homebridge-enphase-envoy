/**
 * jsonstore.js
 *
 * Small JSON files that must survive a crash intact.
 *
 * Both stores here hold counters a controller treats as monotonic, so a
 * half-written file is worse than no file: it fails to parse on the next
 * start, the counters silently restart at zero, and the controller sees them
 * go backwards with no way to tell that from a fault. Writes therefore go to a
 * temporary file and are renamed over the real one, which is atomic within a
 * filesystem, and a failed load is reported rather than swallowed.
 */

import { promises as fsPromises } from 'fs';

/**
 * Read and parse a JSON file.
 *
 * @returns {Promise<{status: 'ok'|'absent'|'unreadable', data: object|null, error: string|null}>}
 *   'absent' is an ordinary first run; 'unreadable' means a file existed but
 *   could not be used, which is worth surfacing.
 */
export async function readJsonFile(file) {
    let raw;
    try {
        raw = await fsPromises.readFile(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return { status: 'absent', data: null, error: null };
        return { status: 'unreadable', data: null, error: error.message ?? String(error) };
    }

    try {
        return { status: 'ok', data: JSON.parse(raw), error: null };
    } catch (error) {
        return { status: 'unreadable', data: null, error: error.message ?? String(error) };
    }
}

/**
 * Write JSON through a temporary file and rename it into place.
 *
 * @returns {Promise<string|null>} an error message if the write failed
 */
export async function writeJsonFileAtomic(file, data) {
    const temp = `${file}.tmp`;
    try {
        await fsPromises.writeFile(temp, JSON.stringify(data, null, 2));
        await fsPromises.rename(temp, file);
        return null;
    } catch (error) {
        await fsPromises.rm(temp, { force: true }).catch(() => {});
        return error.message ?? String(error);
    }
}
