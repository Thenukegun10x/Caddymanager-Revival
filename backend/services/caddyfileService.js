/* 
This is a caddyfile service module responsible for importing, managing and manipulating mounted Caddyfiles, 
without having to interact with the Caddy API directly.
*/
const fs = require('fs');
const path = require('path');

/**
 * Parse environment variables that define mounted Caddyfiles.
 * Expected env var names: CADDYFILE_<ID>_PATH and optionally CADDYFILE_<ID>_LABEL
 * Returns an array of objects: { id, path, label, absolutePath, exists }
 */
function parseMountedCaddyfilesFromEnv() {
	const entries = Object.keys(process.env || {});
	const groupRegex = /^CADDYFILE_(.+?)_(PATH|LABEL)$/;
	const groups = {};

	entries.forEach((key) => {
		const m = key.match(groupRegex);
		if (!m) return;
		const id = m[1];
		const kind = m[2];
		groups[id] = groups[id] || {};
		if (kind === 'PATH') groups[id].path = process.env[key];
		if (kind === 'LABEL') groups[id].label = process.env[key];
	});

	// Resolve to absolute paths relative to the app entry (`app.js`).
	if (!(require.main && require.main.filename)) {
		throw new Error('Cannot resolve CADDYFILE paths: application entry (require.main.filename) is not available. Start the app via its entrypoint (e.g. `node app.js`).');
	}
	const appEntry = require.main.filename;
	const backendDir = path.dirname(appEntry);

	return Object.keys(groups).map((id) => {
		const entry = groups[id];
		const rawPath = entry.path || null;
		const abs = rawPath
			? path.isAbsolute(rawPath)
				? rawPath
				: path.resolve(backendDir, rawPath)
			: null;
		const exists = abs ? fs.existsSync(abs) : false;
		return {
			id,
			path: rawPath,
			label: entry.label || null,
			absolutePath: abs,
			exists,
		};
	});
}

/**
 * Return all mounted caddyfiles discovered from environment variables.
 */
function getMountedCaddyfiles() {
	return parseMountedCaddyfilesFromEnv();
}

/**
 * Find a mounted caddyfile by its ID.
 */
function getMountedCaddyfileById(id) {
	if (!id) return null;
	const list = parseMountedCaddyfilesFromEnv();
	return list.find((e) => e.id === id) || null;
}

/**
 * Read the content of a mounted caddyfile by ID. Throws if not found or unreadable.
 */
function readMountedCaddyfileContent(id, encoding = 'utf8') {
	const entry = getMountedCaddyfileById(id);
	if (!entry) throw new Error(`Caddyfile with id "${id}" not configured in environment`);
	if (!entry.absolutePath) throw new Error(`Caddyfile path for id "${id}" is empty`);
	if (!entry.exists) throw new Error(`Caddyfile not found at path: ${entry.absolutePath}`);
	return fs.readFileSync(entry.absolutePath, { encoding });
}

/**
 * Validate that all env-specified mounted caddyfiles exist on disk.
 * Returns an object: { allExist: boolean, missing: [ {id, path, exists} ], checked: [entries] }
 */
function validateMountedCaddyfiles() {
	const list = parseMountedCaddyfilesFromEnv();
	const missing = list
		.filter(e => !(e.absolutePath && e.exists))
		.map(e => ({ id: e.id, path: e.absolutePath, exists: e.exists }));

	return {
		allExist: missing.length === 0,
		missing,
		checked: list
	};
}

module.exports = {
	getMountedCaddyfiles,
	getMountedCaddyfileById,
	readMountedCaddyfileContent,
	validateMountedCaddyfiles,
};

