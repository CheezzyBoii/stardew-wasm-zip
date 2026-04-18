const loading = document.getElementById("loading");
const canvas = document.getElementById("canvas");
const musicChoice = document.getElementById("music-choice");
const progressContainer = document.getElementById("progress-container");
const progressText = document.getElementById("progress-text");
const progressFill = document.getElementById("progress-fill");

// --- Progress tracking ---
let progressState = { current: 0, total: 100 };
function updateProgress(current, total, label) {
	progressState = { current, total };
	const percent = Math.min(100, Math.round((current / total) * 100));
	progressText.textContent = label;
	progressFill.style.width = percent + "%";
	progressFill.textContent = percent + "%";
}

// --- Load jszip ---
updateProgress(0, 100, "Loading libraries...");
await new Promise((resolve) => {
	const s = document.createElement("script");
	s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
	s.onload = resolve;
	document.head.appendChild(s);
});
const JSZip = window.JSZip;

// --- OPFS helpers ---
const opfs = await navigator.storage.getDirectory();

async function opfsHas(name) {
	try { await opfs.getFileHandle(name); return true; } catch { return false; }
}
async function opfsRead(name) {
	return new Uint8Array(await (await (await opfs.getFileHandle(name)).getFile()).arrayBuffer());
}
async function opfsWrite(name, data) {
	const w = await (await opfs.getFileHandle(name, { create: true })).createWritable();
	await w.write(data); await w.close();
}

// --- Chunked download ---
async function downloadChunked(base, label, estimatedSize) {
	const count = parseInt(await (await fetch(base + ".count")).text());
	const chunks = [];
	let total = 0;
	for (let i = 0; i < count; i++) {
		const res = await fetch(`${base}${String(i).padStart(2, "0")}`);
		if (!res.ok) throw new Error(`Failed: ${res.status}`);
		const reader = res.body.getReader();
		const contentLength = parseInt(res.headers.get("content-length") || "0");
		let chunkBytes = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.length;
			chunkBytes += value.length;
			updateProgress(total, estimatedSize, `Downloading ${label}... ${(total / 1048576).toFixed(1)} MB`);
		}
	}
	const data = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) { data.set(c, off); off += c.length; }
	return data;
}

async function getArchive(base, label, key, estimatedSize) {
	try {
		updateProgress(0, 100, `Loading cached ${label}...`);
		return await opfsRead(key);
	} catch {
		const archive = await downloadChunked(base, label, estimatedSize);
		try {
			updateProgress(0, 100, `Caching ${label}...`);
			await opfsWrite(key, archive);
		} catch {}
		return archive;
	}
}

// --- Music choice (skip if audio already cached) ---
const audioCached = await opfsHas("Content.zip");
const wantMusic = audioCached || await new Promise((resolve) => {
	musicChoice.style.display = "";
	document.getElementById("btn-no-music").onclick = () => {
		musicChoice.style.display = "none";
		resolve(false);
	};
	document.getElementById("btn-with-music").onclick = () => {
		musicChoice.style.display = "none";
		resolve(true);
	};
});
if (!audioCached) musicChoice.style.display = "none";

