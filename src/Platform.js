

var SCREEN = null;


function fillBg(css) {
    SCREEN.ctx.fillStyle = css || EINK_PAPER;
    SCREEN.ctx.fillRect(
        0,
        0,
        SCREEN.canvas.width,
        SCREEN.canvas.height
    );
}


function plotChar(char, x, y, fr, fg, fb, br, bg, bb) {
  const rect = cellRect(x, y);
  if (!rect) return; // map cell is paged out of view

  const ctx = SCREEN.ctx;
  const dpr = SCREEN.devicePixelRatio;

  // One decision for tone pair and typography: UI copy is set in ink or
  // inverted, at a weight that stands in for Brogue's colour hierarchy.
  const style = einkCellStyle(x, y, fr, fg, fb, br, bg, bb, char);

  ctx.fillStyle = einkToneColor(style.bgTone);
  ctx.fillRect(
    rect.x * dpr,
    rect.y * dpr,
    rect.w * dpr,
    rect.h * dpr
  );

  if (char && char !== ' ') {
    einkUseFont(einkFontPxFor(x, y), style.bold, style.italic);
    ctx.fillStyle = einkToneColor(style.fgTone);
    // Snap glyphs to integer device pixels to minimise anti-aliased fringes.
    const tx = Math.round((rect.x + rect.w * 0.5) * dpr);
    const ty = Math.round((rect.y + rect.h * 0.5) * dpr);
    ctx.fillText(char, tx, ty);
    if (style.underline) {
      einkDrawUnderline(rect, style.fgTone, dpr);
    }
  }
}


function setFont(size, name) {
  // Font size is derived per region (see einkFontPxFor); we only keep the
  // face name here and reset the per-cell font cache.
  SCREEN.font = name || SCREEN.font || 'monospace';
  SCREEN._fontKey = null;
  SCREEN.ctx.textAlign = 'center';
  SCREEN.ctx.textBaseline = 'middle';
}

var EVENTS_QUEUE = [];

async function handleEvents(handler) {
  let resolveFn = null;

  _pushHandler( (theEvent) => {
    handler(theEvent, (result) => {
      _popHandler();
      resolveFn(result);
    });
  });

  return new Promise( (resolve, reject) => {
    resolveFn = resolve;
  });
}

function _pushHandler(handler) {
  SCREEN.handlerStack.push(this.inputHandler);
  SCREEN.inputHandler = handler;
}

function _popHandler(theEvent) {
  SCREEN.inputHandler = SCREEN.handlerStack.pop() || handleSilentEvent;
  if (theEvent) {
    SCREEN.inputHandler(theEvent);
  }
}

function handleSilentEvent(theEvent) {
  if (EVENTS_QUEUE.length) {
    const lastEvent = EVENTS_QUEUE[EVENTS_QUEUE.length - 1];
    if (lastEvent.eventType === MOUSE_ENTERED_CELL) {
      lastEvent.copy(theEvent);
      return;
    }
  }
  EVENTS_QUEUE.push(theEvent);
}

let _lastPaint = 0;

function animationTimer(t) {
  requestAnimationFrame(animationTimer);

  if (!SCREEN) return;

  // Keep the player on screen when the map is zoomed.
  einkKeepPlayerVisible();

  // Coalesce bursts of small updates into at most one paint per window
  // (fewer full-screen refreshes on e-ink).
  if (EINK_REFRESH_MS > 0 && (t - _lastPaint) < EINK_REFRESH_MS) {
    return;
  }

  let i, j, didPaint = false;

  for (i=0; i<COLS; i++) {
  	for (j=0; j<ROWS; j++) {
  		if (displayBuffer[i][j].needsUpdate) {
  			plotChar(displayBuffer[i][j].char, i, j,
  					 displayBuffer[i][j].foreColorComponents[0],
  					 displayBuffer[i][j].foreColorComponents[1],
  					 displayBuffer[i][j].foreColorComponents[2],
  					 displayBuffer[i][j].backColorComponents[0],
  					 displayBuffer[i][j].backColorComponents[1],
  					 displayBuffer[i][j].backColorComponents[2]);
  			displayBuffer[i][j].needsUpdate = false;
  			didPaint = true;
  		}
  	}
  }

  if (didPaint) {
    _lastPaint = t;
    einkDrawControls();
    einkPosterise();
  }
}


