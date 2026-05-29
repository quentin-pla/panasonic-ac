// OPUS-DIRECT: ~25 LOC glue, seeds OAuth refresh token once on Mac.
// Run: node --env-file=.env seed-token.mjs
// Needs in .env: PANASONIC_USER, PANASONIC_PASS  (optional PANASONIC_APP_VERSION)
import { ComfortCloudClient } from 'panasonic-comfort-cloud-client'

const user = process.env.PANASONIC_USER
const pass = process.env.PANASONIC_PASS
if (!user || !pass) {
  console.error('Missing PANASONIC_USER / PANASONIC_PASS in .env')
  process.exit(1)
}

// Panasonic gates X-APP-VERSION server-side. Fetch current iOS Comfort Cloud
// version from iTunes Lookup (app id 1348640525) — same trick iobroker uses.
async function currentAppVersion() {
  if (process.env.PANASONIC_APP_VERSION) return process.env.PANASONIC_APP_VERSION
  try {
    const r = await fetch('https://itunes.apple.com/lookup?id=1348640525')
    const j = await r.json()
    return j?.results?.[0]?.version || '4.3.0'
  } catch { return '4.3.0' }
}

const appVersion = await currentAppVersion()
console.log('Using X-APP-VERSION =', appVersion)
const client = new ComfortCloudClient(appVersion)

try {
  await client.login(user, pass)
  console.log('\n=== COPY THESE INTO Scriptable ===')
  console.log('REFRESH_TOKEN=' + client.oauthClient.tokenRefresh)
  const groups = await client.getGroups()
  for (const g of groups)
    for (const d of g.devices) console.log('DEVICE_GUID=' + d.guid + '   (' + d.name + ')')
  console.log('==================================\n')
} catch (e) {
  console.error('\nLogin failed:', e?.message || e)
  console.error('If this is a reCAPTCHA / CSRF / login error, headless login is blocked.')
  console.error('Fallback: run interactive CLI ->  npx panasonic-comfort-cloud-client')
  process.exit(2)
}
