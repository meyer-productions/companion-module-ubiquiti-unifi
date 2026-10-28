import { Agent } from 'undici'
import { httpErrorMessage } from './unifi-client.js'

// EXPERIMENTAL / LEGACY: talks to the old private UniFi-OS controller API because the
// official Integration API has no config-write endpoint for ports (verified: no
// port-profiles resource, PATCH/PUT on device and port resources both rejected).
// This is exactly the fragile API surface the rest of this module deliberately avoids —
// keep it isolated here, never call it from the main polling loop, and never trust it
// to stay stable across firmware updates. Requires a LOCAL admin account without
// 2FA/Cloud-SSO (the Ubiquiti cloud account flow does not work with this login endpoint).

const REQUEST_TIMEOUT_MS = 8000
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })

export type UnifiLegacyConfig = {
	host: string
	port: number
	siteId: string
	username: string
	password: string
}

export type UnifiLegacyResult<T> =
	| { outcome: 'ok'; data: T }
	| { outcome: 'unauthorized' }
	| { outcome: 'not-found' }
	| { outcome: 'timeout' }
	| { outcome: 'error'; message: string }

type LegacySession = {
	cookie: string
	csrfToken?: string
}

type ClassicPortOverride = {
	port_idx: number
	portconf_id?: string
	poe_mode?: string
	[key: string]: unknown
}

type ClassicDevice = {
	_id: string
	mac: string
	port_overrides?: ClassicPortOverride[]
	port_table?: Array<{ port_idx: number; portconf_id?: string }>
	[key: string]: unknown
}

function baseUrl(config: UnifiLegacyConfig): string {
	return `https://${config.host}:${config.port}`
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'AbortError') return 'Timeout while connecting to the UniFi console (legacy API)'
		return err.message
	}
	return String(err)
}

type RawResponse = { status: number; ok: boolean; headers: Headers; body: string }

/** Fetches a URL and reads the whole body within the same timeout (so a stalled body cannot hang forever). */
async function rawFetch(url: string, init: RequestInit): Promise<RawResponse> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(url, {
			...init,
			signal: controller.signal,
			dispatcher: insecureAgent,
		} as unknown as RequestInit)
		const body = await response.text()
		return { status: response.status, ok: response.ok, headers: response.headers, body }
	} finally {
		clearTimeout(timeout)
	}
}

/** The classic API can report errors inside an HTTP 200 response (`meta.rc !== 'ok'`). */
function classicError(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { meta?: { rc?: unknown } }
		if (parsed.meta?.rc !== undefined && parsed.meta.rc !== 'ok') return httpErrorMessage(200, body)
	} catch {
		return 'Invalid response from the classic controller API'
	}
	return undefined
}

export async function login(config: UnifiLegacyConfig): Promise<UnifiLegacyResult<LegacySession>> {
	try {
		const response = await rawFetch(`${baseUrl(config)}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
			body: JSON.stringify({ username: config.username, password: config.password }),
		})

		if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
		if (!response.ok)
			return { outcome: 'error', message: `Login failed: ${httpErrorMessage(response.status, response.body)}` }

		const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
		if (setCookies.length === 0) return { outcome: 'error', message: 'Login response did not contain session cookies' }

		const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
		const csrfToken = response.headers.get('x-csrf-token') ?? undefined
		return { outcome: 'ok', data: { cookie, csrfToken } }
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
		return { outcome: 'error', message: errorMessage(err) }
	}
}

async function getClassicDeviceByMac(
	session: LegacySession,
	config: UnifiLegacyConfig,
	macAddress: string,
): Promise<UnifiLegacyResult<ClassicDevice>> {
	try {
		const response = await rawFetch(
			`${baseUrl(config)}/proxy/network/api/s/${config.siteId}/stat/device/${macAddress.toLowerCase()}`,
			{
				method: 'GET',
				headers: { Cookie: session.cookie, Accept: 'application/json' },
			},
		)
		if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
		if (response.status === 404) return { outcome: 'not-found' }
		if (!response.ok) return { outcome: 'error', message: httpErrorMessage(response.status, response.body) }
		const apiError = classicError(response.body)
		if (apiError) return { outcome: 'error', message: apiError }

		const body = JSON.parse(response.body) as { data?: ClassicDevice[] }
		const device = body.data?.[0]
		if (!device) return { outcome: 'not-found' }
		return { outcome: 'ok', data: device }
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
		return { outcome: 'error', message: errorMessage(err) }
	}
}

/**
 * Persistently sets a switch port's PoE mode via the classic REST device endpoint.
 * Merges into the existing `port_overrides` array so other ports are left untouched.
 * `poeMode` is the classic API's own vocabulary ('auto' = PoE on, 'off' = PoE off).
 */
export async function setPortPoeMode(
	config: UnifiLegacyConfig,
	macAddress: string,
	portIdx: number,
	poeMode: 'auto' | 'off',
): Promise<UnifiLegacyResult<void>> {
	const sessionResult = await login(config)
	if (sessionResult.outcome !== 'ok') return sessionResult
	const session = sessionResult.data

	const deviceResult = await getClassicDeviceByMac(session, config, macAddress)
	if (deviceResult.outcome !== 'ok') return deviceResult
	const device = deviceResult.data

	const existingOverrides = device.port_overrides ?? []
	const existingIndex = existingOverrides.findIndex((o) => o.port_idx === portIdx)
	const existingPortConfId =
		existingOverrides[existingIndex]?.portconf_id ?? device.port_table?.find((p) => p.port_idx === portIdx)?.portconf_id

	const nextOverrides = [...existingOverrides]
	const nextOverride: ClassicPortOverride = {
		...(existingIndex >= 0 ? existingOverrides[existingIndex] : {}),
		port_idx: portIdx,
		poe_mode: poeMode,
		...(existingPortConfId ? { portconf_id: existingPortConfId } : {}),
	}
	if (existingIndex >= 0) {
		nextOverrides[existingIndex] = nextOverride
	} else {
		nextOverrides.push(nextOverride)
	}

	try {
		const response = await rawFetch(
			`${baseUrl(config)}/proxy/network/api/s/${config.siteId}/rest/device/${device._id}`,
			{
				method: 'PUT',
				headers: {
					Cookie: session.cookie,
					'Content-Type': 'application/json',
					Accept: 'application/json',
					...(session.csrfToken ? { 'X-Csrf-Token': session.csrfToken } : {}),
				},
				body: JSON.stringify({ port_overrides: nextOverrides }),
			},
		)
		if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
		if (!response.ok) return { outcome: 'error', message: httpErrorMessage(response.status, response.body) }
		const apiError = classicError(response.body)
		if (apiError) return { outcome: 'error', message: apiError }
		return { outcome: 'ok', data: undefined }
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
		return { outcome: 'error', message: errorMessage(err) }
	}
}
