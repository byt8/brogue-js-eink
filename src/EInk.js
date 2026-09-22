/*
 *  EInk.js — e-ink rendering layer for Brogue.js
 *
 *  Sits between the game's 100x34 cell buffer and the canvas.
 *
 *  - Quantises Brogue's 0-100 colour triplets into a 4-tone, paper-first
 *    palette (#fff / #aaa / #555 / #000) so the game reads cleanly on an
 *    e-ink display without colour.
 *  - Lays the cells out in a non-uniform grid: the sidebar, message band
 *    and bottom band use compact "chrome" cells, while the dungeon map
 *    gets larger cells fitted to its own fixed pixel rectangle.
 *  - Supports paging (when zoomed) and a zoom toggle, driven by touch,
 *    on-screen controls and keyboard equivalents.
 *
 *  Everything here is presentation-only: it reads SCREEN and
 *  displayBuffer, and never mutates game state.
 */

// ---- 4-tone paper-first palette -----------------------------------------
// index 0 is the lightest (paper), index 3 the darkest (ink). Flat hex
// strings only — no alpha, no gradients, no globalAlpha — so the browser
// can never approximate a mid-tone with a dither/dot pattern.
const EINK_PALETTE = ['#ffffff', '#aaaaaa', '#555555', '#000000'];
const EINK_PAPER = EINK_PALETTE[0];
const EINK_INK = EINK_PALETTE[3];

// E-ink refresh etiquette: collapse bursts of small updates into at most
// one paint per window (fewer flashes, less ghosting). 0 disables it.
const EINK_REFRESH_MS = 120;

// Posterise the finished canvas to the exact 4 palette levels. Canvas
// fillText antialiases glyph edges into off-palette greys; snapping every
// pixel back to the nearest tone guarantees a clean, zero-dither frame.
const EINK_POSTERISE = true;

// Map zoom: 1 = fit the whole level, 1.5 = paged view.
const EINK_ZOOM_FACTOR = 1.5;

// Cell aspect ratios (height = width * aspect). Chrome rows are tighter;
// map rows are taller so glyphs are bigger where they matter.
const EINK_CHROME_ASPECT = 1.5;
const EINK_MAP_ASPECT = 2.0;

// Font height is capped to a sane multiple of cell width so glyphs never
// overflow horizontally in narrow cells.
const EINK_FONT_ASPECT = 1.6;

// Region landmarks in window-cell coordinates (mirrors Rogue.js).
const EINK_MAP_X0 = STAT_BAR_WIDTH + 1;       // 21 — first map column
const EINK_MAP_Y0 = MESSAGE_LINES;            //  3 — first map row
const EINK_MAP_W = DCOLS;                     // 79 map columns
const EINK_MAP_H = DROWS;                     // 29 map rows
const EINK_CHROME_BOTTOM_ROWS = 2;            // flavor text + menu bar
const EINK_CHROME_ROW_COUNT = EINK_MAP_Y0 + EINK_CHROME_BOTTOM_ROWS; // 5


// ---- colour quantisation ------------------------------------------------

// Luma of a 0-100 colour triple, in [0, 1].
function einkLuma(r, g, b) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 100;
}

// 0-100 colour triple -> tone index 0..3 (0 = paper, 3 = ink).
// The S-curve is paper-first (bright -> ink) and stretches the mid-tones
// apart so the two grey steps carry most of the remaining information.
function einkTone(r, g, b) {
    const L = einkLuma(r, g, b);
    const Lp = Math.max(0, Math.min(1, (L - 0.12) / 0.72));
    if (Lp < 0.18) return 0;
    if (Lp < 0.50) return 1;
    if (Lp < 0.82) return 2;
    return 3;
}

// tone index -> css color string
function einkToneColor(tone) {
    return EINK_PALETTE[tone] || EINK_INK;
}

// 0-100 colour triple -> css color string
function einkCss(r, g, b) {
    return einkToneColor(einkTone(r, g, b));
}

// Legibility guard: when foreground and background quantise to the same
// tone but there is a real glyph, push the ink one step away from the
// paper so the two-tone distinctions that survive quantisation stay
// visible.
function einkGuard(fgTone, bgTone, char) {
    if (fgTone === bgTone && char && char !== ' ') {
        if (bgTone >= 2) return Math.max(0, fgTone - 1);
        return Math.min(3, fgTone + 1);
    }
    return fgTone;
}

