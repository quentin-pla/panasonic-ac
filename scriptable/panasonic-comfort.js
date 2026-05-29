// Panasonic Comfort Cloud — Scriptable automation script
// Paste into Scriptable app on iOS.
//
// FLOW: each run is short, stateless. Detects COOL → starts DRY transition,
// steps fan power down over time. State persisted in Keychain.
// Schedule every ~5 min via native Shortcuts (12 time automations: :00 :05 :10 ... :55,
// each "Run Script" → this script, "Run Immediately" ON) OR Pushcut Automation Server.
// Step timing has up to one cron-interval skew — acceptable for thermal smoothing.
// Manual user change of mode/temp during transition aborts it (safety).
// Multiple devices: DEVICE_GUIDS comma-separated, empty => all devices in account.

// ============================================================
// CONFIG — edit these values
// ============================================================
// Leave APP_VERSION_OVERRIDE empty to fetch latest from iTunes Lookup each run.
// Panasonic rejects stale versions with HTTP 401 "New version app has been published".
const APP_VERSION_OVERRIDE = '';
const APP_VERSION_FALLBACK = '4.3.0';
let APP_VERSION = APP_VERSION_OVERRIDE || APP_VERSION_FALLBACK; // resolved in main()
const DEVICE_GUIDS = '';     // comma-separated GUIDs, empty => auto-pick ALL devices
const DRY_RUN      = true;   // true => only log, never call setParameters (safe default)
const PCC_REFRESH_KEY = 'pcc_refresh';

const TRANSITION_KEY = 'pcc_transition';   // Keychain JSON: { [guid]: txn|null }
const DRY_TARGET_TEMP = 20;
// Wait seconds before stepping down FROM the keyed fan speed
const STEP_INTERVALS_SEC = { 5: 180, 4: 300, 3: 600, 2: 600, 1: 600 };
// Enum refs (avoid magic numbers in body)
const MODE_DRY = 1, MODE_COOL = 2;
const ECO_AUTO = 0, ECO_POWERFUL = 1, ECO_QUIET = 2;

// ============================================================
// Constants
// ============================================================
const API_BASE    = 'https://accsmart.panasonic.com';
const AUTH_BASE   = 'https://authglb.digital.panasonic.com';
const CLIENT_ID   = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx';
const AUTH0_CLIENT= 'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0=';
const FIXED_KEY   = '521325fb2dd486bf4831b47644317fca';
const CC_NAME     = 'Comfort Cloud';

// ============================================================
// SHA-256 (pure JS, no imports)
// ============================================================
function sha256hex(bytes) {
  // Initial hash values (first 32 bits of fractional parts of sqrt of primes 2..19)
  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  // Round constants (first 32 bits of fractional parts of cbrt of primes 2..311)
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
  function add(...args) { return args.reduce((a, b) => (a + b) >>> 0, 0); }

  // Pre-processing: padding
  const len = bytes.length;
  const bitLen = len * 8;
  // pad to 512-bit block boundary (message + 1 bit + zeros + 64-bit length)
  const padLen = ((len % 64) < 56 ? 56 : 120) - (len % 64);
  const total = len + padLen + 8;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  // big-endian 64-bit bit length (JS numbers are 53-bit safe, so hi word is 0 for any realistic input)
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  buf[total - 8] = (hi >>> 24) & 0xff;
  buf[total - 7] = (hi >>> 16) & 0xff;
  buf[total - 6] = (hi >>> 8)  & 0xff;
  buf[total - 5] =  hi         & 0xff;
  buf[total - 4] = (lo >>> 24) & 0xff;
  buf[total - 3] = (lo >>> 16) & 0xff;
  buf[total - 2] = (lo >>> 8)  & 0xff;
  buf[total - 1] =  lo         & 0xff;

  const h = H.slice();

  for (let i = 0; i < total; i += 64) {
    const w = new Uint32Array(64);
    for (let j = 0; j < 16; j++) {
      w[j] = (buf[i + j*4] << 24) | (buf[i + j*4+1] << 16) | (buf[i + j*4+2] << 8) | buf[i + j*4+3];
      w[j] >>>= 0;
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j-15], 7) ^ rotr(w[j-15], 18) ^ (w[j-15] >>> 3);
      const s1 = rotr(w[j-2], 17) ^ rotr(w[j-2], 19)  ^ (w[j-2]  >>> 10);
      w[j] = add(w[j-16], s0, w[j-7], s1);
    }

    let [a, b, c, d, e, f, g, hh] = h;

    for (let j = 0; j < 64; j++) {
      const S1  = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch  = ((e & f) ^ (~e & g)) >>> 0;
      const tmp1 = add(hh, S1, ch, K[j], w[j]);
      const S0  = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const tmp2 = add(S0, maj);

      hh = g; g = f; f = e;
      e = add(d, tmp1);
      d = c; c = b; b = a;
      a = add(tmp1, tmp2);
    }

    h[0] = add(h[0], a);
    h[1] = add(h[1], b);
    h[2] = add(h[2], c);
    h[3] = add(h[3], d);
    h[4] = add(h[4], e);
    h[5] = add(h[5], f);
    h[6] = add(h[6], g);
    h[7] = add(h[7], hh);
  }

  return h.map(v => ('00000000' + v.toString(16)).slice(-8)).join('');
}