// ---- keyboard input ------------------------------------------------------
//
// On a desktop the OS delivers a keypress to whatever has focus (the body by
// default) and it bubbles to the document, so the game hears it even though
// the page holds nothing focusable.  Android is different in two ways:
//
//   1. no soft keyboard ever appears unless an *editable* element has focus,
//      and the canvas cannot be focused, so there is nothing to type into;
//   2. once a keyboard is up, the IME reports keydown with key "Unidentified"
//      (keyCode 229) and hands the actual character over in the `input` event
//      instead, so keydown alone would swallow every letter.
//
// So index.html carries a 1px transparent <input id="keysink">.  Touch input
// focuses it (see EInk.einkHandleTouchStart), which raises the soft keyboard,
// and both the keydown and the input events it produces are translated into
// the same KEYSTROKE events the rest of the game already understands.
var KBD_SOFT = false;   // last keydown was an IME placeholder; input carries the text
var KBD_SOFT_SHIFT = false;  // ...and whether the keyboard thought shift was down
var KBD_SINK = null;    // the <input>, wired up in launch()
var KBD_SEEN_HEIGHT = 0;   // tallest viewport seen (i.e. with no keyboard up)

function dispatchKeystroke(key, ctrlKey, shiftKey, metaKey) {
  if (!SCREEN) {
    console.log('keypress', key);
    return;
  }
  SCREEN.ctrlKey = !!ctrlKey;
  SCREEN.shiftKey = !!shiftKey;
  SCREEN.metaKey = !!metaKey;

  const theEvent = rogueEvent(KEYSTROKE, key, null, !!ctrlKey, !!shiftKey);
  theEvent.time = performance.now();
  SCREEN.inputHandler(theEvent);
}

function handleKeyDownEvent(event) {
  // An IME keydown carries no usable key.  Leave it strictly alone: calling
  // preventDefault() here cancels the character, and the character is exactly
  // what the following input event is about to deliver to us.
  if (event.isComposing || event.keyCode === 229
      || event.key === 'Unidentified' || event.key === 'Process') {
    KBD_SOFT = true;
    KBD_SOFT_SHIFT = !!event.shiftKey;
    return;
  }
  KBD_SOFT = false;
  KBD_SOFT_SHIFT = false;

  let key = event.key;
  if(['Ctrl', 'Alt', 'Meta', 'Shift'].includes(key)) {
      key = event.code;
  }
  else {
    if (event.shiftKey) {
      key = key.toUpperCase();
    }
    if (event.metaKey) {
      key = '#' + key;
    }
    if (event.ctrlKey) {
      key = '^' + key;
    }
  }

  if (event.key === 'Escape' && EVENTS_QUEUE.length) {
    EVENTS_QUEUE.length = 0;
    console.log('Cleared Events queue.');
  }

  dispatchKeystroke(key, event.ctrlKey, event.shiftKey, event.metaKey);
  event.preventDefault();
  return false;
}

// Characters produced by the soft keyboard.  Only honoured when the keydown
// that preceded them was the IME's placeholder (KBD_SOFT), so a physical
// keyboard -- which is already handled in keydown -- cannot double-fire.
function handleKeyInputEvent(event) {
  const sink = event.target;
  const data = event.data || '';
  const fromSoftKeyboard = KBD_SOFT;
  const shift = KBD_SOFT_SHIFT;
  KBD_SOFT = false;
  KBD_SOFT_SHIFT = false;

  // Keep the sink empty: the character has been read, and a stale value would
  // let the IME's next send be appended to it.
  if (sink && sink.value) {
    sink.value = '';
  }

  // Keys an IME cannot express as text arrive here instead, with no
  // character attached: Enter comes as insertLineBreak, backspace as
  // deleteContentBackward.  (When the keyboard does send a real keydown for
  // them, KBD_SOFT is already false and they were handled there.)
  if (fromSoftKeyboard && !data) {
    if (event.inputType === 'deleteContentBackward') {
      dispatchKeystroke(BACKSPACE_KEY, false, false, false);
      return;
    }
    if (event.inputType === 'insertLineBreak') {
      dispatchKeystroke(RETURN_KEY, false, false, false);
      return;
    }
  }

  if (!fromSoftKeyboard || !data) return;

  for (const ch of data) {
    // Some IMEs capitalise the first letter of "sentences" of their own
    // accord; an unasked-for 'J' is the run command, an 'A' is autoplay.
    // Only honour a capital letter when shift was really down.
    let key = (ch >= 'A' && ch <= 'Z' && !shift) ? ch.toLowerCase() : ch;
    if (key === '\n' || key === '\r') {
      key = RETURN_KEY;
    }
    dispatchKeystroke(key, false, shift, false);
  }
}

