// Touch controls for the Stardew Valley WebAssembly port.
//
// The port is a desktop build: nothing inside the game knows about touch. SDL
// (via Emscripten) listens for DOM keyboard and mouse events, so every control
// here dispatches real KeyboardEvents on the canvas, which bubble up to
// document/window where those listeners live. The .NET runtime is untouched.
//
// Shown on touch devices; add ?touch=1 to the URL to force it on a desktop.
//
// Key bindings are the game's defaults:
//   move  WASD      tool C      action X      inventory E      menu Esc   map M

(() => {
	"use strict";

	const forced = new URLSearchParams(location.search).has("touch");
	const touchDevice = matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
	if (!forced && !touchDevice) return;

	const canvas = document.getElementById("canvas");
	const MIN_HOLD = 70; // ms — guarantee at least one game frame sees the press
	const held = new Map();

	// --- key synthesis -------------------------------------------------------
	function fire(type, spec, shift) {
		const charCode = type === "keypress" && spec.key.length === 1 ? spec.key.charCodeAt(0) : 0;
		const event = new KeyboardEvent(type, {
			key: spec.key,
			code: spec.code,
			location: 0,
			repeat: false,
			bubbles: true,
			cancelable: true,
			shiftKey: !!shift,
		});
		// KeyboardEvent's init dict drops keyCode/which/charCode, and Emscripten's
		// SDL bridge reads all three, so define them explicitly.
		Object.defineProperties(event, {
			keyCode: { get: () => spec.keyCode },
			which: { get: () => spec.keyCode },
			charCode: { get: () => charCode },
			char: { get: () => (type === "keypress" ? spec.key : "") },
		});
		(canvas || document.body).dispatchEvent(event);
	}

	function press(id, spec) {
		if (held.has(id)) return;
		const shift = !!spec.shift;
		held.set(id, { spec, shift, at: performance.now() });
		fire("keydown", spec, shift);
		if (spec.key.length === 1) fire("keypress", spec, shift);
	}

	function release(id) {
		const entry = held.get(id);
		if (!entry) return;
		held.delete(id);
		const wait = Math.max(0, MIN_HOLD - (performance.now() - entry.at));
		setTimeout(() => fire("keyup", entry.spec, entry.shift), wait);
	}

	function releaseAll() {
		for (const id of [...held.keys()]) release(id);
	}

	const KEYS = {
		up: { key: "w", code: "KeyW", keyCode: 87 },
		down: { key: "s", code: "KeyS", keyCode: 83 },
		left: { key: "a", code: "KeyA", keyCode: 65 },
		right: { key: "d", code: "KeyD", keyCode: 68 },
		tool: { key: "c", code: "KeyC", keyCode: 67 },
		action: { key: "x", code: "KeyX", keyCode: 88 },
		bag: { key: "e", code: "KeyE", keyCode: 69 },
		menu: { key: "Escape", code: "Escape", keyCode: 27 },
		map: { key: "m", code: "KeyM", keyCode: 77 },
		space: { key: " ", code: "Space", keyCode: 32 },
		enter: { key: "Enter", code: "Enter", keyCode: 13 },
		back: { key: "Backspace", code: "Backspace", keyCode: 8 },
	};

	const letterKey = (ch, shift) => ({
		key: shift ? ch.toUpperCase() : ch,
		code: "Key" + ch.toUpperCase(),
		keyCode: ch.toUpperCase().charCodeAt(0),
		shift: !!shift,
	});
	const digitKey = (ch) => ({ key: ch, code: "Digit" + ch, keyCode: ch.charCodeAt(0) });

	// --- markup --------------------------------------------------------------
	const root = document.createElement("div");
	root.id = "tc";
	root.innerHTML = `
		<div id="tc-stick"><div id="tc-nub"></div></div>
		<div id="tc-actions">
			<button type="button" data-act="map" style="grid-area:map">Map</button>
			<button type="button" data-act="menu" style="grid-area:menu">Menu</button>
			<button type="button" data-act="bag" style="grid-area:bag">Bag</button>
			<button type="button" data-act="action" style="grid-area:action">Action</button>
			<button type="button" data-act="tool" style="grid-area:tool">Tool</button>
		</div>
		<div id="tc-top">
			<button type="button" id="tc-type">Type</button>
			<button type="button" id="tc-fit">Fit</button>
		</div>
		<div id="tc-keyboard" hidden></div>
		<div id="tc-toast" role="status" aria-live="polite"></div>`;
	document.body.append(root);

	const style = document.createElement("style");
	style.textContent = `
		#tc, #tc * { -webkit-tap-highlight-color: transparent; }
		#tc {
			position: fixed; inset: 0; z-index: 5; pointer-events: none;
			font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
			letter-spacing: 0.06em; text-transform: uppercase;
			color: #f8eed8; touch-action: none;
			-webkit-user-select: none; user-select: none;
			-webkit-touch-callout: none;
		}
		#tc button {
			font: inherit; color: inherit; cursor: pointer;
			border: 1.5px solid rgba(255, 236, 200, 0.3);
			background: rgba(26, 20, 14, 0.55);
			-webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
			box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
			transition: transform 0.08s ease, background 0.08s ease, border-color 0.08s ease;
			touch-action: none;
		}
		#tc button.on, #tc button:active {
			background: rgba(255, 214, 138, 0.34);
			border-color: rgba(255, 228, 176, 0.85);
			transform: scale(0.95);
		}
		#tc-stick {
			position: absolute; pointer-events: auto;
			left: calc(20px + env(safe-area-inset-left));
			bottom: calc(24px + env(safe-area-inset-bottom));
			width: 138px; height: 138px; border-radius: 50%;
			border: 1.5px solid rgba(255, 236, 200, 0.26);
			background: radial-gradient(circle, rgba(255, 255, 255, 0.07) 0%, rgba(255, 255, 255, 0.03) 55%, rgba(255, 255, 255, 0) 62%);
			box-shadow: inset 0 0 28px rgba(0, 0, 0, 0.3), 0 6px 22px rgba(0, 0, 0, 0.3);
			touch-action: none;
		}
		#tc-nub {
			position: absolute; left: 50%; top: 50%; width: 58px; height: 58px;
			margin: -29px 0 0 -29px; border-radius: 50%;
			background: radial-gradient(circle at 38% 32%, rgba(255, 245, 224, 0.55), rgba(255, 240, 210, 0.22));
			border: 1.5px solid rgba(255, 240, 210, 0.5);
			box-shadow: 0 3px 12px rgba(0, 0, 0, 0.35);
			transition: transform 0.04s linear;
		}
		#tc-actions {
			position: absolute; pointer-events: none;
			right: calc(18px + env(safe-area-inset-right));
			bottom: calc(24px + env(safe-area-inset-bottom));
			display: grid; gap: 9px;
			grid-template-columns: repeat(3, clamp(56px, 8vw, 72px));
			grid-template-areas: "map menu bag" "action tool tool";
		}
		#tc-actions button {
			pointer-events: auto; height: 54px; border-radius: 16px; padding: 0 6px;
		}
		#tc-top {
			position: absolute; pointer-events: none;
			right: calc(18px + env(safe-area-inset-right));
			top: calc(14px + env(safe-area-inset-top));
			display: flex; gap: 8px;
		}
		#tc-top button {
			pointer-events: auto; height: 40px; min-width: 62px;
			padding: 0 10px; border-radius: 12px; font-size: 11px;
		}
		#tc-keyboard {
			position: absolute; left: 0; right: 0; bottom: 0; pointer-events: auto;
			display: flex; flex-direction: column; gap: 6px;
			padding: 10px 8px calc(10px + env(safe-area-inset-bottom));
			background: rgba(16, 12, 9, 0.9);
			-webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
			border-top: 1px solid rgba(255, 236, 200, 0.16);
			touch-action: none;
		}
		#tc-keyboard[hidden] { display: none; }
		.tc-row { display: flex; gap: 6px; justify-content: center; }
		.tc-key {
			flex: 1 1 0; max-width: 56px; height: 44px; border-radius: 9px;
			background: rgba(255, 255, 255, 0.09);
			border: 1px solid rgba(255, 255, 255, 0.14);
			font-size: 17px; text-transform: none; letter-spacing: 0;
		}
		.tc-key.wide { flex: 1.6 1 0; max-width: 92px; font-size: 11px; letter-spacing: 0.06em; }
		.tc-key[data-key="space"] { flex: 4 1 0; max-width: 300px; }
		.tc-row:last-child .tc-key[data-key="enter"] { max-width: 140px; }
		.tc-key.on { background: rgba(255, 214, 138, 0.36); border-color: rgba(255, 228, 176, 0.8); }
		#tc.kb-open #tc-stick, #tc.kb-open #tc-actions { visibility: hidden; }
		#tc-toast {
			position: absolute; left: 50%; bottom: 46%; max-width: 78vw;
			transform: translate(-50%, 6px); opacity: 0;
			padding: 10px 16px; border-radius: 999px; text-align: center;
			background: rgba(16, 12, 9, 0.92); border: 1px solid rgba(255, 236, 200, 0.24);
			font-size: 12px; line-height: 1.4; letter-spacing: 0.02em; text-transform: none;
			transition: opacity 0.18s ease, transform 0.18s ease; pointer-events: none;
		}
		#tc-toast.show { opacity: 1; transform: translate(-50%, 0); }
		@media (max-width: 500px) {
			#tc-stick { width: 116px; height: 116px; }
			#tc-nub { width: 50px; height: 50px; margin: -25px 0 0 -25px; }
		}`;
	document.head.append(style);

	// --- joystick ------------------------------------------------------------
	const stick = root.querySelector("#tc-stick");
	const nub = root.querySelector("#tc-nub");
	const directions = { up: false, down: false, left: false, right: false };
	let stickPointer = null;
	let centerX = 0;
	let centerY = 0;
	let radius = 0;

	function setDirections(next) {
		for (const dir of ["up", "down", "left", "right"]) {
			const want = !!next[dir];
			if (want === directions[dir]) continue;
			directions[dir] = want;
			if (want) press("move:" + dir, KEYS[dir]);
			else release("move:" + dir);
		}
	}

	function moveStick(x, y) {
		let dx = x - centerX;
		let dy = y - centerY;
		const dist = Math.hypot(dx, dy);
		const travel = radius * 0.6;
		if (dist > travel) {
			dx = (dx / dist) * travel;
			dy = (dy / dist) * travel;
		}
		nub.style.transform = `translate(${dx}px, ${dy}px)`;
		const dead = radius * 0.24;
		setDirections({
			left: dx < -dead,
			right: dx > dead,
			up: dy < -dead,
			down: dy > dead,
		});
	}

	stick.addEventListener("pointerdown", (event) => {
		if (stickPointer !== null) return;
		event.preventDefault();
		stickPointer = event.pointerId;
		try { stick.setPointerCapture(event.pointerId); } catch {}
		const box = stick.getBoundingClientRect();
		centerX = box.left + box.width / 2;
		centerY = box.top + box.height / 2;
		radius = box.width / 2;
		moveStick(event.clientX, event.clientY);
		stick.classList.add("on");
	});

	stick.addEventListener("pointermove", (event) => {
		if (event.pointerId === stickPointer) moveStick(event.clientX, event.clientY);
	});

	function endStick(event) {
		if (event.pointerId !== stickPointer) return;
		stickPointer = null;
		stick.classList.remove("on");
		nub.style.transform = "";
		setDirections({});
	}
	stick.addEventListener("pointerup", endStick);
	stick.addEventListener("pointercancel", endStick);
	stick.addEventListener("lostpointercapture", endStick);

	// --- momentary buttons ---------------------------------------------------
	function bindMomentary(element, id, makeSpec) {
		element.addEventListener("pointerdown", (event) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			event.preventDefault();
			try { element.setPointerCapture(event.pointerId); } catch {}
			element.classList.add("on");
			press(id, makeSpec());
			const done = () => {
				element.classList.remove("on");
				release(id);
				element.removeEventListener("pointerup", done);
				element.removeEventListener("pointercancel", done);
			};
			element.addEventListener("pointerup", done);
			element.addEventListener("pointercancel", done);
		});
	}

	for (const button of root.querySelectorAll("#tc-actions button")) {
		const act = button.dataset.act;
		bindMomentary(button, "btn:" + act, () => KEYS[act]);
	}

	// --- on-screen keyboard --------------------------------------------------
	const keyboard = root.querySelector("#tc-keyboard");
	const typeButton = root.querySelector("#tc-type");
	const ROWS = [
		["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
		["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
		["a", "s", "d", "f", "g", "h", "j", "k", "l"],
		["shift", "z", "x", "c", "v", "b", "n", "m", "back"],
		["space", "enter"],
	];
	const LABELS = { shift: "Shift", back: "⌫", space: "Space", enter: "Return" };

	let shift = false;
	for (const row of ROWS) {
		const rowElement = document.createElement("div");
		rowElement.className = "tc-row";
		for (const label of row) {
			const key = document.createElement("button");
			key.type = "button";
			key.className = "tc-key" + (LABELS[label] ? " wide" : "");
			key.textContent = LABELS[label] || label;
			key.dataset.key = label;
			key.setAttribute("aria-label", LABELS[label] || label);
			rowElement.append(key);
		}
		keyboard.append(rowElement);
	}

	function setShift(value) {
		shift = value;
		keyboard.classList.toggle("shift", shift);
		keyboard.querySelector('[data-key="shift"]').classList.toggle("on", shift);
		for (const key of keyboard.querySelectorAll("[data-key]")) {
			const label = key.dataset.key;
			if (/^[a-z]$/.test(label)) key.textContent = shift ? label.toUpperCase() : label;
		}
	}

	for (const key of keyboard.querySelectorAll("[data-key]")) {
		const label = key.dataset.key;
		if (label === "shift") continue; // modifier only, toggled below
		bindMomentary(key, "kb:" + label, () => {
			if (/^[0-9]$/.test(label)) return digitKey(label);
			if (/^[a-z]$/.test(label)) return letterKey(label, shift);
			return KEYS[label === "back" ? "back" : label];
		});
	}

	keyboard.querySelector('[data-key="shift"]').addEventListener("click", () => setShift(!shift));

	typeButton.addEventListener("click", () => {
		const open = keyboard.hidden;
		keyboard.hidden = !open;
		root.classList.toggle("kb-open", open);
		typeButton.classList.toggle("on", open);
		if (!open) setShift(false);
	});

	// --- fit to screen -------------------------------------------------------
	const fitButton = root.querySelector("#tc-fit");
	// Launched from the Home Screen there is no browser chrome to fit around.
	const installed = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
	if (installed) fitButton.hidden = true;
	const toastElement = root.querySelector("#tc-toast");
	let toastTimer = 0;

	function toast(message) {
		toastElement.textContent = message;
		toastElement.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => toastElement.classList.remove("show"), 3200);
	}

	async function toggleFullscreen() {
		const documentElement = document.documentElement;
		const request = documentElement.requestFullscreen || documentElement.webkitRequestFullscreen;
		const exit = document.exitFullscreen || document.webkitExitFullscreen;
		const current = document.fullscreenElement || document.webkitFullscreenElement;

		if (!request) {
			toast("This browser can't go fullscreen. Add the page to your Home Screen to play without browser bars.");
			return;
		}
		try {
			if (current) {
				await exit?.call(document);
				return;
			}
			await request.call(documentElement);
			// Landscape is the playable orientation; ignore browsers that refuse.
			try { await screen.orientation?.lock?.("landscape"); } catch {}
		} catch {
			toast("Fullscreen was blocked. Add the page to your Home Screen to play without browser bars.");
		}
	}

	fitButton.addEventListener("click", toggleFullscreen);

	const syncFullscreenButton = () => {
		fitButton.classList.toggle("on", !!(document.fullscreenElement || document.webkitFullscreenElement));
	};
	document.addEventListener("fullscreenchange", syncFullscreenButton);
	document.addEventListener("webkitfullscreenchange", syncFullscreenButton);

	// --- housekeeping --------------------------------------------------------
	window.addEventListener("blur", releaseAll);
	document.addEventListener("visibilitychange", () => {
		if (document.hidden) releaseAll();
	});
	root.addEventListener("contextmenu", (event) => event.preventDefault());
})();