// Post-paint pass: read the whole canvas and snap every pixel to the
// nearest of the 4 palette levels (#fff / #aaa / #555 / #000). This removes
// the anti-aliased fringes canvas text rendering leaves at glyph edges, so
// the frame contains exactly four colours and nothing else.
function einkPosterise() {
    if (!EINK_POSTERISE) return;
    const s = SCREEN;
    const w = s.canvas.width, h = s.canvas.height;
    if (!w || !h) return;
    const img = s.ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue; // leave fully-transparent pixels alone
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        let v;
        if (l < 42.5)      v = 0;    // #000
        else if (l < 127.5) v = 85;   // #555
        else if (l < 212.5) v = 170;  // #aaa
        else               v = 255;  // #fff
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = 255;
    }
    s.ctx.putImageData(img, 0, 0);
}


// ---- region-aware geometry ----------------------------------------------

// True for the dungeon map cells (columns 21..99, rows 3..31).
function einkIsMapCell(x, y) {
    return x >= EINK_MAP_X0 && x < EINK_MAP_X0 + EINK_MAP_W
        && y >= EINK_MAP_Y0 && y < EINK_MAP_Y0 + EINK_MAP_H;
}

// Actual rendered height of the map band (CSS px). At zoom 1 this equals the
// allocated region; when zoomed in, fewer, larger rows are visible and the
// chrome below sits flush under the last visible row.
function einkMapBandHeight() {
    return SCREEN.mapVisibleRows * SCREEN.cellH_map;
}

// Single source of truth: window cell -> pixel rectangle (CSS px).
// Returns null for map cells that are paged out of view.
function cellRect(x, y) {
    const s = SCREEN;

    if (einkIsMapCell(x, y)) {
        const vx = (x - EINK_MAP_X0) - s.page.x;
        const vy = (y - EINK_MAP_Y0) - s.page.y;
        if (vx < 0 || vx >= s.mapVisibleCols || vy < 0 || vy >= s.mapVisibleRows) {
            return null; // off the visible page
        }
        return {
            x: EINK_MAP_X0 * s.cellW_chrome + vx * s.cellW_map,
            y: EINK_MAP_Y0 * s.cellH_chrome + vy * s.cellH_map,
            w: s.cellW_map,
            h: s.cellH_map
        };
    }

    // Chrome cell: uniform horizontal width; three vertical bands
    // (message band / map band / bottom band), all chrome-height.
    const px = x * s.cellW_chrome;
    let py;
    if (y < EINK_MAP_Y0) {
        py = y * s.cellH_chrome;
    } else {
        py = EINK_MAP_Y0 * s.cellH_chrome
           + einkMapBandHeight()
           + (y - EINK_MAP_Y0 - EINK_MAP_H) * s.cellH_chrome;
    }
    return { x: px, y: py, w: s.cellW_chrome, h: s.cellH_chrome };
}

// Inverse of cellRect: canvas pixel (CSS px) -> window cell, or null.
function cellAtPixel(px, py) {
    const s = SCREEN;

    const topBand = EINK_MAP_Y0 * s.cellH_chrome;
    const mapBand = einkMapBandHeight();
    const sidebarW = EINK_MAP_X0 * s.cellW_chrome;

    let x, y;

    // Raw row (before paging).
    if (py < topBand) {
        y = Math.floor(py / s.cellH_chrome);
    } else if (py < topBand + mapBand) {
        const local = Math.floor((py - topBand) / s.cellH_map);
        y = EINK_MAP_Y0 + Math.max(0, Math.min(s.mapVisibleRows - 1, local));
    } else {
        y = EINK_MAP_Y0 + EINK_MAP_H
          + Math.floor((py - topBand - mapBand) / s.cellH_chrome);
    }

    // Raw column (before paging).
    if (px < sidebarW) {
        x = Math.floor(px / s.cellW_chrome);
    } else {
        const local = Math.floor((px - sidebarW) / s.cellW_map);
        x = EINK_MAP_X0 + Math.max(0, Math.min(s.mapVisibleCols - 1, local));
    }

    // Apply the page offset only to genuine map cells.
    if (x >= EINK_MAP_X0 && x < EINK_MAP_X0 + EINK_MAP_W
        && y >= EINK_MAP_Y0 && y < EINK_MAP_Y0 + EINK_MAP_H) {
        x += s.page.x;
        y += s.page.y;
    }

    x = Math.max(0, Math.min(COLS - 1, x));
    y = Math.max(0, Math.min(ROWS - 1, y));
    return { x: x, y: y };
}

// Font size (CSS px) for a given window cell, capped to the cell width.
function einkFontPxFor(x, y) {
    const s = SCREEN;
    const w = einkIsMapCell(x, y) ? s.cellW_map : s.cellW_chrome;
    const h = einkIsMapCell(x, y) ? s.cellH_map : s.cellH_chrome;
    return Math.max(4, Math.floor(Math.min(h, w * EINK_FONT_ASPECT)));
}