function handleKeyUpEvent(event) {
  if (SCREEN) {
    SCREEN.ctrlKey = event.ctrlKey;
    SCREEN.metaKey = event.metaKey;
    SCREEN.shiftKey = event.shiftKey;
  }
  event.preventDefault();
}


// ---- raising the soft keyboard -------------------------------------------

// True when the keyboard looks closed.  The visual viewport shrinks while an
// IME is on screen, so the tallest viewport we have ever seen is our "no
// keyboard" ruler (this holds whether or not the page asks the browser to
// resize the layout viewport for the keyboard).
function einkKeyboardLooksClosed() {
  const vv = window.visualViewport;
  const h = Math.round(vv ? vv.height : window.innerHeight);
  if (h > KBD_SEEN_HEIGHT) KBD_SEEN_HEIGHT = h;
  return (KBD_SEEN_HEIGHT - h) <= 120;
}

// Show the soft keyboard.  Browsers only allow this from inside a real user
// gesture, so the touch handlers call it straight from the touch event.
// Android keeps the sink focused when the IME is dismissed with the back
// gesture, and focus() alone will not bring it back -- a blur/re-focus will.
// (Throttled, so a tap on an already-open keyboard is a no-op rather than a
// flicker.)  On a desktop this is never called.
var KBD_LAST_RAISE = 0;

function einkFocusKeyboard() {
  const sink = KBD_SINK;
  if (!sink) return;
  if (document.activeElement !== sink) {
    KBD_LAST_RAISE = performance.now();
    try {
      sink.focus({ preventScroll: true });
    } catch (err) {
      sink.focus();
    }
    return;
  }
  const now = performance.now();
  if ((now - KBD_LAST_RAISE) < 500 || !einkKeyboardLooksClosed()) return;
  KBD_LAST_RAISE = now;
  sink.blur();
  try {
    sink.focus({ preventScroll: true });
  } catch (err) {
    sink.focus();
  }
}


