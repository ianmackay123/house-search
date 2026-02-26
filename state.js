// state.js — per-property state: starred, dismissed, notes
// Synced via GitHub Contents API. Replaces stars.js.
// One file (property-state.json), one load, one save per change.

const STATE_REPO      = 'ianmackay123/house-search';
const STATE_FILE      = 'property-state.json';
const STATE_TOKEN_KEY = 'house-search-gh-token';
const STATE_LOCAL_KEY = 'house-search-state';

let _state = { starred: [], dismissed: [], notes: {} };
let _sha   = null;
let _noteTimers = {}; // per-url debounce for note saves

// ── Public API ───────────────────────────────────────────────────────────────

async function loadState() {
    try {
        var resp = await fetch(
            'https://api.github.com/repos/' + STATE_REPO + '/contents/' + STATE_FILE,
            { headers: { 'Accept': 'application/vnd.github.v3+json' } }
        );
        if (resp.ok) {
            var data = await resp.json();
            _sha = data.sha;
            _state = JSON.parse(atob(data.content.replace(/\n/g, '')));
            _state.starred   = _state.starred   || [];
            _state.dismissed = _state.dismissed || [];
            _state.notes     = _state.notes     || {};
            return;
        }
    } catch (e) {}
    // Fallback: localStorage
    try { _state = JSON.parse(localStorage.getItem(STATE_LOCAL_KEY) || '{}'); } catch (e) {}
    _state.starred   = _state.starred   || [];
    _state.dismissed = _state.dismissed || [];
    _state.notes     = _state.notes     || {};
}

// Starred
function isStarred(url)    { return _state.starred.includes(url); }
async function toggleStar(url) {
    var i = _state.starred.indexOf(url);
    if (i >= 0) _state.starred.splice(i, 1); else _state.starred.push(url);
    await _save('Update starred');
    return isStarred(url);
}

// Dismissed
function isDismissed(url)    { return _state.dismissed.includes(url); }
async function toggleDismissed(url) {
    var i = _state.dismissed.indexOf(url);
    if (i >= 0) _state.dismissed.splice(i, 1); else _state.dismissed.push(url);
    await _save('Update dismissed');
    return isDismissed(url);
}

// Notes — saves are debounced 1.5s after last keystroke
function getNote(url) { return _state.notes[url] || ''; }
function scheduleNoteSave(url, text) {
    if (text && text.trim()) _state.notes[url] = text;
    else delete _state.notes[url];
    clearTimeout(_noteTimers[url]);
    _noteTimers[url] = setTimeout(function() { _save('Update notes'); }, 1500);
}

function clearStateToken() {
    localStorage.removeItem(STATE_TOKEN_KEY);
    alert('GitHub token cleared. You will be prompted again next time.');
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _getToken() { return localStorage.getItem(STATE_TOKEN_KEY) || ''; }

function _promptToken() {
    var token = prompt(
        'Enter a GitHub Personal Access Token to sync starred, dismissed and notes across devices.\n\n' +
        'Create one at: github.com/settings/tokens\n' +
        'Choose "Fine-grained", select the house-search repo,\n' +
        'and grant "Contents" read + write permission.\n\n' +
        'Leave blank to save in this browser only.'
    );
    if (token && token.trim()) {
        localStorage.setItem(STATE_TOKEN_KEY, token.trim());
        return token.trim();
    }
    return null;
}

async function _save(message) {
    var token = _getToken();
    if (!token) {
        token = _promptToken();
        if (!token) {
            localStorage.setItem(STATE_LOCAL_KEY, JSON.stringify(_state));
            return;
        }
    }

    try {
        // Re-fetch to get latest SHA and merge (handles concurrent edits)
        var getResp = await fetch(
            'https://api.github.com/repos/' + STATE_REPO + '/contents/' + STATE_FILE,
            { headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': 'Bearer ' + token } }
        );
        if (getResp.ok) {
            var current = await getResp.json();
            _sha = current.sha;
            var remote = JSON.parse(atob(current.content.replace(/\n/g, '')));
            // Merge notes from remote (preserve edits made on other devices)
            // For starred/dismissed our local state is authoritative (we just toggled)
            // For notes, merge: remote is base, our local changes overlay it
            if (remote.notes) {
                Object.keys(remote.notes).forEach(function(url) {
                    if (!(_state.notes[url] !== undefined)) _state.notes[url] = remote.notes[url];
                });
            }
        }

        var content = JSON.stringify(_state, null, 2);
        // btoa doesn't handle unicode — encode via URI trick
        var encoded = btoa(unescape(encodeURIComponent(content)));

        var body = { message: message, content: encoded };
        if (_sha) body.sha = _sha;

        var putResp = await fetch(
            'https://api.github.com/repos/' + STATE_REPO + '/contents/' + STATE_FILE,
            {
                method: 'PUT',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/json',
                    'Accept': 'application/vnd.github.v3+json',
                },
                body: JSON.stringify(body),
            }
        );

        if (putResp.ok) {
            _sha = (await putResp.json()).content.sha;
        } else if (putResp.status === 401 || putResp.status === 403) {
            localStorage.removeItem(STATE_TOKEN_KEY);
            alert('GitHub token invalid or expired — cleared. You\'ll be prompted next time.');
        } else {
            console.warn('[State] Save failed:', putResp.status);
            localStorage.setItem(STATE_LOCAL_KEY, JSON.stringify(_state));
        }
    } catch (e) {
        console.warn('[State] Save error:', e);
        localStorage.setItem(STATE_LOCAL_KEY, JSON.stringify(_state));
    }
}