// Set the canvas font only when it actually changes (cheap per-cell).
function einkUseFont(px) {
    const ctx = SCREEN.ctx;
    const key = px + '|' + SCREEN.font;
    if (SCREEN._fontKey !== key) {
        SCREEN._fontKey = key;
        ctx.font = Math.round(px * SCREEN.devicePixelRatio) + 'px ' + SCREEN.font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
    }
}


// ---- layout / paging / zoom ---------------------------------------------

// Recompute map cell sizes and visible page from the current zoom level.
function einkApplyMapZoom(s) {
    s.cellW_map = Math.max(1, Math.round(s.cellW_chrome * s.mapZoom));
    s.cellH_map = Math.max(1, Math.round(s.cellH_map_base * s.mapZoom));

    const regionW = EINK_MAP_W * s.cellW_chrome;
    const regionH = EINK_MAP_H * s.cellH_map_base;
    s.mapVisibleCols = Math.max(1, Math.min(EINK_MAP_W, Math.floor(regionW / s.cellW_map)));
    s.mapVisibleRows = Math.max(1, Math.min(EINK_MAP_H, Math.floor(regionH / s.cellH_map)));

    const maxX = Math.max(0, EINK_MAP_W - s.mapVisibleCols);
    const maxY = Math.max(0, EINK_MAP_H - s.mapVisibleRows);
    s.page.x = Math.max(0, Math.min(s.page.x, maxX));
    s.page.y = Math.max(0, Math.min(s.page.y, maxY));
}

function einkRequestFullRedraw() {
    if (!SCREEN) return;
    for (let i = 0; i < COLS; i++) {
        for (let j = 0; j < ROWS; j++) {
            displayBuffer[i][j].needsUpdate = true;
        }
    }
}

function einkPageBy(dx, dy) {
    if (!SCREEN) return;
    const maxX = Math.max(0, EINK_MAP_W - SCREEN.mapVisibleCols);
    const maxY = Math.max(0, EINK_MAP_H - SCREEN.mapVisibleRows);
    SCREEN.page.x = Math.max(0, Math.min(maxX, SCREEN.page.x + dx));
    SCREEN.page.y = Math.max(0, Math.min(maxY, SCREEN.page.y + dy));
    einkRequestFullRedraw();
}

function einkPageStepX() {
    return SCREEN ? Math.max(1, Math.floor(SCREEN.mapVisibleCols / 2)) : 1;
}

function einkPageStepY() {
    return SCREEN ? Math.max(1, Math.floor(SCREEN.mapVisibleRows / 2)) : 1;
}

function einkToggleZoom() {
    if (!SCREEN) return;
    SCREEN.mapZoom = (SCREEN.mapZoom === 1) ? EINK_ZOOM_FACTOR : 1;
    einkApplyMapZoom(SCREEN);
    einkCenterPageOnPlayer();
    einkRequestFullRedraw();
}

// Center the page on the player, clamped to the level bounds.
function einkCenterPageOnPlayer() {
    if (!SCREEN || !player) return;
    const vc = SCREEN.mapVisibleCols, vr = SCREEN.mapVisibleRows;
    const maxX = Math.max(0, EINK_MAP_W - vc);
    const maxY = Math.max(0, EINK_MAP_H - vr);
    SCREEN.page.x = Math.max(0, Math.min(maxX, Math.floor(player.xLoc - vc / 2)));
    SCREEN.page.y = Math.max(0, Math.min(maxY, Math.floor(player.yLoc - vr / 2)));
}

// Minimal adjustment so the player never walks off the visible page.
// A no-op at zoom 1 (the whole level is visible).
function einkKeepPlayerVisible() {
    if (!SCREEN || !player || SCREEN.mapZoom === 1) return;
    const vc = SCREEN.mapVisibleCols, vr = SCREEN.mapVisibleRows;
    const maxX = Math.max(0, EINK_MAP_W - vc);
    const maxY = Math.max(0, EINK_MAP_H - vr);
    const m = 1;
    let nx = SCREEN.page.x, ny = SCREEN.page.y;
    if (player.xLoc < nx + m) nx = Math.max(0, player.xLoc - m);
    else if (player.xLoc >= nx + vc - m) nx = Math.min(maxX, player.xLoc - vc + m + 1);
    if (player.yLoc < ny + m) ny = Math.max(0, player.yLoc - m);
    else if (player.yLoc >= ny + vr - m) ny = Math.min(maxY, player.yLoc - vr + m + 1);
    if (nx !== SCREEN.page.x || ny !== SCREEN.page.y) {
        SCREEN.page.x = nx;
        SCREEN.page.y = ny;
        einkRequestFullRedraw();
    }
}


// ---- on-screen controls --------------------------------------------------