function handleMouseEvent(e) {
  if (!SCREEN) {
    console.log(e.type, e.clientX, e.clientY);
    return;
  }

  if (e.type === 'mouseleave') {
    return;
  }

  const rect = SCREEN.canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;

  if (e.type === 'click') {
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
  else {
    const cell = cellAtPixel(px, py);
    let theEvent = rogueEvent(MOUSE_ENTERED_CELL, cell.x, cell.y);
    theEvent.time = performance.now();
    SCREEN.inputHandler(theEvent);
  }
}

function handleResizeEvent() {

  const W = window.innerWidth;
  const H = window.innerHeight;
  const s = SCREEN;

  // ---- non-uniform, region-aware layout -------------------------------
  // Uniform horizontal unit: 100 columns across the full width.
  s.cellW_chrome = Math.max(1, Math.floor(W / COLS));

  // Chrome rows are tighter than map rows; scale both proportionally so
  // the layout fills the window height.
  const chromeH = Math.max(1, Math.floor(s.cellW_chrome * EINK_CHROME_ASPECT));
  const mapH = Math.max(1, Math.floor(s.cellW_chrome * EINK_MAP_ASPECT));
  const idealH = EINK_CHROME_ROW_COUNT * chromeH + EINK_MAP_H * mapH;
  const scale = H / idealH;

  s.cellH_chrome = Math.max(s.cellW_chrome, Math.floor(chromeH * scale));
  s.cellH_map_base = Math.max(s.cellW_chrome, Math.floor(mapH * scale));

  s.mapZoom = s.mapZoom || 1;
  s.page = s.page || { x: 0, y: 0 };
  einkApplyMapZoom(s);
  einkCenterPageOnPlayer();

  // ---- canvas backing store (device-pixel crisp, CSS-sized) ------------
  const devicePixelRatio = window.devicePixelRatio || 1;
  s.devicePixelRatio = devicePixelRatio;
  s.canvas.width = Math.floor(W * devicePixelRatio);
  s.canvas.height = Math.floor(H * devicePixelRatio);
  s.canvas.style.width = W + 'px';
  s.canvas.style.height = H + 'px';

  setFont(s.cellH_chrome, s.font);
  fillBg(EINK_PAPER);

  einkRequestFullRedraw();

}


async function pauseForMilliseconds( milliseconds, wantMouseMoves ) {

  while (EVENTS_QUEUE.length) {
    if (wantMouseMoves || (EVENTS_QUEUE[0].eventType != MOUSE_ENTERED_CELL) ) {
		    return true;  // interrupted
    }
    EVENTS_QUEUE.shift();
	}

	let resolveFn = null;
	let timeout = null;
	let interrupted = false;

	function complete() {
		_popHandler();
		if (interrupted) {
			clearTimeout(timeout);
		}
		resolveFn(interrupted || false);
	}

	timeout = setTimeout( complete, milliseconds );

	handleEvents( (e) => {
		if (e.eventType !== UPDATE && (wantMouseMoves || (e.eventType !== MOUSE_ENTERED_CELL)) ) {
			interrupted = true;
      EVENTS_QUEUE.push(e.clone()); // save the event
			complete();
		}
	});

	const p = new Promise( (resolve) => {
		resolveFn = resolve;
	});

	await p;

	return interrupted;
}


async function nextKeyOrMouseEvent(returnEvent, textInput, colorsDance) {

	let finished = false;

	if (EVENTS_QUEUE.length) {
		const e = EVENTS_QUEUE.shift();
		returnEvent.copy(e);
		return;
	}

	await handleEvents( (theEvent, done) => {
		if (theEvent.eventType === UPDATE) {
			if (colorsDance) {
				shuffleTerrainColors(3, true);
			}
			return;
		}

		if (finished) {
			// console.log('I need to queue this one!', theEvent.eventType);
			if (EVENTS_QUEUE.length) {
				const e = EVENTS_QUEUE[EVENTS_QUEUE.length - 1];	// last one
				if (e.eventType === theEvent.eventType && theEvent.eventType === MOUSE_ENTERED_CELL) {
					e.copy(theEvent);
					return;
				}
			}
			EVENTS_QUEUE.push(theEvent.clone());
			return;
		}
		// console.log('nextKeyOrMouseEvent', theEvent.eventType);
		finished = true;
		returnEvent.copy(theEvent);
		done();
	});

}

function controlKeyIsDown() {
  return SCREEN && SCREEN.ctrlKey;
}

var HIGH_SCORE_LIST = [];

function getHighScoresList( returnList /* rogueHighScoresEntry[HIGH_SCORES_COUNT] */) {
	let i, mostRecentLineNumber = 0;

  returnList.forEach( (e) => e.clear() );

  HIGH_SCORE_LIST.forEach( (e, i) => {
    if (i < returnList.length) {
      returnList[i].copy(e);
    }
  });

	return 0; // ??? mostRecentLineNumber;
}

function saveHighScore(entry) {
  const copy = Object.assign({}, entry);
  HIGH_SCORE_LIST.push(copy);
  HIGH_SCORE_LIST.sort((a, b) => b.score - a.score);
  return HIGH_SCORE_LIST.length;
}


function notifyEvent(/* short */ eventId, /* int */ data1, /* int */ data2, str1, str2) {
	// TODO - ????
}


async function launch() {

  document.addEventListener('keydown', handleKeyDownEvent);
  document.addEventListener('keyup', handleKeyUpEvent);
  window.addEventListener('resize', handleResizeEvent);

  // Soft-keyboard sink (see the keyboard section above).  Its keydown/keyup
  // bubble to the document listeners already registered, so only the input
  // event -- which no physical keyboard needs -- is wired here.
  const keySink = document.getElementById('keysink');
  if (keySink) {
    KBD_SINK = keySink;
    keySink.addEventListener('input', handleKeyInputEvent);
  }

  const canvas = document.getElementById('game');
  canvas.addEventListener('mousemove', handleMouseEvent);
  canvas.addEventListener('mouseenter', handleMouseEvent);
  canvas.addEventListener('mouseleave', handleMouseEvent);
  canvas.addEventListener('click', handleMouseEvent);
  canvas.addEventListener('touchstart', einkHandleTouchStart, { passive: false });
  canvas.addEventListener('touchend', einkHandleTouchEnd, { passive: false });

  SCREEN = {
    canvas,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
    ctx: canvas.getContext('2d'),
    inputHandler: handleSilentEvent,
    handlerStack: [],
    font: 'monospace',
    devicePixelRatio: window.devicePixelRatio,
    // e-ink layout state (see EInk.js)
    cellW_chrome: 8,
    cellH_chrome: 16,
    cellH_map_base: 16,
    cellW_map: 8,
    cellH_map: 16,
    mapZoom: 1,
    mapVisibleCols: EINK_MAP_W,
    mapVisibleRows: EINK_MAP_H,
    page: { x: 0, y: 0 },
    _controls: null,
    _fontKey: null
  }

  // E-ink crispness: no smoothing/interpolation on the backing store.
  SCREEN.ctx.imageSmoothingEnabled = false;

  handleResizeEvent();
  requestAnimationFrame( animationTimer );

  await mainBrogueJunction();
}



window.onload = function() {
  // RL.Game.start(gameConfig);
  setTimeout( launch, 0 );
};




class BrogueString {
	constructor(value) {
  	this.text = value || '';
    this._textLength = -1;
  }

  get fullLength() { return this.text.length; }

  get length() {
    throw new Error('Convert to fullLength or textLength');
  }

  get textLength() {
    if (this._textLength > -1) return this._textLength;

		let length = 0;

  	for(let i = 0; i < this.text.length; ++i) {
    	const ch = this.text.charCodeAt(i);
      if (ch === COLOR_ESCAPE) {
          i += 3;	// skip color parts
      }
      else if (ch === COLOR_END) {
      		// skip
      }
      else {
      	++length;
      }
    }

		this._textLength = length;
    return this._textLength;
  }

  eachChar(callback) {
  	let color = null;
    const components = [100, 100, 100];
    let index = 0;

  	for(let i = 0; i < this.text.length; ++i) {
    	const ch = this.text.charCodeAt(i);
      if (ch === COLOR_ESCAPE) {
          components[0] = this.text.charCodeAt(i + 1) - COLOR_VALUE_INTERCEPT;
          components[1] = this.text.charCodeAt(i + 2) - COLOR_VALUE_INTERCEPT;
          components[2] = this.text.charCodeAt(i + 3) - COLOR_VALUE_INTERCEPT;
          color = colorFromComponents(components);
          i += 3;
      }
      else if (ch === COLOR_END) {
      	color = null;
      }
      else {
      	callback(this.text[i], color, index);
      	++index;
      }
    }

  }

  encodeColor(color, i) {
    let colorText;
  	if (!color) {
    	colorText = String.fromCharCode(COLOR_END);
    }
    else {
	  	colorText = String.fromCharCode(COLOR_ESCAPE, color.red + COLOR_VALUE_INTERCEPT, color.green + COLOR_VALUE_INTERCEPT, color.blue + COLOR_VALUE_INTERCEPT);
    }
    if (i == 0) {
      this.text = colorText;
    }
    else if (i < this.text.length) {
      this.splice(i, 4, colorText);
    }
    else {
      this.text += colorText;
    }
    return this;
  }

  setText(value) {
  	if (value instanceof BrogueString) {
    	this.text = value.text;
      this._textLength = value._textLength;
      return this;
    }

		this.text = value;
    this._textLength = -1;
    return this;
  }

  append(value) {
  	if (value instanceof BrogueString) {
    	this.text += value.text;
      this._textLength += value._textLength;
      return this;
    }

		this.text += value;
    this._textLength = -1;
    return this;
  }

	clear() {
  	this.text = '';
    this._textLength = 0;
    return this;
  }

  capitalize() {
  	if (!this.text.length) return;

    let index = 0;
    let ch = this.text.charCodeAt(index);
    while (ch === COLOR_ESCAPE) {
    	index += 4;
      ch = this.text.charCodeAt(index);
    }

		const preText = index ? this.text.substring(0, index) : '';
    this.text = preText + this.text[index].toUpperCase() + this.text.substring(index + 1);
		return this;
  }

	padStart(finalLength) {
		const diff = (finalLength - this.textLength);
		if (diff <= 0) return this;
		this.text = this.text.padStart(diff + this.text.length, ' ');
		this._textLength += diff;
		return this;
	}

	padEnd(finalLength) {
		const diff = (finalLength - this.textLength);
		if (diff <= 0) return this;
		this.text = this.text.padEnd(diff + this.text.length, ' ');
		this._textLength += diff;
		return this;
	}

	toString() {
		return this.text;
	}

	charAt(index) {
		return this.text.charAt(index);
	}

	charCodeAt(index) {
		return this.text.charCodeAt(index);
	}

	copy(other) {
		this.text = other.text;
		this._textLength = other._textLength;
		return this;
	}

	splice(begin, length, add) {
  	const preText = this.text.substring(0, begin);
    const postText = this.text.substring(begin + length);
		add = (add && add.text) ? add.text : (add || '');

    this.text = preText + add + postText;
    this._textLength = -1;
  }

  toString() {
    return this.text;
  }

}


// return a new string object
function STRING(text) {
	if (text instanceof BrogueString) return text;
	return new BrogueString(text);
}

function strlen(bstring) {
  if (!bstring) return 0;
  if (typeof bstring === 'string') return bstring.length;
	return bstring.fullLength;
}

function strcat(bstring, txt) {
	bstring.append(txt);
}

function strncat(bstring, txt, n) {
	txt = STRING(txt);
	bstring.append(txt.text.substring(0, n));
}

function sprintf(bstring, fmt, ...args) {

  const map = FORMAT_MAP;

  var replacer = function replacer(match, group1, group2, index) {
    // if (message.charAt(index - 1) == "%") {
    //   return match.substring(1);
    // }

    if (!args.length) {
      return match;
    }

    var obj = args[0];
    var group = group1 || group2;
    var parts = group.split(",");
    var name = parts.shift() || "";
    var method = map[name];

    if (!method) {
      // TODO - Need to check less than full length...
      // for instance %lucky should check:
      // lucky -> luck -> luc -> lu -> l -> FAIL
      return match;
    }

    let result;
    obj = args.shift();
    if (typeof method === 'function') {
      result = method(obj, ...parts);
    }
    else {
      result = '' + obj;
    }

    return result;
  };

  const txt = fmt.replace(/%(?:([\w]+)|(?:{([^}]+)}))/g, replacer);

  bstring.setText(txt);
}



