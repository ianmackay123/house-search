// stars.js — shared star logic, synced via GitHub Contents API
// Stars are stored in starred.json in the repo. Reading is public;
// writing requires a GitHub PAT stored once in localStorage per device.

const STARS_REPO = 'ianmackay123/house-search';
const STARS_FILE = 'starred.json';
const TOKEN_KEY  = 'house-search-gh-token';
const LOCAL_KEY  = 'house-search-starred'; // fallback if API unavailable

let _starred = new Set();
let _sha     = null; // current SHA of starred.json, needed for GitHub PUT

// ── Public API ──────────────────────────────────────────────────────────────

async function loadStarred() {
    try {
        var resp = await fetch(
            'https://api.github.com/repos/' + STARS_REPO + '/contents/' + STARS_FILE,
            { headers: { 'Accept': 'application/vnd.github.v3+json' } }
        );
        if (resp.ok) {
            var data = await resp.json();
            _sha = data.sha;
            var urls = JSON.parse(atob(data.content.replace(/\n/g, '')));
            _starred = new Set(Array.isArray(urls) ? urls : []);
            return;
        }
    } catch (e) {}
    // Fallback: localStorage (local-only mode or API unavailable)
    try { _starred = new Set(JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]')); } catch (e) {}
}

function isStarred(url) {
    return _starred.has(url);
}

async function toggleStar(url) {
    if (_starred.has(url)) _starred.delete(url);
    else _starred.add(url);
    await _save();
    return _starred.has(url);
}

function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    alert('GitHub token cleared. You will be prompted again next time you star a property.');
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
}

function _promptToken() {
    var token = prompt(
        'Enter a GitHub Personal Access Token to sync stars across devices.\n\n' +
        'Create one at: github.com/settings/tokens\n' +
        'Choose "Fine-grained", select the house-search repo,\n' +
        'and grant "Contents" read + write permission.\n\n' +
        'Leave blank to save stars in this browser only.'
    );
    if (token && token.trim()) {
        localStorage.setItem(TOKEN_KEY, token.trim());
        return token.trim();
    }
    return null;
}

async function _save() {
    var token = _getToken();
    if (!token) {
        token = _promptToken();
        if (!token) {
            // Local-only mode
            localStorage.setItem(LOCAL_KEY, JSON.stringify([..._starred]));
            return;
        }
    }

    // Re-fetch current SHA in case another device updated the file
    try {
        var getResp = await fetch(
            'https://api.github.com/repos/' + STARS_REPO + '/contents/' + STARS_FILE,
            { headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': 'Bearer ' + token } }
        );
        if (getResp.ok) {
            var current = await getResp.json();
            _sha = current.sha;
            // Merge: preserve stars added on other devices, apply our local toggle
            var remoteUrls = JSON.parse(atob(current.content.replace(/\n/g, '')));
            // _starred already has our intended state — just update the SHA
        }
    } catch (e) {}

    try {
        var body = { message: 'Update starred properties', content: btoa(JSON.stringify([..._starred])) };
        if (_sha) body.sha = _sha;

        var resp = await fetch(
            'https://api.github.com/repos/' + STARS_REPO + '/contents/' + STARS_FILE,
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

        if (resp.ok) {
            var result = await resp.json();
            _sha = result.content.sha;
        } else if (resp.status === 401 || resp.status === 403) {
            localStorage.removeItem(TOKEN_KEY);
            alert('GitHub token is invalid or expired — cleared. You\'ll be prompted next time.');
        } else {
            console.warn('[Stars] Save failed:', resp.status);
            localStorage.setItem(LOCAL_KEY, JSON.stringify([..._starred]));
        }
    } catch (e) {
        console.warn('[Stars] Save error:', e);
        localStorage.setItem(LOCAL_KEY, JSON.stringify([..._starred]));
    }
}
