#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");

const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB chunks

async function getTarData(base) {
	const countFile = `${base}.count`;
	if (!fs.existsSync(countFile)) throw new Error(`Not found: ${countFile}`);

	const count = parseInt(fs.readFileSync(countFile, "utf-8"));
	const chunks = [];
	for (let i = 0; i < count; i++) {
		const file = `${base}${String(i).padStart(2, "0")}`;
		if (!fs.existsSync(file)) throw new Error(`Not found: ${file}`);
		chunks.push(fs.readFileSync(file));
	}
	return Buffer.concat(chunks);
}

function extractTar(tar) {
	const files = [];
	let pos = 0;
	const dec = new TextDecoder();
	const str = (buf, o, n) => {
		let e = o;
		while (e < o + n && buf[e]) e++;
		return dec.decode(buf.subarray(o, e));
	};
	const oct = (buf, o, n) => {
		const s = str(buf, o, n).trim();
		return s ? parseInt(s, 8) : 0;
	};

	while (pos + 512 <= tar.length) {
		const h = tar.subarray(pos, pos + 512);
		if (!h[0]) break;
		const name = str(h, 0, 100);
		const size = oct(h, 124, 12);
		const type = h[156];
		const pref = str(h, 345, 155);
		const full = pref ? pref + "/" + name : name;
		pos += 512;

		if (type === 53 || name.endsWith("/")) {
			files.push({ name: full, isDir: true });
		} else if (type === 48 || type === 0) {
			files.push({
				name: full,
				isDir: false,
				data: tar.subarray(pos, pos + size),
			});
		}
		pos += Math.ceil(size / 512) * 512;
	}
	return files;
}

async function convertToZip(tarBase, zipBase, targetChunks) {
	console.log(`Converting ${tarBase} → ${zipBase}...`);
	const tarData = await getTarData(tarBase);
	console.log(`  Extracted TAR: ${(tarData.length / 1024 / 1024).toFixed(2)} MB`);

	const files = extractTar(tarData);
	console.log(`  Files/dirs: ${files.length}`);

	const JSZip = require("jszip");
	const zip = new JSZip();
	for (const file of files) {
		if (file.isDir) {
			zip.folder(file.name);
		} else {
			zip.file(file.name, file.data);
		}
	}

	const zipData = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
	console.log(`  ZIP size: ${(zipData.length / 1024 / 1024).toFixed(2)} MB`);

	// Split into target number of chunks
	const chunkSize = Math.ceil(zipData.length / targetChunks);
	const zipChunks = [];
	for (let i = 0; i < targetChunks; i++) {
		const start = i * chunkSize;
		const end = Math.min(start + chunkSize, zipData.length);
		zipChunks.push(zipData.subarray(start, end));
	}

	console.log(`  Splitting into ${zipChunks.length} chunk(s)...`);

	// Write chunks
	for (let i = 0; i < zipChunks.length; i++) {
		fs.writeFileSync(`${zipBase}${String(i).padStart(2, "0")}`, zipChunks[i]);
	}
	fs.writeFileSync(`${zipBase}.count`, String(zipChunks.length));
	console.log(`  ✓ Done!`);
}

(async () => {
	try {
		await convertToZip("Content.tar", "Content.zip", 4);
		await convertToZip("ContentAudio.tar", "ContentAudio.zip", 24);
		console.log("\nConversion complete! Files ready.");
	} catch (e) {
		console.error("Error:", e.message);
		process.exit(1);
	}
})();
