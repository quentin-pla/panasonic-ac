// Panasonic AC tick — Node port of scriptable/panasonic-comfort.js.
// Uses raw fetch + native crypto. No third-party Panasonic lib (avoids stale
// hardcoded appVersion). State machine logic IDENTICAL to Scriptable.
//
// Env vars:
//   PCC_REFRESH      initial refresh token (bootstrap when state file missing)
//   PCC_DEVICE_GUID  comma-separated GUIDs (empty/missing => auto-pick ALL devices)
//   PCC_DRY_RUN      'true' => only log, never call setParameters
//   PCC_APP_VERSION  optional pin — empty => fetch from iTunes Lookup
//   NTFY_TOPIC       ntfy.sh topic (empty => no push notifications)
//   NTFY_BASE        default https://ntfy.sh

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// ============================================================
// CONFIG
// ============================================================
const DEVICE_GUIDS_ENV     = process.env.PCC_DEVICE_GUID || ''
const DRY_RUN             = process.env.PCC_DRY_RUN === 'true'
const DRY_TARGET_TEMP     = 20
const STEP_INTERVALS_SEC  = { 5: 180, 4: 300, 3: 600, 2: 600, 1: 600 }
const STATE_FILE          = path.resolve('./state/pcc.json')
const NTFY_TOPIC          = process.env.NTFY_TOPIC || ''
const NTFY_BASE           = process.env.NTFY_BASE || 'https://ntfy.sh'
const APP_VERSION_OVERRIDE = process.env.PCC_APP_VERSION || ''
const APP_VERSION_FALLBACK = '4.3.0'

// Enums (mirror lib enums for readability — store numbers in JSON)
const MODE_DRY = 1, MODE_COOL = 2
const ECO_AUTO = 0, ECO_POWERFUL = 1, ECO_QUIET = 2
const POWER_OFF = 0, POWER_ON = 1

// ============================================================
// API constants
// ============================================================
const API_BASE    = 'https://accsmart.panasonic.com'
const AUTH_BASE   = 'https://authglb.digital.panasonic.com'
const CLIENT_ID   = 'Xmy6xIYIitMxngjB2rHvlm6HSDNnaMJx'
const AUTH0_CLIENT= 'eyJuYW1lIjoiQXV0aDAuQW5kcm9pZCIsImVudiI6eyJhbmRyb2lkIjoiMzAifSwidmVyc2lvbiI6IjIuOS4zIn0='
const FIXED_KEY   = '521325fb2dd486bf4831b47644317fca'
const CC_NAME     = 'Comfort Cloud'

let APP_VERSION = APP_VERSION_OVERRIDE || APP_VERSION_FALLBACK

