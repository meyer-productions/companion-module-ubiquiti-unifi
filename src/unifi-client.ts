import { Agent } from 'undici'

const REQUEST_TIMEOUT_MS = 8000
const PAGE_LIMIT = 100
const MAX_PAGES = 20

// UniFi-OS consoles serve the Integration API behind a self-signed local certificate.
// This agent is scoped to UniFi client calls only, never applied globally.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } })

export type UnifiClientConfig = {
	host: string
	port: number
	siteId: string
	apiKey: string
}

export type UnifiSite = {
	id: string
	internalReference: string
	name: string
}

export type UnifiPoeInfo = {
	standard?: string
	type?: number
	enabled: boolean
	state: 'UP' | 'DOWN' | string
}

export type UnifiPort = {
	idx: number
	state: 'UP' | 'DOWN' | string
	connector?: string
	maxSpeedMbps?: number
	speedMbps?: number
	poe?: UnifiPoeInfo
}

export type UnifiDevice = {
	id: string
	macAddress: string
	ipAddress?: string
	name: string
	model: string
	state: 'ONLINE' | 'OFFLINE' | string
	firmwareVersion?: string
	features: string[]
	interfaces: string[]
}

export type UnifiDeviceDetail = UnifiDevice & {
	ports?: UnifiPort[]
}

export type UnifiClient = {
	id: string
	type: 'WIRED' | 'WIRELESS' | string
	name: string
	ipAddress?: string
	macAddress: string
	uplinkDeviceId?: string
}

export type UnifiResult<T> =
	| { outcome: 'ok'; data: T }
	| { outcome: 'unauthorized' }
	| { outcome: 'not-found' }
	| { outcome: 'timeout' }
	| { outcome: 'error'; message: string }

function baseUrl(config: UnifiClientConfig): string {
	return `https://${config.host}:${config.port}/proxy/network/integration/v1`
}

function errorMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === 'AbortError') return 'Timeout while connecting to the UniFi console'
		return err.message
	}
	return String(err)
}

async function request<T>(config: UnifiClientConfig, path: string): Promise<UnifiResult<T>> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(`${baseUrl(config)}${path}`, {
			method: 'GET',
			headers: { 'X-API-KEY': config.apiKey, Accept: 'application/json' },
			signal: controller.signal,
			dispatcher: insecureAgent,
		} as unknown as RequestInit)

		if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
		if (response.status === 404) return { outcome: 'not-found' }
		if (!response.ok) return { outcome: 'error', message: `HTTP ${response.status}` }

		const data = (await response.json()) as T
		return { outcome: 'ok', data }
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
		return { outcome: 'error', message: errorMessage(err) }
	} finally {
		clearTimeout(timeout)
	}
}

async function requestAction(config: UnifiClientConfig, path: string, action: string): Promise<UnifiResult<void>> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const response = await fetch(`${baseUrl(config)}${path}`, {
			method: 'POST',
			headers: {
				'X-API-KEY': config.apiKey,
				Accept: 'application/json',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ action }),
			signal: controller.signal,
			dispatcher: insecureAgent,
		} as unknown as RequestInit)

		if (response.status === 401 || response.status === 403) return { outcome: 'unauthorized' }
		if (response.status === 404) return { outcome: 'not-found' }
		if (!response.ok) {
			const body = await response.text().catch(() => '')
			return { outcome: 'error', message: `HTTP ${response.status}${body ? `: ${body}` : ''}` }
		}
		return { outcome: 'ok', data: undefined }
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') return { outcome: 'timeout' }
		return { outcome: 'error', message: errorMessage(err) }
	} finally {
		clearTimeout(timeout)
	}
}

type PagedResponse<T> = {
	offset: number
	limit: number
	count: number
	totalCount: number
	data: T[]
}

async function requestAllPages<T>(config: UnifiClientConfig, path: string): Promise<UnifiResult<T[]>> {
	const separator = path.includes('?') ? '&' : '?'
	const items: T[] = []
	for (let page = 0; page < MAX_PAGES; page++) {
		const offset = page * PAGE_LIMIT
		const result = await request<PagedResponse<T>>(config, `${path}${separator}limit=${PAGE_LIMIT}&offset=${offset}`)
		if (result.outcome !== 'ok') return result
		items.push(...result.data.data)
		if (items.length >= result.data.totalCount || result.data.data.length === 0) break
	}
	return { outcome: 'ok', data: items }
}

export async function getApplicationInfo(
	config: UnifiClientConfig,
): Promise<UnifiResult<{ applicationVersion: string }>> {
	return request(config, '/info')
}

export async function listSites(config: UnifiClientConfig): Promise<UnifiResult<UnifiSite[]>> {
	return requestAllPages(config, '/sites')
}

export async function listDevices(config: UnifiClientConfig): Promise<UnifiResult<UnifiDevice[]>> {
	return requestAllPages(config, `/sites/${config.siteId}/devices`)
}

/**
 * Returns all clients currently connected to the network (computers, phones, AV devices, ...).
 * Unlike devices there is no explicit "state" field: a client that is not connected (anymore) is simply
 * missing from the list instead of being marked "OFFLINE".
 */
export async function listClients(config: UnifiClientConfig): Promise<UnifiResult<UnifiClient[]>> {
	return requestAllPages(config, `/sites/${config.siteId}/clients`)
}

export async function getDevice(config: UnifiClientConfig, deviceId: string): Promise<UnifiResult<UnifiDeviceDetail>> {
	const result = await request<Record<string, unknown>>(config, `/sites/${config.siteId}/devices/${deviceId}`)
	if (result.outcome !== 'ok') return result
	const raw = result.data
	const interfaces = raw.interfaces as { ports?: UnifiPort[] } | undefined
	return {
		outcome: 'ok',
		data: {
			...(raw as unknown as UnifiDevice),
			ports: interfaces?.ports ?? [],
		},
	}
}

export async function restartDevice(config: UnifiClientConfig, deviceId: string): Promise<UnifiResult<void>> {
	return requestAction(config, `/sites/${config.siteId}/devices/${deviceId}/actions`, 'RESTART')
}

export async function powerCyclePort(
	config: UnifiClientConfig,
	deviceId: string,
	portIdx: number,
): Promise<UnifiResult<void>> {
	return requestAction(
		config,
		`/sites/${config.siteId}/devices/${deviceId}/interfaces/ports/${portIdx}/actions`,
		'POWER_CYCLE',
	)
}
