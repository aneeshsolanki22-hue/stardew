// Cheat panel for the Stardew Valley WASM port.
//
// The game gives JavaScript no access to live values, so this cannot change
// gold while you play. What it *can* do is edit the save archive the game
// writes to OPFS (Saves.tar) and then reload: the game boots, unpacks the
// edited save, and the new values are what you see.
//
// Only fields that live in the save's <player> block are touched, and the
// surrounding tar is rebuilt byte-for-byte otherwise.

(() => {
	"use strict";

	const INT_MAX = 2000000000;

	// --- tar helpers ---------------------------------------------------------
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	function readString(bytes, offset, length) {
		let end = offset;
		while (end < offset + length && bytes[end] !== 0) end++;
		return decoder.decode(bytes.subarray(offset, end));
	}

	function parseTar(bytes) {
		const entries = [];
		let pos = 0;
		while (pos + 512 <= bytes.length) {
			const header = bytes.subarray(pos, pos + 512);
			if (header.every((value) => value === 0)) break;
			const name = readString(bytes, pos, 100);
			const prefix = readString(bytes, pos + 345, 155);
			const size = Number.parseInt(readString(bytes, pos + 124, 12).trim() || "0", 8);
			const dataStart = pos + 512;
			const dataEnd = dataStart + size;
			if (!Number.isFinite(size) || dataEnd > bytes.length) break;
			entries.push({
				path: prefix ? `${prefix}/${name}` : name,
				header: bytes.slice(pos, pos + 512),
				data: bytes.slice(dataStart, dataEnd),
			});
			pos = dataStart + Math.ceil(size / 512) * 512;
		}
		return entries;
	}

	function writeOctal(target, offset, length, value) {
		const digits = value.toString(8).slice(-(length - 1));
		target.fill(0x30, offset, offset + length);
		target.set(encoder.encode(digits), offset + length - 1 - digits.length);
		target[offset + length - 1] = 0;
	}

	function buildTar(entries) {
		const parts = [];
		let total = 0;
		for (const entry of entries) {
			const header = entry.header.slice();
			writeOctal(header, 124, 12, entry.data.length);
			header.fill(0x20, 148, 156);
			let checksum = 0;
			for (const byte of header) checksum += byte;
			const digits = checksum.toString(8).padStart(6, "0").slice(-6);
			header.set(encoder.encode(digits), 148);
			header[154] = 0;
			header[155] = 0x20;
			parts.push(header, entry.data);
			total += 512 + entry.data.length;
			const padding = (512 - (entry.data.length % 512)) % 512;
			if (padding) {
				parts.push(new Uint8Array(padding));
				total += padding;
			}
		}
		parts.push(new Uint8Array(1024));
		total += 1024;
		const out = new Uint8Array(total);
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.length;
		}
		return out;
	}

	// --- save archive --------------------------------------------------------
	async function readArchive() {
		const root = await navigator.storage.getDirectory();
		const handle = await root.getFileHandle("Saves.tar");
		const file = await handle.getFile();
		const bytes = new Uint8Array(await file.arrayBuffer());
		return { root, bytes, entries: parseTar(bytes) };
	}

	function isSaveEntry(entry) {
		// <SaveGameInfo> starts with the same text, so match the element itself.
		return /<SaveGame[\s>]/.test(decodeHead(entry));
	}

	function decodeHead(entry) {
		return decoder.decode(entry.data.subarray(0, 400));
	}

	function playerValue(xml, tag) {
		const start = xml.indexOf("<player>");
		const end = xml.indexOf("</player>", start + 1);
		const region = start >= 0 && end > start ? xml.slice(start, end) : xml;
		const match = region.match(new RegExp(`<${tag}>(-?[\\d.]+)</${tag}>`));
		return match ? match[1] : "";
	}

	function setPlayerValue(xml, tag, value) {
		if (value === null) return xml;
		const start = xml.indexOf("<player>");
		const end = start >= 0 ? xml.indexOf("</player>", start + 1) : -1;
		if (start < 0 || end < 0) return xml;
		const region = xml.slice(start, end);
		const replaced = region.replace(
			new RegExp(`(<${tag}>)-?[\\d.]+(</${tag}>)`),
			(_match, open, close) => `${open}${value}${close}`,
		);
		return xml.slice(0, start) + replaced + xml.slice(end);
	}

	// --- ui ------------------------------------------------------------------
	const panel = document.createElement("div");
	panel.id = "cheat";
	panel.hidden = true;
	panel.innerHTML = `
		<div id="cheat-card" role="dialog" aria-modal="true" aria-label="Cheats">
			<div id="cheat-head">
				<strong>Cheats</strong>
				<button type="button" id="cheat-close" aria-label="Close">&times;</button>
			</div>
			<label id="cheat-save-row" hidden>Save
				<select id="cheat-save"></select>
			</label>
			<label>Money (g)
				<input id="cheat-money" type="text" inputmode="numeric" autocomplete="off" />
			</label>
			<label>Total earned
				<input id="cheat-earned" type="text" inputmode="numeric" autocomplete="off" />
			</label>
			<label>Stamina
				<input id="cheat-stamina" type="text" inputmode="numeric" autocomplete="off" />
			</label>
			<p id="cheat-note">Edits the save file, then reloads so the game loads it. Unsaved progress is lost.</p>
			<div id="cheat-actions">
				<button type="button" id="cheat-cancel">Cancel</button>
				<button type="button" id="cheat-apply">Apply &amp; reload</button>
			</div>
		</div>`;
	document.body.append(panel);

	const style = document.createElement("style");
	style.textContent = `
		#cheat {
			position: fixed; inset: 0; z-index: 20;
			display: flex; align-items: center; justify-content: center;
			padding: 16px; background: rgba(6, 5, 4, 0.72);
			-webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
			font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
			color: #f8eed8;
		}
		#cheat[hidden] { display: none; }
		#cheat-card {
			width: 100%; max-width: 340px;
			background: #17130f; border: 1px solid rgba(255, 236, 200, 0.22);
			border-radius: 16px; padding: 16px;
			box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
		}
		#cheat-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
		#cheat-head strong { font-size: 15px; letter-spacing: 0.08em; text-transform: uppercase; }
		#cheat-close {
			background: none; border: 0; color: inherit; font-size: 22px; line-height: 1;
			padding: 0 4px; cursor: pointer; opacity: 0.7;
		}
		#cheat label {
			display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px;
			font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.85;
		}
		#cheat input, #cheat select {
			font: 500 16px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
			color: #f8eed8; background: rgba(255, 255, 255, 0.07);
			border: 1px solid rgba(255, 236, 200, 0.22); border-radius: 9px;
			padding: 10px 12px; letter-spacing: 0; text-transform: none; width: 100%;
		}
		#cheat input:focus, #cheat select:focus { outline: 2px solid rgba(255, 214, 138, 0.5); outline-offset: 1px; }
		#cheat-note {
			margin: 4px 0 14px; font-size: 11.5px; line-height: 1.45; letter-spacing: 0;
			text-transform: none; opacity: 0.6;
		}
		#cheat-actions { display: flex; gap: 8px; }
		#cheat-actions button {
			flex: 1; padding: 11px 12px; border-radius: 10px; cursor: pointer;
			font: 600 12px/1 inherit; letter-spacing: 0.06em; text-transform: uppercase;
			color: inherit; background: rgba(255, 255, 255, 0.08);
			border: 1px solid rgba(255, 236, 200, 0.24);
		}
		#cheat-apply { background: #ffd98a; color: #241a0c; border-color: #ffd98a; }
		#cheat-apply:disabled { opacity: 0.45; cursor: default; }
		#cheat-status {
			margin-top: 10px; font-size: 12px; letter-spacing: 0; text-transform: none;
			color: #ffb4a0; min-height: 1em;
		}`;
	document.head.append(style);

	const button = document.createElement("button");
	button.type = "button";
	button.id = "cheat-open";
	button.textContent = "Cheat";
	const topBar = document.getElementById("tc-top");
	if (topBar) {
		button.className = topBar.firstElementChild?.className || "";
		topBar.append(button);
	} else {
		button.style.cssText =
			"position:fixed;z-index:9;top:14px;right:18px;height:40px;padding:0 14px;border-radius:12px;" +
			"font:600 11px/1 -apple-system,sans-serif;letter-spacing:.06em;text-transform:uppercase;" +
			"color:#f8eed8;background:rgba(26,20,14,.55);border:1.5px solid rgba(255,236,200,.3);cursor:pointer;";
		document.body.append(button);
	}

	const moneyInput = panel.querySelector("#cheat-money");
	const earnedInput = panel.querySelector("#cheat-earned");
	const staminaInput = panel.querySelector("#cheat-stamina");
	const saveRow = panel.querySelector("#cheat-save-row");
	const saveSelect = panel.querySelector("#cheat-save");
	const status = document.createElement("p");
	status.id = "cheat-status";
	panel.querySelector("#cheat-card").append(status);

	let archive = null;
	let saves = [];

	function fillInputs() {
		const entry = saves[saveSelect.selectedIndex];
		if (!entry) return;
		const xml = decoder.decode(entry.data);
		moneyInput.value = playerValue(xml, "money");
		earnedInput.value = playerValue(xml, "totalMoneyEarned");
		staminaInput.value = playerValue(xml, "stamina");
	}

	async function open() {
		panel.hidden = false;
		status.textContent = "";
		saveRow.hidden = true;
		saveSelect.replaceChildren();
		try {
			archive = await readArchive();
			saves = archive.entries.filter(isSaveEntry);
			if (!saves.length) {
				status.textContent = "No save found yet. Play until the game saves (sleep for the night), then come back.";
				panel.querySelector("#cheat-apply").disabled = true;
				return;
			}
			panel.querySelector("#cheat-apply").disabled = false;
			saveRow.hidden = saves.length < 2;
			for (const entry of saves) {
				const option = document.createElement("option");
				option.value = entry.path;
				option.textContent = entry.path;
				saveSelect.append(option);
			}
			saveSelect.selectedIndex = 0;
			fillInputs();
		} catch (error) {
			status.textContent =
				error?.name === "NotFoundError"
					? "No save found yet. Sleep in-game so it writes one, then come back."
					: `Could not read the save: ${error?.message || error}`;
			panel.querySelector("#cheat-apply").disabled = true;
		}
	}

	function close() {
		panel.hidden = true;
	}

	function parseField(input, label) {
		const raw = input.value.trim();
		if (!raw) return { ok: true, value: null };
		if (!/^\d+$/.test(raw)) return { ok: false, message: `${label} must be a whole number.` };
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value > INT_MAX)
			return { ok: false, message: `${label} must be ${INT_MAX} or less.` };
		return { ok: true, value: String(value) };
	}

	async function apply() {
		const money = parseField(moneyInput, "Money");
		const earned = parseField(earnedInput, "Total earned");
		const stamina = parseField(staminaInput, "Stamina");
		const bad = [money, earned, stamina].find((field) => !field.ok);
		if (bad) {
			status.textContent = bad.message;
			return;
		}
		const entry = saves[saveSelect.selectedIndex];
		if (!entry) return;
		const applyButton = panel.querySelector("#cheat-apply");
		applyButton.disabled = true;			status.textContent = "Writing save...";
		try {
			const before = decoder.decode(entry.data);
			if (!before.includes("<player>")) throw new Error("save has no <player> block");
			let xml = before;
			xml = setPlayerValue(xml, "money", money.value);
			xml = setPlayerValue(xml, "totalMoneyEarned", earned.value);
			xml = setPlayerValue(xml, "stamina", stamina.value);
			if (xml === before) throw new Error("no editable values were found in this save");
			entry.data = encoder.encode(xml);

			const bytes = buildTar(archive.entries);
			// Never hand back a tar that lost or renamed entries.
			const rebuilt = parseTar(bytes);
			if (rebuilt.length !== archive.entries.length ||
				rebuilt.some((item, index) => item.path !== archive.entries[index].path))
				throw new Error("rebuilt archive did not match the original");
			const handle = await archive.root.getFileHandle("Saves.tar", { create: true });
			const writer = await handle.createWritable();
			await writer.write(bytes);
			await writer.close();

			status.textContent = `Saved. Money is now ${money.value ?? playerValue(xml, "money")} g. Reloading...`;
			setTimeout(() => location.reload(), 900);
		} catch (error) {
			status.textContent = `Could not write the save: ${error?.message || error}`;
			applyButton.disabled = false;
		}
	}

	button.addEventListener("click", open);
	panel.querySelector("#cheat-close").addEventListener("click", close);
	panel.querySelector("#cheat-cancel").addEventListener("click", close);
	panel.querySelector("#cheat-apply").addEventListener("click", apply);
	saveSelect.addEventListener("change", fillInputs);
	panel.addEventListener("click", (event) => {
		if (event.target === panel) close();
	});
	addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !panel.hidden) close();
	});
})();
