import { ComfortCloudClient, OperationMode, FanSpeed, EcoMode, Power } from 'panasonic-comfort-cloud-client'
import fs from 'node:fs/promises'
import path from 'node:path'

// ============================================================
// CONFIG
// ============================================================
const DEVICE_GUID         = process.env.PCC_DEVICE_GUID || ''
const DRY_RUN             = process.env.PCC_DRY_RUN === 'true'
const DRY_TARGET_TEMP     = 20
const STEP_INTERVALS_SEC  = { 5: 180, 4: 300, 3: 600, 2: 600, 1: 600 }
const STATE_FILE          = path.resolve('./state/pcc.json')
const NTFY_TOPIC          = process.env.NTFY_TOPIC || ''
const NTFY_BASE           = process.env.NTFY_BASE || 'https://ntfy.sh'
const APP_VERSION_OVERRIDE = process.env.PCC_APP_VERSION || ''
const APP_VERSION_FALLBACK = '4.3.0'

// ============================================================
// State helpers
// ============================================================
async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8')
    return JSON.parse(raw)
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    // File missing — bootstrap from env seed
    const seed = process.env.PCC_REFRESH
    if (!seed) throw new Error('No state file and PCC_REFRESH env not set — cannot bootstrap')
    return { refreshToken: seed, transition: null }
  }
}

async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

// ============================================================
// App version
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
// Notifications
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
// Transition plan builder — identical logic to Scriptable
// Enums are numeric: FanSpeed.High=5, EcoMode.Powerful=1, etc.
// Store numbers in params so JSON serializes cleanly.
// ============================================================
function buildTransitionPlan(currentFanSpeed, currentEcoMode) {
  let start
  if (currentEcoMode === EcoMode.Powerful) start = 5
  else if (currentFanSpeed >= 1 && currentFanSpeed <= 5) start = currentFanSpeed
  else start = 3

  const plan = []
  // Step 0: switch to DRY @ 20°C, clear Powerful, set starting fan
  plan.push({
    atSec: 0,
    params: {
      operate: Power.On,
      operationMode: OperationMode.Dry,
      temperatureSet: DRY_TARGET_TEMP,
      fanSpeed: start,
      ecoMode: EcoMode.Auto
    }
  })

  let t = 0, fs = start
  while (fs > 1) {
    t += STEP_INTERVALS_SEC[fs]
    fs -= 1
    plan.push({ atSec: t, params: { fanSpeed: fs } })
  }
  // Final: after the 1 interval, set Quiet (keep fan at 1)
  t += STEP_INTERVALS_SEC[1]
  plan.push({ atSec: t, params: { ecoMode: EcoMode.Quiet } })

  return plan
}

// ============================================================
// Main
// ============================================================
async function main() {
  const state = await loadState()
  const { refreshToken } = state
  if (!refreshToken) throw new Error('No refreshToken in state')

  const appVersion = await fetchAppVersion()
  console.log('app version:', appVersion)

  const client = new ComfortCloudClient(appVersion)
  await client.login(undefined, undefined, refreshToken)

  // Capture rotated token immediately — must persist even on downstream error
  const newRefresh = client.oauthClient.tokenRefresh
  state.refreshToken = newRefresh

  // Resolve device GUID
  let guid = DEVICE_GUID
  if (!guid) {
    const groups = await client.getGroups()
    if (!groups.length || !groups[0].devices || !groups[0].devices.length) {
      throw new Error('No devices found in account')
    }
    guid = groups[0].devices[0].guid
  }

  const device = await client.getDevice(guid)
  if (!device) throw new Error(`getDevice returned null for guid=${guid}`)

  const p = {
    inside:    device.insideTemperature,
    operate:   device.operate,
    mode:      device.operationMode,
    setTemp:   device.temperatureSet,
    fanSpeed:  device.fanSpeed,
    ecoMode:   device.ecoMode
  }
  console.log(`State: inside=${p.inside}C operate=${p.operate} mode=${p.mode} setTemp=${p.setTemp} fan=${p.fanSpeed} eco=${p.ecoMode}`)

  // ============================================================
  // State machine — verbatim port from Scriptable lines 378-464
  // loadTransition()   → state.transition
  // saveTransition(t)  → state.transition = t
  // clearTransition()  → state.transition = null
  // httpPost setParameters → await client.setParameters(guid, applyParams)
  // notify() → await ntfy()
  // ============================================================
  let applyError = null
  try {
    let active = state.transition
    let actionTaken = 'none'
    let applyParams = null
    let stateToPersist = null
    let clearAfterApply = false
    let immediateClear = false

    if (active) {
      // SAFETY: detect manual intervention → abort transition immediately
      if (p.operate === Power.Off) {
        immediateClear = true
        actionTaken = 'aborted (powered off)'
      } else if (p.mode !== OperationMode.Dry || Math.abs(p.setTemp - DRY_TARGET_TEMP) > 0.5) {
        immediateClear = true
        actionTaken = `aborted (user changed mode=${p.mode} setTemp=${p.setTemp})`
      } else {
        // Find latest plan step due now (atSec ≤ elapsed, idx > lastAppliedIdx)
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
      // No active transition — start one IFF device currently in COOL mode and on
      if (p.operate === Power.On && p.mode === OperationMode.Cool) {
        const plan = buildTransitionPlan(p.fanSpeed, p.ecoMode)
        stateToPersist = { startMs: Date.now(), plan, lastAppliedIdx: 0, deviceGuid: guid }
        applyParams = plan[0].params
        actionTaken = `started transition (initial fan=${plan[0].params.fanSpeed}, ${plan.length} steps, total ${plan[plan.length - 1].atSec}s)`
      } else {
        actionTaken = 'idle (not in COOL mode)'
      }
    }

    // Immediate clear for abort cases (no apply needed)
    if (immediateClear) state.transition = null

    // Apply parameters (if any). On throw, state is NOT advanced → step retries next run.
    let applySucceeded = false
    if (applyParams) {
      if (DRY_RUN) {
        console.log(`[DRY_RUN] would setParameters: ${JSON.stringify(applyParams)}`)
        applySucceeded = true
      } else {
        const ctrlResp = await client.setParameters(guid, applyParams)
        console.log(`setParameters response: ${JSON.stringify(ctrlResp?.data)}`)
        applySucceeded = true
      }
    }

    // Persist state — only after a successful apply
    if (applySucceeded) {
      if (clearAfterApply) state.transition = null
      else if (stateToPersist) state.transition = stateToPersist
    }

    console.log('Action:', actionTaken)
    await ntfy('Panasonic AC', actionTaken + (DRY_RUN ? ' [DRY_RUN]' : ''))
  } catch (e) {
    applyError = e
  }

  // Always save — rotated token must be persisted even on error
  await saveState(state)

  if (applyError) {
    await ntfy('Panasonic AC error', applyError.message || String(applyError), 'high')
    throw applyError
  }
}

main().catch(async e => {
  console.error('Fatal:', e?.stack || e)
  try { await ntfy('Panasonic AC FATAL', e?.message || String(e), 'high') } catch {}
  process.exit(1)
})