// ============================================================
// UTF-8 encoder (TextEncoder if available, else manual ASCII+BMP)
// ============================================================
function utf8Encode(str) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str);
  }
  // Manual UTF-8 for BMP characters
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xC0 | (cp >> 6), 0x80 | (cp & 0x3F));
    } else if (cp < 0x10000) {
      out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    } else {
      out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
    }
  }
  return new Uint8Array(out);
}

function concatBytes(...arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

// ============================================================
// CFC Key + timestamp
// ============================================================
function pad2(n) { return String(n).padStart(2, '0'); }

function getTimestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function computeCfcKey(timestamp, accessToken) {
  const timeDiff = Date.parse(timestamp.replace(' ', 'T') + 'Z');
  const bytes = concatBytes(
    utf8Encode(CC_NAME),
    utf8Encode(FIXED_KEY),
    utf8Encode(String(timeDiff)),
    utf8Encode('Bearer '),
    utf8Encode(accessToken)
  );
  const hash = sha256hex(bytes);
  return hash.slice(0, 9) + 'cfc' + hash.slice(9);
}

// ============================================================
// Base headers (timestamp + key computed together per call)
// ============================================================
function getBaseHeaders(accessToken) {
  const timestamp = getTimestamp();
  const key = computeCfcKey(timestamp, accessToken);
  return {
    'Accept': 'application/json; charset=UTF-8',
    'Content-Type': 'application/json',
    'User-Agent': 'G-RAC',
    'X-APP-NAME': 'Comfort Cloud',
    'X-APP-TIMESTAMP': timestamp,
    'X-APP-TYPE': '1',
    'X-APP-VERSION': APP_VERSION,
    'X-CFC-API-KEY': key
  };
}

// ============================================================
// HTTP helpers
// ============================================================
async function httpPost(url, headers, payload) {
  const req = new Request(url);
  req.method = 'POST';
  req.headers = headers;
  req.body = JSON.stringify(payload);
  const data = await req.loadJSON();
  const status = req.response.statusCode;
  if (status < 200 || status >= 300) {
    console.log(`POST ${url} -> ${status}: ${JSON.stringify(data)}`);
    throw new Error(`HTTP ${status} from ${url}`);
  }
  return data;
}

async function httpGet(url, headers) {
  const req = new Request(url);
  req.method = 'GET';
  req.headers = headers;
  const data = await req.loadJSON();
  const status = req.response.statusCode;
  if (status < 200 || status >= 300) {
    console.log(`GET ${url} -> ${status}: ${JSON.stringify(data)}`);
    throw new Error(`HTTP ${status} from ${url}`);
  }
  return data;
}

// ============================================================
// Notification helper
// ============================================================
function notify(title, body) {
  const n = new Notification();
  n.title = title;
  n.body = body;
  n.schedule();
}

// ============================================================
// Transition plan builder
// ============================================================
function buildTransitionPlan(currentFanSpeed, currentEcoMode) {
  // Determine starting power: if ecoMode==Powerful => 5, else clamp fanSpeed to 1..5, fallback 3 (Auto)
  let start;
  if (currentEcoMode === ECO_POWERFUL) start = 5;
  else if (currentFanSpeed >= 1 && currentFanSpeed <= 5) start = currentFanSpeed;
  else start = 3;
  const plan = [];
  // Step 0: switch to DRY @ 20°C immediately, clear Powerful eco, set starting fan
  plan.push({ atSec: 0, params: { operate: 1, operationMode: MODE_DRY, temperatureSet: DRY_TARGET_TEMP, fanSpeed: start, ecoMode: ECO_AUTO } });
  let t = 0, fs = start;
  while (fs > 1) {
    t += STEP_INTERVALS_SEC[fs];
    fs -= 1;
    plan.push({ atSec: t, params: { fanSpeed: fs } });
  }
  // Final: after the 1 interval, set Quiet (keep fan at 1)
  t += STEP_INTERVALS_SEC[1];
  plan.push({ atSec: t, params: { ecoMode: ECO_QUIET } });
  return plan;
}

// ============================================================
// Keychain transitions map helpers
// Shape: { [guid]: txn|null }
// Migration: old single-value (non-object or object with plan/startMs) → reset to {}
// ============================================================
function loadTransitions() {
  if (!Keychain.contains(TRANSITION_KEY)) return {};
  try {
    const parsed = JSON.parse(Keychain.get(TRANSITION_KEY));
    // Old shape was a single transition object (had `plan` key) or null
    if (parsed === null || (typeof parsed === 'object' && 'plan' in parsed)) {
      return {}; // discard legacy single-device state
    }
    return typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function saveTransitions(map) {
  Keychain.set(TRANSITION_KEY, JSON.stringify(map));
}

// ============================================================
// Device resolution
// ============================================================
function resolveDevices(groupList, configuredGuids) {
  const allDevices = {};
  for (const group of groupList) {
    for (const d of (group.deviceList || [])) {
      allDevices[d.deviceGuid] = { guid: d.deviceGuid, name: d.deviceName || d.deviceGuid };
    }
  }
  if (configuredGuids.length === 0) return Object.values(allDevices);
  const result = [];
  for (const g of configuredGuids) {
    if (allDevices[g]) {
      result.push(allDevices[g]);
    } else {
      console.log(`WARNING: configured GUID ${g} not found in account — skipping`);
    }
  }
  return result;
}

// ============================================================
// Per-device state machine
// ============================================================
async function processDevice({ guid, name }, transitions, accessToken, clientId) {
  const deviceResp = await httpGet(
    API_BASE + '/deviceStatus/' + guid,
    Object.assign(getBaseHeaders(accessToken), {
      'X-Client-Id': clientId,
      'X-User-Authorization-V2': 'Bearer ' + accessToken
    })
  );
  const p = deviceResp.parameters;
  const inside   = p.insideTemperature;
  const operate  = p.operate;
  const mode     = p.operationMode;
  const setTemp  = p.temperatureSet;
  const fanSpeed = p.fanSpeed;
  const ecoMode  = p.ecoMode;
  console.log(`[${name}] State: inside=${inside}C operate=${operate} mode=${mode} setTemp=${setTemp} fan=${fanSpeed} eco=${ecoMode}`);

  let active = transitions[guid] ?? null;
  let actionTaken = 'none';
  let applyParams = null;
  let stateToPersist = null;
  let clearAfterApply = false;
  let immediateClear = false;

  if (active) {
    // SAFETY: detect manual intervention → abort transition immediately
    if (operate === 0) {
      immediateClear = true;
      actionTaken = 'aborted (powered off)';
    } else if (mode !== MODE_DRY || Math.abs(setTemp - DRY_TARGET_TEMP) > 0.5) {
      immediateClear = true;
      actionTaken = `aborted (user changed mode=${mode} setTemp=${setTemp})`;
    } else {
      // Find latest plan step due now (atSec ≤ elapsed, idx > lastAppliedIdx)
      const elapsedSec = Math.floor((Date.now() - active.startMs) / 1000);
      let nextIdx = active.lastAppliedIdx;
      for (let i = active.lastAppliedIdx + 1; i < active.plan.length; i++) {
        if (active.plan[i].atSec <= elapsedSec) nextIdx = i;
        else break;
      }
      if (nextIdx > active.lastAppliedIdx) {
        applyParams = active.plan[nextIdx].params;
        active.lastAppliedIdx = nextIdx;
        if (nextIdx >= active.plan.length - 1) {
          clearAfterApply = true;
          actionTaken = `final step ${nextIdx}/${active.plan.length-1}: ${JSON.stringify(applyParams)}`;
        } else {
          stateToPersist = active;
          actionTaken = `step ${nextIdx}/${active.plan.length-1}: ${JSON.stringify(applyParams)}`;
        }
      } else {
        const nextStep = active.plan[active.lastAppliedIdx + 1];
        actionTaken = `transition active, no step due yet (elapsed=${elapsedSec}s, next at ${nextStep ? nextStep.atSec + 's' : 'n/a'})`;
      }
    }
  } else {
    // No active transition — start one IFF device currently in COOL mode and on
    if (operate === 1 && mode === MODE_COOL) {
      const plan = buildTransitionPlan(fanSpeed, ecoMode);
      stateToPersist = { startMs: Date.now(), plan, lastAppliedIdx: 0, deviceGuid: guid };
      applyParams = plan[0].params;
      actionTaken = `started transition (initial fan=${plan[0].params.fanSpeed}, ${plan.length} steps, total ${plan[plan.length-1].atSec}s)`;
    } else {
      actionTaken = 'idle (not in COOL mode)';
    }
  }

  // Immediate clear for abort cases (no apply needed)
  if (immediateClear) transitions[guid] = null;

  // Apply parameters (if any). On throw, state is NOT advanced → step retries next run.
  let applySucceeded = false;
  if (applyParams) {
    if (DRY_RUN) {
      console.log(`[${name}] [DRY_RUN] would setParameters: ${JSON.stringify(applyParams)}`);
      applySucceeded = true;
    } else {
      const ctrlResp = await httpPost(
        API_BASE + '/deviceStatus/control',
        Object.assign(getBaseHeaders(accessToken), {
          'X-Client-Id': clientId,
          'X-User-Authorization-V2': 'Bearer ' + accessToken
        }),
        { deviceGuid: guid, parameters: applyParams }
      );
      console.log(`[${name}] setParameters response: ${JSON.stringify(ctrlResp)}`);
      applySucceeded = true;
    }
  }

  // Persist state — only after successful apply
  if (applySucceeded) {
    if (clearAfterApply) transitions[guid] = null;
    else if (stateToPersist) transitions[guid] = stateToPersist;
  }

  console.log(`[${name}] Action: ` + actionTaken);
  return actionTaken;
}

// ============================================================
// Main flow
// ============================================================
async function fetchCurrentAppVersion() {
  if (APP_VERSION_OVERRIDE) return APP_VERSION_OVERRIDE;
  try {
    const req = new Request('https://itunes.apple.com/lookup?id=1348640525');
    req.method = 'GET';
    const data = await req.loadJSON();
    return data?.results?.[0]?.version || APP_VERSION_FALLBACK;
  } catch (e) {
    console.log('iTunes lookup failed, using fallback: ' + e.message);
    return APP_VERSION_FALLBACK;
  }
}

async function main() {
  // 0. Resolve current X-APP-VERSION
  APP_VERSION = await fetchCurrentAppVersion();
  console.log('X-APP-VERSION = ' + APP_VERSION);

  // 1. Load refresh token from Keychain
  const rt = Keychain.contains(PCC_REFRESH_KEY) ? Keychain.get(PCC_REFRESH_KEY) : null;
  if (!rt) {
    notify('Panasonic AC', 'No refresh token — run seed on Mac then Keychain.set once');
    return;
  }

  // 2. Refresh OAuth token
  let tokenResp;
  try {
    tokenResp = await httpPost(
      AUTH_BASE + '/oauth/token',
      {
        'Auth0-Client': AUTH0_CLIENT,
        'Content-Type': 'application/json',
        'User-Agent': 'okhttp/4.10.0'
      },
      {
        scope: 'openid offline_access comfortcloud.control a2w.control',
        client_id: CLIENT_ID,
        refresh_token: rt,
        grant_type: 'refresh_token'
      }
    );
  } catch (e) {
    notify('Panasonic AC', 'Token refresh failed — re-seed refresh token');
    return;
  }
  const accessToken = tokenResp.access_token;
  Keychain.set(PCC_REFRESH_KEY, tokenResp.refresh_token); // rotate

  // 3. Get clientId
  const loginResp = await httpPost(
    API_BASE + '/auth/v2/login',
    Object.assign(getBaseHeaders(accessToken), { 'X-User-Authorization-V2': 'Bearer ' + accessToken }),
    { language: 0 }
  );
  const clientId = loginResp.clientId;

  // 4. Resolve devices from groups (call once)
  const groupsResp = await httpGet(
    API_BASE + '/device/group/',
    Object.assign(getBaseHeaders(accessToken), {
      'X-Client-Id': clientId,
      'X-User-Authorization-V2': 'Bearer ' + accessToken
    })
  );
  const groupList = groupsResp.groupList || [];
  const configuredGuids = DEVICE_GUIDS.split(',').map(s => s.trim()).filter(Boolean);
  const devices = resolveDevices(groupList, configuredGuids);

  if (!devices.length) {
    notify('Panasonic AC', 'No devices resolved — check account or DEVICE_GUIDS');
    return;
  }
  console.log('Devices: ' + devices.map(d => d.name + ' (' + d.guid + ')').join(', '));

  // 5. Load transitions map (shared across all devices this run)
  const transitions = loadTransitions();

  // 6. Per-device loop (serial)
  for (const device of devices) {
    try {
      const actionTaken = await processDevice(device, transitions, accessToken, clientId);
      const isIdle = actionTaken === 'none' || actionTaken === 'idle (not in COOL mode)' ||
        actionTaken.startsWith('transition active, no step due yet');
      // DRY_RUN: always notify to confirm script ran. Production: skip idle to avoid spam.
      if (!isIdle || DRY_RUN) {
        notify(`Panasonic AC ${device.name}`, actionTaken + (DRY_RUN ? ' [DRY_RUN]' : ''));
      }
    } catch (e) {
      console.log(`[${device.name}] Error: ` + e.message);
      notify(`Panasonic AC ${device.name} ERROR`, e.message || String(e));
    }
  }

  // 7. ALWAYS save transitions map (even if all idle — token rotation handled separately via Keychain.set above)
  saveTransitions(transitions);
}

// ============================================================
// Entry point
// ============================================================
try {
  await main();
} catch (e) {
  console.log('Panasonic AC error: ' + e.message);
  notify('Panasonic AC error', e.message || String(e));
}