// --- Parallel: download zips + boot runtime ---
// Estimated sizes in MB (from compression results)
updateProgress(5, 100, "Starting downloads...");
progressContainer.classList.add("visible");
const contentP = getArchive("Content.zip", "game content", "Content.zip", 57 * 1024 * 1024);
const audioP = wantMusic ? getArchive("ContentAudio.zip", "music", "ContentAudio.zip", 358 * 1024 * 1024) : Promise.resolve(null);
const runtimeP = (async () => {
	const { dotnet } = await import("./_framework/dotnet.js");
	return dotnet
		.withModuleConfig({ canvas })
		.withEnvironmentVariable("MONO_SLEEP_ABORT_LIMIT", "99999")
		.withRuntimeOptions([
			`--jiterpreter-minimum-trace-hit-count=${500}`,
			`--jiterpreter-trace-monitoring-period=${100}`,
			`--jiterpreter-trace-monitoring-max-average-penalty=${150}`,
			`--jiterpreter-wasm-bytes-limit=${64 * 1024 * 1024}`,
			`--jiterpreter-table-size=${32 * 1024}`,
		])
		.withResourceLoader((type, _name, defaultUri, _integrity, behavior) => {
			if (type === "dotnetwasm" && behavior === "dotnetwasm") {
				return (async () => {
					const count = parseInt(await (await fetch(defaultUri + ".count")).text());
					let idx = 0;
					const fetchNext = async () => {
						if (idx >= count) return null;
						const res = await fetch(defaultUri + idx);
						idx++;
						return res.ok ? res.body.getReader() : null;
					};
					let current = await fetchNext();
					if (!current) throw new Error("failed to fetch first wasm chunk");
					return new Response(new ReadableStream({
						async pull(controller) {
							const { value, done } = await current.read();
							if (done || !value) {
								current = await fetchNext();
								if (current) await this.pull(controller);
								else controller.close();
							} else controller.enqueue(value);
						},
					}), { headers: { "Content-Type": "application/wasm" } });
				})();
			}
		})
		.create();
})();

updateProgress(30, 100, "Bootstrapping runtime...");
const [contentZip, audioZip, runtime] = await Promise.all([contentP, audioP, runtimeP]);
updateProgress(50, 100, "Initializing runtime...");
const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
updateProgress(55, 100, "Preparing game...");

// --- Extract ZIP into WasmFS ---
async function extractZip(zipData, prefix, progressOffset = 0, progressScale = 1) {
	if (!zipData) return 0;
	const zip = await JSZip.loadAsync(zipData);
	const entries = Object.entries(zip.files);
	let count = 0;
	for (let idx = 0; idx < entries.length; idx++) {
		const [path, file] = entries[idx];
		if (file.dir) {
			exports.WasmBootstrap.CreateContentDirectory(prefix + "/" + path);
		} else {
			const data = await file.async("uint8array");
			exports.WasmBootstrap.WriteContentFile(prefix + "/" + path, data);
			count++;
		}
		const progress = progressOffset + ((idx / entries.length) * progressScale);
		updateProgress(progress, 100, `Extracting files... ${idx}/${entries.length}`);
	}
	return count;
}

await runtime.runMain();
updateProgress(60, 100, "Starting game engine...");
await exports.WasmBootstrap.PreInit();

// Restore saves from OPFS
try {
	updateProgress(65, 100, "Loading saves...");
	const savesZip = await opfsRead("Saves.zip");
	exports.WasmBootstrap.CreateContentDirectory("/libsdl/saves/Saves");
	await extractZip(savesZip, "/libsdl/saves/Saves", 65, 5);
} catch {}

updateProgress(70, 100, "Loading game files...");
await extractZip(contentZip, "/libsdl", 70, 15);
if (audioZip) {
	updateProgress(85, 100, "Loading music...");
	await extractZip(audioZip, "/libsdl", 85, 10);
}

updateProgress(95, 100, "Initializing canvas...");
const dpr = window.devicePixelRatio || 1;
const w = Math.round(canvas.clientWidth * dpr) || 1280;
const h = Math.round(canvas.clientHeight * dpr) || 720;
await exports.WasmBootstrap.Init(w, h);
updateProgress(99, 100, "Starting game...");

loading.classList.add("hidden");

new ResizeObserver(() => {
	const dpr = window.devicePixelRatio || 1;
	const nw = Math.round(canvas.clientWidth * dpr);
	const nh = Math.round(canvas.clientHeight * dpr);
	if (nw > 0 && nh > 0) try { exports.WasmBootstrap.Resize(nw, nh); } catch {}
}).observe(canvas);

try { navigator.keyboard?.lock(); } catch {}
document.addEventListener("keydown", (e) => {
	if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Tab"].includes(e.code))
		e.preventDefault();
});

await exports.WasmBootstrap.MainLoop();
