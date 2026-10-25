// Save sync for the Stardew Valley WASM port, backed by a private GitHub repo.
//
// There is no server here: the browser talks to the GitHub REST API directly.
// The save archive (Saves.tar in OPFS) is a file in one repo you own, written
// with a fine-grained token that lives in this browser's localStorage.
//
//   boot   pull the repo copy if it is newer than the local one
//   play   upload whenever the game rewrites Saves.tar
//
// Configure it from the Sync button in the top bar. The token needs
// "Contents: Read and write" on that single repository.

(() => {
	"use strict";

	const API = "https://api.github.com";
	const STORE_KEY = "stardew-sync";
	const PULLED_KEY = "stardew-sync-pulled";

	const decoder = new TextDecoder();
	let config = null;
	try {
		config = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
	} catch {
		config = null;
	}

	const state = {
		ready: Promise.resolve(),
		message: "Not configured",
		busy: false,
	};

	const configured = () => !!(config?.repo && config?.token && config?.path);

	// --- github --------------------------------------------------------------
	const filePath = () =>
		"/repos/" + config.repo + "/contents/" + config.path.split("/").map(encodeURIComponent).join("/");

	async function github(url, init = {}, accept = "application/vnd.github+json") {
		const response = await fetch(API + url, {
			...init,
			headers: {
				Authorization: `Bearer ${config.token}`,
				Accept: accept,
				"X-GitHub-Api-Version": "2022-11-28",
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...(init.headers || {}),
			},
		});
		if (!response.ok && response.status !== 404) throw new Error(await describe(response));
		return response;
	}

	async function describe(response) {
		const text = await response.text();
		let detail = text.slice(0, 180);
		try {
			const parsed = JSON.parse(text);
			if (parsed?.message) detail = parsed.message;
		} catch {}
		return `GitHub ${response.status}: ${detail}`;
	}

	async function remoteMeta() {
		const response = await github(`${filePath()}?ref=${encodeURIComponent(config.branch)}`);
		if (response.status === 404) return null;
		return response.json();
	}

	async function remoteTime() {
		const response = await github(
			`/repos/${config.repo}/commits?path=${encodeURIComponent(config.path)}&per_page=1`,
		);
		if (!response.ok) return 0;
		const commits = await response.json();
		return Array.isArray(commits) && commits[0] ? Date.parse(commits[0].commit.committer.date) : 0;
	}

	async function download() {
		const response = await github(
			`${filePath()}?ref=${encodeURIComponent(config.branch)}`,
			{},
			"application/vnd.github.raw",
		);
		return new Uint8Array(await response.arrayBuffer());
	}

	async function upload(bytes, sha) {
		const body = {
			message: `save ${new Date().toISOString()}`,
			content: toBase64(bytes),
			branch: config.branch,
		};
		if (sha) body.sha = sha;
		const response = await github(filePath(), { method: "PUT", body: JSON.stringify(body) });
		if (!response.ok) throw new Error(await describe(response));
		return response.json();
	}

	// --- local archive -------------------------------------------------------
	async function localFile() {
		try {
			const root = await navigator.storage.getDirectory();
			return await (await root.getFileHandle("Saves.tar")).getFile();
		} catch {
			return null;
		}
	}

	async function writeLocal(bytes) {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle("Saves.tar", { create: true });
		const writer = await handle.createWritable();
		await writer.write(bytes);
		await writer.close();
	}

	async function gitBlobSha(bytes) {
		const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
		const buffer = new Uint8Array(header.length + bytes.length);
		buffer.set(header);
		buffer.set(bytes, header.length);
		const digest = await crypto.subtle.digest("SHA-1", buffer);
		return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	}

	function toBase64(bytes) {
		let binary = "";
		const chunk = 0x8000;
		for (let offset = 0; offset < bytes.length; offset += chunk)
			binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
		return btoa(binary);
	}

	// --- sync ----------------------------------------------------------------
	function setMessage(message, isError = false) {
		state.message = message;
		state.error = isError;
		refreshStatus();
	}

	async function pushIfChanged(file, meta) {
		const bytes = new Uint8Array(await file.arrayBuffer());
		const sha = await gitBlobSha(bytes);
		if (meta && meta.sha === sha) return false;
		try {
			await upload(bytes, meta?.sha ?? null);
		} catch (error) {
			// Another device pushed first; retry once against the fresh sha.
			const fresh = await remoteMeta();
			await upload(bytes, fresh?.sha ?? null);
		}
		setMessage(`Synced up (${Math.round(bytes.length / 1024)} KB)`);
		return true;
	}

	async function bootSync() {
		if (!configured()) return;
		setMessage("Syncing...");
		const local = await localFile();
		const meta = await remoteMeta();

		if (!meta) {
			if (local) {
				await pushIfChanged(local, null);
				setMessage("Created the repo save from this device");
			} else {
				setMessage("Connected. No save yet on either side");
			}
			return;
		}

		const remoteTimestamp = await remoteTime();
		// An unknown remote time (0) must not let us overwrite the repo copy.
		const shouldPull = !local || remoteTimestamp === 0 || remoteTimestamp > local.lastModified;
		if (shouldPull) {
			if (local && localStorage.getItem(PULLED_KEY) === meta.sha) {
				setMessage("Already in sync");
				return;
			}
			const bytes = await download();
			await writeLocal(bytes);
			localStorage.setItem(PULLED_KEY, meta.sha);
			setMessage(`Pulled the repo save (${Math.round(bytes.length / 1024)} KB)`);
			return;
		}

		const pushed = await pushIfChanged(local, meta);
		if (!pushed) setMessage("Already in sync");
	}

	let lastSeen = 0;

	async function tick() {
		if (!configured() || state.busy) return;
		const file = await localFile();
		if (!file) return;
		if (lastSeen === 0) {
			lastSeen = file.lastModified;
			return;
		}
		if (file.lastModified === lastSeen) return;
		lastSeen = file.lastModified;
		state.busy = true;
		try {
			await pushIfChanged(file, await remoteMeta());
		} catch (error) {
			setMessage(`Upload failed: ${error.message}`, true);
		} finally {
			state.busy = false;
		}
	}

	// --- ui ------------------------------------------------------------------
	const panel = document.createElement("div");
	panel.id = "sync";
	panel.hidden = true;
	panel.innerHTML = `
		<div id="sync-card" role="dialog" aria-modal="true" aria-label="Save sync">
			<div id="sync-head">
				<strong>Save sync</strong>
				<button type="button" id="sync-close" aria-label="Close">&times;</button>
			</div>
			<label>Repository <span>owner/name, private</span>
				<input id="sync-repo" type="text" placeholder="you/stardew-save" autocomplete="off" spellcheck="false" />
			</label>
			<label>File path
				<input id="sync-path" type="text" placeholder="Saves.tar" autocomplete="off" spellcheck="false" />
			</label>
			<label>Branch
				<input id="sync-branch" type="text" placeholder="main" autocomplete="off" spellcheck="false" />
			</label>
			<label>Token <span>Contents: read &amp; write</span>
				<input id="sync-token" type="password" placeholder="github_pat_..." autocomplete="off" spellcheck="false" />
			</label>
			<p id="sync-note">Stored only in this browser. The game pulls the repo save at startup and uploads after each save.</p>
			<div id="sync-actions">
				<button type="button" id="sync-cancel">Cancel</button>
				<button type="button" id="sync-save">Save &amp; sync</button>
			</div>
			<p id="sync-status"></p>
			<button type="button" id="sync-forget" hidden>Disconnect this device</button>
		</div>`;
	document.body.append(panel);

	const style = document.createElement("style");
	style.textContent = `
		#sync {
			position: fixed; inset: 0; z-index: 21;
			display: flex; align-items: center; justify-content: center; padding: 16px;
			background: rgba(6, 5, 4, 0.72);
			-webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
			font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
			color: #f8eed8;
		}
		#sync[hidden] { display: none; }
		#sync-card {
			width: 100%; max-width: 360px; max-height: 90dvh; overflow-y: auto;
			background: #17130f; border: 1px solid rgba(255, 236, 200, 0.22);
			border-radius: 16px; padding: 16px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
		}
		#sync-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
		#sync-head strong { font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; }
		#sync-close { background: none; border: 0; color: inherit; font-size: 22px; line-height: 1; padding: 0 4px; cursor: pointer; opacity: 0.7; }
		#sync label { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.85; }
		#sync label span { text-transform: none; letter-spacing: 0; opacity: 0.5; font-size: 10.5px; }
		#sync input {
			font: 500 15px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
			color: #f8eed8; background: rgba(255, 255, 255, 0.07);
			border: 1px solid rgba(255, 236, 200, 0.22); border-radius: 9px;
			padding: 10px 12px; letter-spacing: 0; text-transform: none; width: 100%;
		}
		#sync input:focus { outline: 2px solid rgba(255, 214, 138, 0.5); outline-offset: 1px; }
		#sync-note { margin: 2px 0 12px; font-size: 11.5px; line-height: 1.45; letter-spacing: 0; text-transform: none; opacity: 0.6; }
		#sync-actions { display: flex; gap: 8px; }
		#sync-actions button, #sync-forget {
			flex: 1; padding: 11px 12px; border-radius: 10px; cursor: pointer;
			font: 600 12px/1 inherit; letter-spacing: 0.06em; text-transform: uppercase;
			color: inherit; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 236, 200, 0.24);
		}
		#sync-save { background: #ffd98a; color: #241a0c; border-color: #ffd98a; }
		#sync-status { margin: 10px 0 0; font-size: 12px; letter-spacing: 0; text-transform: none; color: #cfe6c3; min-height: 1.2em; }
		#sync-status.error { color: #ffb4a0; }
		#sync-forget { width: 100%; margin-top: 10px; font-size: 11px; background: none; border-color: rgba(255, 120, 100, 0.4); color: #ffb4a0; }`;
	document.head.append(style);

	const button = document.createElement("button");
	button.type = "button";
	button.id = "sync-open";
	button.textContent = "Sync";
	const topBar = document.getElementById("tc-top");
	if (topBar) topBar.append(button);
	else {
		button.style.cssText =
			"position:fixed;z-index:9;top:14px;right:104px;height:40px;padding:0 14px;border-radius:12px;" +
			"font:600 11px/1 -apple-system,sans-serif;letter-spacing:.06em;text-transform:uppercase;" +
			"color:#f8eed8;background:rgba(26,20,14,.55);border:1.5px solid rgba(255,236,200,.3);cursor:pointer;";
		document.body.append(button);
	}

	const repoInput = panel.querySelector("#sync-repo");
	const pathInput = panel.querySelector("#sync-path");
	const branchInput = panel.querySelector("#sync-branch");
	const tokenInput = panel.querySelector("#sync-token");
	const statusLine = panel.querySelector("#sync-status");
	const forgetButton = panel.querySelector("#sync-forget");

	function refreshStatus() {
		statusLine.textContent = state.message;
		statusLine.classList.toggle("error", !!state.error);
	}

	function open() {
		panel.hidden = false;
		repoInput.value = config?.repo || "";
		pathInput.value = config?.path || "Saves.tar";
		branchInput.value = config?.branch || "main";
		tokenInput.value = config?.token || "";
		forgetButton.hidden = !configured();
		refreshStatus();
	}

	function close() {
		panel.hidden = true;
	}

	async function saveAndSync() {
		const repo = repoInput.value.trim();
		const path = pathInput.value.trim() || "Saves.tar";
		const branch = branchInput.value.trim() || "main";
		const token = tokenInput.value.trim();
		state.error = false;
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
			state.message = "Repository must look like owner/name.";
			refreshStatus();
			return;
		}
		if (!token) {
			state.message = "Paste a token with Contents read & write.";
			refreshStatus();
			return;
		}
		config = { repo, path, branch, token };
		localStorage.setItem(STORE_KEY, JSON.stringify(config));
		lastSeen = 0;
		state.message = "Syncing...";
		refreshStatus();
		try {
			await bootSync();
			forgetButton.hidden = false;
		} catch (error) {
			state.message = `Sync failed: ${error.message}`;
			state.error = true;
			refreshStatus();
		}
	}

	button.addEventListener("click", open);
	panel.querySelector("#sync-close").addEventListener("click", close);
	panel.querySelector("#sync-cancel").addEventListener("click", close);
	panel.querySelector("#sync-save").addEventListener("click", saveAndSync);
	forgetButton.addEventListener("click", () => {
		localStorage.removeItem(STORE_KEY);
		localStorage.removeItem(PULLED_KEY);
		config = null;
		state.message = "Disconnected";
		refreshStatus();
		forgetButton.hidden = true;
	});
	panel.addEventListener("click", (event) => {
		if (event.target === panel) close();
	});
	addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !panel.hidden) close();
	});

	// --- start ---------------------------------------------------------------
	window.stardewSaveSync = { state, ready: state.ready };

	// The game waits on ready before it reads the save, so a stalled request must
	// never hold up the boot. After the timeout the sync keeps going in the
	// background; the push watcher picks it up on the next tick.
	const withTimeout = (promise, ms) =>
		Promise.race([
			promise,
			new Promise((_, reject) => setTimeout(() => reject(new Error("GitHub did not answer in 10s")), ms)),
		]);

	if (configured()) {
		state.ready = withTimeout(bootSync(), 10000)
			.then(async () => {
				const file = await localFile();
				lastSeen = file?.lastModified || 0;
			})
			.catch((error) => {
				setMessage(`Sync failed: ${error.message}`, true);
			});
	} else {
		state.ready = Promise.resolve();
	}
	window.stardewSaveSync.ready = state.ready;

	setInterval(tick, 4000);
	addEventListener("pagehide", () => {
		if (configured()) void tick();
	});
})();
