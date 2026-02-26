// state.js — per-property state: starred, dismissed, notes
// Synced via GitHub Gist.
// Token priority: config.js (local dev) → localStorage (remote devices)

const _GIST_ID  = '26ae83db293db97835e7dcda4871d83a';
const _GIST_RAW = 'https://gist.githubusercontent.com/ianmackay123/' + _GIST_ID + '/raw/state.json';
const _GIST_API = 'https://api.github.com/gists/' + _GIST_ID;

function _getToken() {
    if (typeof GIST_TOKEN !== 'undefined' && GIST_TOKEN) return GIST_TOKEN;
    return localStorage.getItem('gist_token') || '';
}

let _state = { starred: [], dismissed: [], notes: {} };
let _noteTimers = {};

// ── Public API ───────────────────────────────────────────────────────────────

async function loadState() {
    try {
        var resp = await fetch(_GIST_RAW + '?t=' + Date.now());
        if (resp.ok) {
            _state = await resp.json();
        }
    } catch (e) {
        console.warn('[State] Load failed:', e);
    }
    _state.starred   = _state.starred   || [];
    _state.dismissed = _state.dismissed || [];
    _state.notes     = _state.notes     || {};
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

// Token setup — call from UI
function hasWriteAccess() { return !!_getToken(); }
function saveGistToken(token) {
    localStorage.setItem('gist_token', token.trim());
}
function clearGistToken() {
    localStorage.removeItem('gist_token');
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function _save() {
    var token = _getToken();
    if (!token) {
        console.warn('[State] No token — changes not saved. Use the sync setup to add your GitHub token.');
        return;
    }
    try {
        var resp = await fetch(_GIST_API, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'token ' + token,
            },
            body: JSON.stringify({ files: { 'state.json': { content: JSON.stringify(_state) } } }),
        });
        if (!resp.ok) console.warn('[State] Save failed:', resp.status);
    } catch (e) {
        console.warn('[State] Save error:', e);
    }
}