// ============================================================
// CFC key (port of Scriptable computeCfcKey)
// ============================================================
function pad2(n) { return String(n).padStart(2, '0') }
function getTimestamp() {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
function computeCfcKey(timestamp, accessToken) {
  const timeDiff = Date.parse(timestamp.replace(' ', 'T') + 'Z')
  const enc = (s) => Buffer.from(s, 'utf8')
  const bytes = Buffer.concat([
    enc(CC_NAME), enc(FIXED_KEY), enc(String(timeDiff)), enc('Bearer '), enc(accessToken)
  ])
  const hash = createHash('sha256').update(bytes).digest('hex')
  return hash.slice(0, 9) + 'cfc' + hash.slice(9)
}
function getBaseHeaders(accessToken) {
  const timestamp = getTimestamp()
  return {
    'Accept': 'application/json; charset=UTF-8',
    'Content-Type': 'application/json',
    'User-Agent': 'G-RAC',
    'X-APP-NAME': 'Comfort Cloud',
    'X-APP-TIMESTAMP': timestamp,
    'X-APP-TYPE': '1',
    'X-APP-VERSION': APP_VERSION,
    'X-CFC-API-KEY': computeCfcKey(timestamp, accessToken)
  }
}

// ============================================================
// HTTP helpers
// ============================================================
async function httpJson(url, { method = 'GET', headers = {}, body = null } = {}) {
  const init = { method, headers }
  if (body !== null) init.body = typeof body === 'string' ? body : JSON.stringify(body)
  const res = await fetch(url, init)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    console.log(`${method} ${url} -> ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    throw new Error(`HTTP ${res.status} from ${url}`)
  }
  return data
}

// ============================================================
// App version (iTunes Lookup, like iobroker)
// ============================================================
async function fetchAppVersion() {
  if (APP_VERSION_OVERRIDE) return APP_VERSION_OVERRIDE
  try {
    const res = await fetch('https://itunes.apple.com/lookup?id=1348640525')
    const data = await res.json()
    return data?.results?.[0]?.version || APP_VERSION_FALLBACK
  } catch (e) {
    console.log('iTunes lookup failed, using fallback:', e.message)
    return APP_VERSION_FALLBACK
  }
}

// ============================================================
// State helpers
// ============================================================
async function loadState() {
  try {
    const raw = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))
    // Migration: old shape had `transition` (single-device) → drop, init transitions map
    if ('transition' in raw && !('transitions' in raw)) {
      raw.transitions = {}
      delete raw.transition
    } else if (!('transitions' in raw)) {
      raw.transitions = {}
    }
    return raw
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    const seed = process.env.PCC_REFRESH
    if (!seed) throw new Error('No state file and PCC_REFRESH env not set — cannot bootstrap')
    return { refreshToken: seed, transitions: {} }
  }
}
async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

// ============================================================
// Notifications (ntfy.sh)
// ============================================================
async function ntfy(title, body, priority = 'default') {
  if (!NTFY_TOPIC) return
  try {
    await fetch(`${NTFY_BASE}/${NTFY_TOPIC}`, {
      method: 'POST',
      body,
      headers: { Title: title, Priority: priority }
    })
  } catch {}
}

// ============================================================
// Transition plan (identical to Scriptable)
// ============================================================
function buildTransitionPlan(currentFanSpeed, currentEcoMode) {
  let start
  if (currentEcoMode === ECO_POWERFUL) start = 5
  else if (currentFanSpeed >= 1 && currentFanSpeed <= 5) start = currentFanSpeed
  else start = 3

  const plan = []
  plan.push({
    atSec: 0,
    params: {
      operate: POWER_ON,
      operationMode: MODE_DRY,
      temperatureSet: DRY_TARGET_TEMP,
      fanSpeed: start,
      ecoMode: ECO_AUTO
    }
  })
  let t = 0, fs = start
  while (fs > 1) {
    t += STEP_INTERVALS_SEC[fs]
    fs -= 1
    plan.push({ atSec: t, params: { fanSpeed: fs } })
  }
  t += STEP_INTERVALS_SEC[1]
  plan.push({ atSec: t, params: { ecoMode: ECO_QUIET } })
  return plan
}

// ============================================================
// Device resolution
// ============================================================
function resolveDevices(groupList, configuredGuids) {
  // Build flat map guid → { guid, name }
  const allDevices = {}
  for (const group of groupList) {
    for (const d of (group.deviceList || [])) {
      allDevices[d.deviceGuid] = { guid: d.deviceGuid, name: d.deviceName || d.deviceGuid }
    }
  }

  if (configuredGuids.length === 0) {
    // Auto: all devices
    return Object.values(allDevices)
  }

  const result = []
  for (const g of configuredGuids) {
    if (allDevices[g]) {
      result.push(allDevices[g])
    } else {
      console.log(`WARNING: configured GUID ${g} not found in account — skipping`)
    }
  }
  return result
}

// ============================================================
// Per-device state machine
// ============================================================
async function processDevice({ guid, name }, state, accessToken, clientId) {
  const deviceResp = await httpJson(`${API_BASE}/deviceStatus/${guid}`, {
    headers: { ...getBaseHeaders(accessToken), 'X-Client-Id': clientId, 'X-User-Authorization-V2': 'Bearer ' + accessToken }
  })
  const p = deviceResp.parameters
  console.log(`[${name}] State: inside=${p.insideTemperature}C operate=${p.operate} mode=${p.operationMode} setTemp=${p.temperatureSet} fan=${p.fanSpeed} eco=${p.ecoMode}`)

  let active = state.transitions[guid] ?? null
  let actionTaken = 'none'
  let applyParams = null
  let stateToPersist = null
  let clearAfterApply = false
  let immediateClear = false

  // Stale-state recovery: active transition exists but AC is back in COOL
  // (prior DRY_RUN run, transient API failure, or user toggled back).
  // Discard stale state so we restart fresh THIS tick instead of waiting another cycle.
  if (active && p.operationMode === MODE_COOL) {
    state.transitions[guid] = null
    active = null
    console.log(`[${name}] discarded stale transition (AC back in COOL) — restarting`)
  }

  if (active) {
    if (p.operate === POWER_OFF) {
      immediateClear = true
      actionTaken = 'aborted (powered off)'
    } else if (p.operationMode !== MODE_DRY || Math.abs(p.temperatureSet - DRY_TARGET_TEMP) > 0.5) {
      immediateClear = true
      actionTaken = `aborted (user changed mode=${p.operationMode} setTemp=${p.temperatureSet})`
    } else {
      const elapsedSec = Math.floor((Date.now() - active.startMs) / 1000)
      let nextIdx = active.lastAppliedIdx
      for (let i = active.lastAppliedIdx + 1; i < active.plan.length; i++) {
        if (active.plan[i].atSec <= elapsedSec) nextIdx = i
        else break
      }
      if (nextIdx > active.lastAppliedIdx) {
        applyParams = active.plan[nextIdx].params
        active.lastAppliedIdx = nextIdx
        if (nextIdx >= active.plan.length - 1) {
          clearAfterApply = true
          actionTaken = `final step ${nextIdx}/${active.plan.length - 1}: ${JSON.stringify(applyParams)}`
        } else {
          stateToPersist = active
          actionTaken = `step ${nextIdx}/${active.plan.length - 1}: ${JSON.stringify(applyParams)}`
        }
      } else {
        const nextStep = active.plan[active.lastAppliedIdx + 1]
        actionTaken = `transition active, no step due yet (elapsed=${elapsedSec}s, next at ${nextStep ? nextStep.atSec + 's' : 'n/a'})`
      }
    }
  } else {
    if (p.operate === POWER_ON && p.operationMode === MODE_COOL) {
      const plan = buildTransitionPlan(p.fanSpeed, p.ecoMode)
      stateToPersist = { startMs: Date.now(), plan, lastAppliedIdx: 0, deviceGuid: guid }
      applyParams = plan[0].params
      actionTaken = `started transition (initial fan=${plan[0].params.fanSpeed}, ${plan.length} steps, total ${plan[plan.length - 1].atSec}s)`
    } else {
      actionTaken = 'idle (not in COOL mode)'
    }
  }

  if (immediateClear) state.transitions[guid] = null

  let applySucceeded = false
  if (applyParams) {
    if (DRY_RUN) {
      console.log(`[${name}] [DRY_RUN] would setParameters: ${JSON.stringify(applyParams)}`)
      applySucceeded = true
    } else {
      const ctrlResp = await httpJson(`${API_BASE}/deviceStatus/control`, {
        method: 'POST',
        headers: { ...getBaseHeaders(accessToken), 'X-Client-Id': clientId, 'X-User-Authorization-V2': 'Bearer ' + accessToken },
        body: { deviceGuid: guid, parameters: applyParams }
      })
      console.log(`[${name}] setParameters response: ${JSON.stringify(ctrlResp)}`)
      applySucceeded = true
    }
  }

  if (applySucceeded) {
    if (clearAfterApply) state.transitions[guid] = null
    else if (stateToPersist) state.transitions[guid] = stateToPersist
  }

  console.log(`[${name}] Action:`, actionTaken)
  return actionTaken
}

// ============================================================
// Main
// ============================================================
async function main() {
  const state = await loadState()
  if (!state.refreshToken) throw new Error('No refreshToken in state')

  APP_VERSION = await fetchAppVersion()
  console.log('X-APP-VERSION =', APP_VERSION)

  // 1. Refresh OAuth token
  const tokenResp = await httpJson(`${AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      'Auth0-Client': AUTH0_CLIENT,
      'Content-Type': 'application/json',
      'User-Agent': 'okhttp/4.10.0'
    },
    body: {
      scope: 'openid offline_access comfortcloud.control a2w.control',
      client_id: CLIENT_ID,
      refresh_token: state.refreshToken,
      grant_type: 'refresh_token'
    }
  })
  const accessToken = tokenResp.access_token
  state.refreshToken = tokenResp.refresh_token // ROTATE — must persist even if downstream fails

  // 2. Get clientId
  const loginResp = await httpJson(`${API_BASE}/auth/v2/login`, {
    method: 'POST',
    headers: { ...getBaseHeaders(accessToken), 'X-User-Authorization-V2': 'Bearer ' + accessToken },
    body: { language: 0 }
  })
  const clientId = loginResp.clientId

  // 3. Resolve devices from groups (call once)
  const groupsResp = await httpJson(`${API_BASE}/device/group/`, {
    headers: { ...getBaseHeaders(accessToken), 'X-Client-Id': clientId, 'X-User-Authorization-V2': 'Bearer ' + accessToken }
  })
  const groupList = groupsResp.groupList || []
  const configuredGuids = DEVICE_GUIDS_ENV.split(',').map(s => s.trim()).filter(Boolean)
  const devices = resolveDevices(groupList, configuredGuids)

  if (!devices.length) throw new Error('No devices resolved — check account or PCC_DEVICE_GUID')
  console.log('Devices:', devices.map(d => `${d.name} (${d.guid})`).join(', '))

  // 4. Per-device loop (serial)
  let anyDeviceErrored = false
  const notifyActions = [] // collect non-idle actions for notification

  for (const device of devices) {
    try {
      const actionTaken = await processDevice(device, state, accessToken, clientId)
      const isIdle = actionTaken === 'none' || actionTaken === 'idle (not in COOL mode)' ||
        actionTaken.startsWith('transition active, no step due yet')
      // DRY_RUN: always notify to confirm pipeline reach. Production: skip idle to avoid spam.
      if (!isIdle || DRY_RUN) {
        notifyActions.push({ name: device.name, action: actionTaken })
        await ntfy(
          `Panasonic AC ${device.name}`,
          actionTaken + (DRY_RUN ? ' [DRY_RUN]' : '')
        )
      }
    } catch (e) {
      console.error(`[${device.name}] Error:`, e?.stack || e)
      anyDeviceErrored = true
      await ntfy(`Panasonic AC ${device.name} ERROR`, e?.message || String(e), 'high')
    }
  }

  // 5. ALWAYS save state (rotated token + per-device transitions)
  await saveState(state)

  if (anyDeviceErrored) {
    throw new Error('One or more devices failed — see logs above')
  }
}

main().catch(async (e) => {
  console.error('Fatal:', e?.stack || e)
  try { await ntfy('Panasonic AC FATAL', e?.message || String(e), 'high') } catch {}
  process.exit(1)
})