FORMAT_MAP = {};

FORMAT_MAP['s'] = function(value) { return '' + value; }

FORMAT_MAP['i'] = function(value) {
  if (typeof value === 'number') return '' + Math.round(value);
  return '?';
}

FORMAT_MAP['d']  = FORMAT_MAP['i'];
FORMAT_MAP['li'] = FORMAT_MAP['i'];
FORMAT_MAP['lu'] = FORMAT_MAP['i'];
FORMAT_MAP['l']  = FORMAT_MAP['i'];
FORMAT_MAP['u']  = FORMAT_MAP['i'];
FORMAT_MAP['c']  = function(value) {
  if (!value) return '?';
  if (typeof value === 'number') { value = '' + number; }
  if (typeof value === 'string') { return value.length ? value[0] : '?'; }
  if (value.toString) {
    return value.toString()[0];
  }
  return '?';
}

FORMAT_MAP['f'] = function(value, decimals) {
  if (typeof value === 'number') {
    console.log('format float', value, decimals);
    if (decimals === undefined) {
      return '' + value;
    }

    return value.toFixed(decimals);
  }
  return '?';
}



function strncat(bstring, n, txt) {
	if (n !== bstring.fullLength) throw new Error('Rewrite this using strcat.');
  bstring.append(txt);
}

function strcpy(bstring, txt) {
	bstring.setText(txt);
}

function strcmp(a, b) {
	a = STRING(a);
	b = STRING(b);

	if (a.text == b.text) return 0;
	return (a.text < b.text) ? -1 : 1;
}


// function eachChar(bstring, callback) {
// 	bstring = STRING(bstring);
// 	return bstring.eachChar(callback);
// }
