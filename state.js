// state.js — per-property state: starred, dismissed, notes
// Synced via JSONbin.io — no login or token prompts needed.

const _BIN_ID  = '69a009eaae596e708f4b620b';
const _BIN_KEY = '$2a$10$GM2DacykC6URSakJENStXORhYWLBkBdhNtQdDHtOw.7FoSOpfpcrS';
const _BIN_URL = 'https://api.jsonbin.io/v3/b/' + _BIN_ID;

let _state = { starred: [], dismissed: [], notes: {} };
let _noteTimers = {};

// ── Public API ───────────────────────────────────────────────────────────────

async function loadState() {
    try {
        var resp = await fetch(_BIN_URL + '/latest', {
            headers: { 'X-Access-Key': _BIN_KEY }
        });
        if (resp.ok) {
            var data = await resp.json();
            _state = data.record || {};
            _state.starred   = _state.starred   || [];
            _state.dismissed = _state.dismissed || [];
            _state.notes     = _state.notes     || {};
        }
    } catch (e) {
        console.warn('[State] Load failed:', e);
        try { _state = JSON.parse(localStorage.getItem('house-search-state') || '{}'); } catch (e2) {}
        _state.starred   = _state.starred   || [];
        _state.dismissed = _state.dismissed || [];
        _state.notes     = _state.notes     || {};
    }
}

// Starred
function isStarred(url)    { return _state.starred.includes(url); }
async function toggleStar(url) {
    var i = _state.starred.indexOf(url);
    if (i >= 0) _state.starred.splice(i, 1); else _state.starred.push(url);
    await _save();
    return isStarred(url);
}

// Dismissed
function isDismissed(url)    { return _state.dismissed.includes(url); }
async function toggleDismissed(url) {
    var i = _state.dismissed.indexOf(url);
    if (i >= 0) _state.dismissed.splice(i, 1); else _state.dismissed.push(url);
    await _save();
    return isDismissed(url);
}

// Notes — debounced 1.5s after last keystroke
function getNote(url) { return _state.notes[url] || ''; }
function scheduleNoteSave(url, text) {
    if (text && text.trim()) _state.notes[url] = text;
    else delete _state.notes[url];
    clearTimeout(_noteTimers[url]);
    _noteTimers[url] = setTimeout(_save, 1500);
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function _save() {
    try {
        var resp = await fetch(_BIN_URL, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Access-Key': _BIN_KEY,
            },
            body: JSON.stringify(_state),
        });
        if (!resp.ok) console.warn('[State] Save failed:', resp.status);
    } catch (e) {
        console.warn('[State] Save error:', e);
        localStorage.setItem('house-search-state', JSON.stringify(_state));
    }
}