// Paper squares with ink borders, drawn in the bottom-right corner over
// the menu bar. Five buttons: left / up / down / right / zoom.
function einkDrawControls() {
    const s = SCREEN;
    const ctx = s.ctx;
    const dpr = s.devicePixelRatio || 1;
    const cssW = s.canvas.width / dpr;
    const cssH = s.canvas.height / dpr;

    const btn = Math.max(30, Math.round(s.cellH_chrome * 1.4));
    const gap = Math.max(4, Math.round(btn * 0.2));
    const margin = Math.max(6, Math.round(btn * 0.3));
    const count = 5;
    const totalW = count * btn + (count - 1) * gap;
    const x0 = cssW - margin - totalW;
    const y0 = cssH - margin - btn;

    const buttons = [
        { type: 'left' },
        { type: 'up' },
        { type: 'down' },
        { type: 'right' },
        { type: 'zoom', label: (s.mapZoom === 1 ? '1x' : '1.5x') }
    ];

    s._controls = [];
    for (let i = 0; i < count; i++) {
        const bx = x0 + i * (btn + gap);
        einkDrawButton(ctx, bx, y0, btn, buttons[i], dpr);
        s._controls.push({ x: bx, y: y0, w: btn, h: btn, action: buttons[i].type });
    }
}

function einkDrawButton(ctx, bx, by, btn, spec, dpr) {
    ctx.fillStyle = EINK_PAPER;
    ctx.fillRect(bx * dpr, by * dpr, btn * dpr, btn * dpr);
    ctx.strokeStyle = EINK_INK;
    ctx.lineWidth = Math.max(1, Math.round(2 * dpr));
    ctx.strokeRect(bx * dpr, by * dpr, btn * dpr, btn * dpr);

    if (spec.type === 'zoom') {
        ctx.fillStyle = EINK_INK;
        einkUseFont(Math.floor(btn * 0.42));
        ctx.fillText(spec.label, (bx + btn / 2) * dpr, (by + btn / 2) * dpr);
        return;
    }

    const cx = (bx + btn / 2) * dpr;
    const cy = (by + btn / 2) * dpr;
    const r = btn * 0.26 * dpr;
    ctx.fillStyle = EINK_INK;
    ctx.beginPath();
    if (spec.type === 'up') {
        ctx.moveTo(cx, cy - r); ctx.lineTo(cx - r, cy + r); ctx.lineTo(cx + r, cy + r);
    } else if (spec.type === 'down') {
        ctx.moveTo(cx, cy + r); ctx.lineTo(cx - r, cy - r); ctx.lineTo(cx + r, cy - r);
    } else if (spec.type === 'left') {
        ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy - r); ctx.lineTo(cx + r, cy + r);
    } else { // right
        ctx.moveTo(cx + r, cy); ctx.lineTo(cx - r, cy - r); ctx.lineTo(cx - r, cy + r);
    }
    ctx.closePath();
    ctx.fill();
}

function einkControlAt(px, py) {
    const s = SCREEN;
    if (!s || !s._controls) return null;
    for (let i = 0; i < s._controls.length; i++) {
        const c = s._controls[i];
        if (px >= c.x && px < c.x + c.w && py >= c.y && py < c.y + c.h) return c;
    }
    return null;
}

// Returns true if the tap landed on an on-screen control (and handled it).
function einkHandleControlTap(px, py) {
    const c = einkControlAt(px, py);
    if (!c) return false;
    if (c.action === 'zoom') {
        einkToggleZoom();
    } else if (c.action === 'left') {
        einkPageBy(-einkPageStepX(), 0);
    } else if (c.action === 'right') {
        einkPageBy(einkPageStepX(), 0);
    } else if (c.action === 'up') {
        einkPageBy(0, -einkPageStepY());
    } else if (c.action === 'down') {
        einkPageBy(0, einkPageStepY());
    }
    return true;
}


// ---- touch helpers (wired up by Platform.launch) ------------------------

function einkHandleTouchStart(e) {
    if (e.cancelable) e.preventDefault();
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    einkDispatchTap(t.clientX, t.clientY);
}

function einkHandleTouchEnd(e) {
    if (e.cancelable) e.preventDefault();
}

function einkDispatchTap(clientX, clientY) {
    if (!SCREEN) return;
    const rect = SCREEN.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    if (einkHandleControlTap(px, py)) return;

    const cell = cellAtPixel(px, py);
    const time = performance.now();
    let theEvent = rogueEvent(MOUSE_DOWN, cell.x, cell.y);
    theEvent.time = time;
    SCREEN.inputHandler(theEvent);
    theEvent = rogueEvent(MOUSE_UP, cell.x, cell.y);
    theEvent.time = time;
    SCREEN.inputHandler(theEvent);
}
