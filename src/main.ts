import {
	InstanceBase,
	InstanceStatus,
	type CompanionOptionValues,
	type SomeCompanionConfigField,
	type DropdownChoice,
	type CompanionInputFieldDropdown,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig, type ModuleSecrets } from './config.js'
import { UpdateVariableDefinitions, slugify, slugifyMac, type VariablesSchema } from './variables.js'
import { UpgradeScripts, MIGRATED_PORT_OPTION } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import {
	getApplicationInfo,
	listSites,
	listDevices,
	listClients,
	getDevice,
	restartDevice as restartDeviceRequest,
	powerCyclePort as powerCyclePortRequest,
	type UnifiDevice,
	type UnifiDeviceDetail,
	type UnifiClientConfig,
	type UnifiResult,
	type UnifiSite,
} from './unifi-client.js'
import { setPortPoeMode, type UnifiLegacyConfig } from './unifi-legacy-client.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: ModuleSecrets
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

const MAC_PATTERN = /^[0-9a-f]{2}([:-]?[0-9a-f]{2}){5}$/i

function normalizeMac(value: string): string {
	return value.toLowerCase().replace(/[^0-9a-f]/g, '')
}

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig // Setup in init()
	secrets!: ModuleSecrets // Setup in init()

	devices: UnifiDevice[] = []
	deviceDetails: Map<string, UnifiDeviceDetail> = new Map()
	/** Every client seen during this session (key: MAC address), used for stable online/offline variables. */
	knownClients: Map<string, { name: string; ipAddress?: string; macAddress: string }> = new Map()
	private connectedClientMacs: Set<string> = new Set()
	/** Number of currently connected clients per uplink device (key: device ID), e.g. clients per access point. */
	private clientCountByUplink: Map<string, number> = new Map()
	applicationVersion = ''
	lastActionResult = ''
	/** Resolved site UUID (the Integration API only accepts UUIDs, no "default" alias like the old API). */
	private resolvedSiteId = ''
	/** Sites found on the last successful connection, used to offer the site as a dropdown in the config UI. */
	knownSites: UnifiSite[] = []

	private pollTimer: ReturnType<typeof setInterval> | undefined

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig, _isFirstInit: boolean, secrets: ModuleSecrets): Promise<void> {
		this.config = config
		this.secrets = secrets

		this.setVariableValues({
			connection_status: 'unknown',
			application_version: '',
			site_id: config.siteId,
			device_count: 0,
			device_count_online: 0,
			last_poll_time: '',
			last_action_result: '',
		})

		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()

		await this.refreshDevices()
		this.startPolling()
	}

	async destroy(): Promise<void> {
		this.stopPolling()
	}

	async configUpdated(config: ModuleConfig, secrets: ModuleSecrets): Promise<void> {
		this.stopPolling()
		this.config = config
		this.secrets = secrets

		// Config dependent definitions (e.g. the legacy PoE action) must follow the config even when offline.
		this.updateActions()
		this.updateFeedbacks()

		await this.refreshDevices()
		this.startPolling()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields(this.knownSites)
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	getDeviceChoices(): DropdownChoice[] {
		return this.devices.map((device) => ({ id: device.id, label: `${device.name} (${device.model})` }))
	}

	/** Device dropdown limited to switches (only those have ports), used by the power cycle/PoE actions and feedbacks. */
	getSwitchChoices(): DropdownChoice[] {
		return this.devices
			.filter((device) => device.features.includes('switching'))
			.map((device) => ({ id: device.id, label: `${device.name} (${device.model})` }))
	}

	/** All PoE capable port indices of a single switch (sorted). */
	getSwitchPortChoices(deviceId: string): DropdownChoice[] {
		const indices = new Set<number>()
		for (const port of this.deviceDetails.get(deviceId)?.ports ?? []) {
			if (!port.poe) continue
			indices.add(port.idx)
		}
		return Array.from(indices)
			.sort((a, b) => a - b)
			.map((idx) => ({ id: idx, label: `Port ${idx}` }))
	}

	/** ID of the port dropdown that is generated per switch and shown/hidden dynamically. */
	portFieldId(deviceId: string): string {
		return `portIdx__${deviceId}`
	}

	/**
	 * Builds a "Switch" dropdown plus one hidden port dropdown per switch that only offers the real ports of
	 * that switch. Companion cannot filter a dropdown based on another option, but `isVisibleExpression` can
	 * show/hide whole fields - so only the port field matching the selected switch is visible. To the user it
	 * looks like a single "Port" field that never offers more ports than the selected switch actually has.
	 */
	getSwitchAndPortFields(): CompanionInputFieldDropdown[] {
		const switchChoices = this.getSwitchChoices()
		const fields: CompanionInputFieldDropdown[] = [
			{
				type: 'dropdown',
				id: 'deviceId',
				label: 'Switch',
				tooltip: 'A switch MAC address is accepted as well (used by actions migrated from older module versions).',
				choices: switchChoices,
				default: switchChoices[0]?.id ?? '',
				allowCustom: true,
				disableAutoExpression: true,
			},
		]

		for (const { id: deviceId } of switchChoices) {
			const portChoices = this.getSwitchPortChoices(String(deviceId))
			fields.push({
				type: 'dropdown',
				id: this.portFieldId(String(deviceId)),
				label: 'Port',
				choices: portChoices,
				default: portChoices[0]?.id ?? 1,
				isVisibleExpression: `$(options:deviceId) == "${deviceId}"`,
			})
		}

		return fields
	}

	/**
	 * Resolves the selected switch to a device ID. Besides the device ID itself a MAC address is accepted,
	 * which is what actions migrated from the old node-unifi based module versions contain.
	 */
	resolveSwitchId(value: string): string {
		if (!value) return ''
		if (this.devices.some((device) => device.id === value)) return value
		const mac = normalizeMac(value)
		const match = this.devices.find((device) => normalizeMac(device.macAddress) === mac)
		if (match) return match.id
		// A MAC address that matches no known device must not be sent to the API as a device ID.
		return MAC_PATTERN.test(value) ? '' : value
	}

	/** Reads the switch/port selection of an action or feedback built with getSwitchAndPortFields. */
	getPortSelection(options: CompanionOptionValues): { deviceId: string; portIdx: number } | undefined {
		const rawDeviceId = typeof options.deviceId === 'string' ? options.deviceId.trim() : ''
		if (!rawDeviceId) return undefined
		const deviceId = this.resolveSwitchId(rawDeviceId)
		if (!deviceId) return undefined
		const portIdx = Number(
			options[this.portFieldId(rawDeviceId)] ?? options[this.portFieldId(deviceId)] ?? options[MIGRATED_PORT_OPTION],
		)
		if (!Number.isInteger(portIdx) || portIdx < 1) return undefined
		return { deviceId, portIdx }
	}

	/** Dropdown choices of all clients seen so far, sorted alphabetically - used by the clientOnline feedback. */
	getClientChoices(): DropdownChoice[] {
		return Array.from(this.knownClients.values())
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((client) => ({
				id: client.macAddress,
				label: `${client.name}${client.ipAddress ? ` (${client.ipAddress})` : ''}`,
			}))
	}

	/** Whether the client with this MAC address is currently connected to the network. */
	isClientOnline(macAddress: string): boolean {
		return this.connectedClientMacs.has(macAddress.toLowerCase())
	}

	/** Number of clients currently connected to a specific device (e.g. an access point). */
	getClientCount(deviceId: string): number {
		return this.clientCountByUplink.get(deviceId) ?? 0
	}

	private clientConfig(): UnifiClientConfig {
		return {
			host: this.config.host,
			port: this.config.port,
			siteId: this.resolvedSiteId || this.config.siteId,
			apiKey: this.secrets.apiKey,
		}
	}

	/**
	 * Resolves the configured site ID against `GET /sites`. The Integration API only accepts real site UUIDs -
	 * unlike the old API it has no "default" alias. So that the default config value ("default") still works,
	 * the site is matched by name/internalReference/ID; with exactly one site that site is always used,
	 * regardless of the configured value.
	 */
	private async resolveSiteId(): Promise<UnifiResult<string>> {
		const sitesResult = await listSites(this.clientConfig())
		if (sitesResult.outcome !== 'ok') return sitesResult
		this.knownSites = sitesResult.data

		if (sitesResult.data.length > 1) {
			this.log(
				'info',
				`Multiple sites found: ${sitesResult.data.map((site) => `${site.name} (${site.id})`).join(', ')}`,
			)
		}

		if (sitesResult.data.length === 1) {
			return { outcome: 'ok', data: sitesResult.data[0].id }
		}

		const wanted = this.config.siteId?.trim()
		const match = sitesResult.data.find(
			(site) => site.id === wanted || site.internalReference === wanted || site.name === wanted,
		)
		if (!match) return { outcome: 'not-found' }
		return { outcome: 'ok', data: match.id }
	}

	private legacyConfig(): UnifiLegacyConfig {
		// The legacy API addresses sites by their short name (internalReference, e.g. "default"), not by UUID.
		const site = this.knownSites.find((candidate) => candidate.id === this.resolvedSiteId)
		return {
			host: this.config.host,
			port: this.config.port,
			siteId: site?.internalReference || this.config.siteId,
			username: this.config.legacyUsername,
			password: this.secrets.legacyPassword,
		}
	}

	private stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = undefined
		}
	}

	private startPolling(): void {
		this.stopPolling()

		const seconds = this.config.pollInterval

		if (!seconds || seconds <= 0) {
			return
		}

		this.pollTimer = setInterval(() => {
			this.pollState().catch((error) => {
				this.log('error', `Polling failed: ${error instanceof Error ? error.message : String(error)}`)
			})
		}, seconds * 1000)
	}

	/** Reloads the complete device/port list and rebuilds dropdown choices and presets. */
	async refreshDevices(): Promise<void> {
		if (!this.config.host || !this.secrets.apiKey) {
			this.updateStatus(InstanceStatus.BadConfig, 'Host and API key are required.')
			return
		}

		const infoResult = await getApplicationInfo(this.clientConfig())
		if (infoResult.outcome !== 'ok') {
			this.applyConnectionError(infoResult, 'Connection to the UniFi console failed.')
			return
		}
		this.applicationVersion = infoResult.data.applicationVersion

		const siteResult = await this.resolveSiteId()
		if (siteResult.outcome !== 'ok') {
			this.applyConnectionError(siteResult, `Site "${this.config.siteId}" could not be resolved.`)
			return
		}
		this.resolvedSiteId = siteResult.data

		const devicesResult = await listDevices(this.clientConfig())
		if (devicesResult.outcome !== 'ok') {
			this.applyConnectionError(devicesResult, 'Device list could not be loaded.')
			return
		}
		this.devices = devicesResult.data

		await this.refreshSwitchPortDetails()
		await this.refreshClients()

		this.updateStatus(InstanceStatus.Ok)
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()
		this.checkFeedbacks('deviceOnline', 'portPoePowered', 'clientOnline')
		this.updateConnectionVariables()
		this.updateDeviceAndPortVariables()
		this.updateClientVariables()
	}

	/** Regular, lightweight poll: online state + PoE state, without rebuilding dropdowns/presets. */
	async pollState(): Promise<void> {
		const devicesResult = await listDevices(this.clientConfig())
		if (devicesResult.outcome !== 'ok') {
			this.applyConnectionError(devicesResult, 'Polling failed.')
			return
		}
		this.devices = devicesResult.data

		await this.refreshSwitchPortDetails()
		const clientsChanged = await this.refreshClients()
		if (clientsChanged) {
			this.updateVariableDefinitions()
			this.updateFeedbacks()
		}

		this.updateStatus(InstanceStatus.Ok)
		this.checkFeedbacks('deviceOnline', 'portPoePowered', 'clientOnline')
		this.updateConnectionVariables()
		this.updateDeviceAndPortVariables()
		this.updateClientVariables()
	}

	private async refreshSwitchPortDetails(): Promise<void> {
		const switches = this.devices.filter((device) => device.features.includes('switching'))
		for (const device of switches) {
			const detailResult = await getDevice(this.clientConfig(), device.id)
			if (detailResult.outcome === 'ok') {
				this.deviceDetails.set(device.id, detailResult.data)
			}
		}
	}

	/**
	 * Queries the currently connected clients and maintains `knownClients`/`connectedClientMacs`.
	 * The clients API only returns connected clients (there is no "OFFLINE" state), so the module remembers
	 * every client it has seen and derives "offline" from a client missing in the current response.
	 * Returns whether new clients were added (variable definitions need to be rebuilt then).
	 */
	private async refreshClients(): Promise<boolean> {
		const clientsResult = await listClients(this.clientConfig())
		if (clientsResult.outcome !== 'ok') {
			this.log('warn', `Clients could not be queried: ${clientsResult.outcome}`)
			return false
		}

		let hasNewClients = false
		const connectedMacs = new Set<string>()
		const countByUplink = new Map<string, number>()
		for (const client of clientsResult.data) {
			if (client.uplinkDeviceId) {
				countByUplink.set(client.uplinkDeviceId, (countByUplink.get(client.uplinkDeviceId) ?? 0) + 1)
			}
			// VPN/Teleport clients have no MAC address and cannot be tracked by it.
			if (!client.macAddress) continue
			const macAddress = client.macAddress.toLowerCase()
			connectedMacs.add(macAddress)
			if (!this.knownClients.has(macAddress)) hasNewClients = true
			this.knownClients.set(macAddress, {
				name: client.name || macAddress,
				ipAddress: client.ipAddress,
				macAddress,
			})
		}
		this.connectedClientMacs = connectedMacs
		this.clientCountByUplink = countByUplink
		return hasNewClients
	}

	/** Updates the client_<mac>_online variables from `connectedClientMacs`. */
	private updateClientVariables(): void {
		const values: Record<string, string | number> = {}
		for (const client of this.knownClients.values()) {
			values[`client_${slugifyMac(client.macAddress)}_online`] = this.connectedClientMacs.has(client.macAddress)
				? 'Online'
				: 'Offline'
		}
		this.setVariableValues(values)
	}

	private updateConnectionVariables(): void {
		this.setVariableValues({
			connection_status: 'ok',
			application_version: this.applicationVersion,
			site_id: this.resolvedSiteId || this.config.siteId,
			device_count: this.devices.length,
			device_count_online: this.devices.filter((device) => device.state === 'ONLINE').length,
			last_poll_time: new Date().toLocaleString(),
			last_action_result: this.lastActionResult,
		})
	}

	/** Updates the variables generated per device/port (link/PoE state). */
	private updateDeviceAndPortVariables(): void {
		const values: Record<string, string | number> = {}

		for (const device of this.devices) {
			const slug = slugify(device.name)
			values[`device_${slug}_online`] = device.state === 'ONLINE' ? 'Online' : 'Offline'
			if (device.features.includes('accessPoint')) {
				values[`device_${slug}_client_count`] = this.getClientCount(device.id)
			}
		}

		for (const detail of this.deviceDetails.values()) {
			const slug = slugify(detail.name)
			for (const port of detail.ports ?? []) {
				if (!port.poe) continue
				values[`port_${slug}_${port.idx}_link`] = port.state === 'UP' ? 'up' : 'down'
				values[`port_${slug}_${port.idx}_poe`] = port.poe.state === 'UP' ? 'up' : 'down'
				values[`port_${slug}_${port.idx}_poe_enabled`] = port.poe.enabled ? 'ON' : 'OFF'
			}
		}

		this.setVariableValues(values)
	}

	private applyConnectionError(result: UnifiResult<unknown>, context: string): void {
		const detail = result.outcome === 'error' ? result.message : result.outcome
		const fullMessage = `${context} (${detail})`

		if (result.outcome === 'unauthorized') {
			this.updateStatus(InstanceStatus.AuthenticationFailure, fullMessage)
		} else if (result.outcome === 'not-found') {
			this.updateStatus(InstanceStatus.UnknownError, fullMessage)
		} else {
			this.updateStatus(InstanceStatus.ConnectionFailure, fullMessage)
		}
		this.setVariableValues({ connection_status: result.outcome })
		this.log('warn', fullMessage)
	}

	async restartDevice(deviceId: string): Promise<void> {
		const result = await restartDeviceRequest(this.clientConfig(), deviceId)
		this.recordActionResult(`restartDevice(${deviceId})`, result)
	}

	async powerCyclePort(deviceId: string, portIdx: number): Promise<void> {
		const result = await powerCyclePortRequest(this.clientConfig(), deviceId, portIdx)
		this.recordActionResult(`powerCyclePort(${deviceId}:${portIdx})`, result)
	}

	/** Legacy path: persistent PoE on/off via the private controller API (see unifi-legacy-client.ts). */
	async setPortPoePersistent(deviceId: string, portIdx: number, enabled: boolean): Promise<void> {
		const device = this.devices.find((candidate) => candidate.id === deviceId)
		if (!device) {
			this.log('warn', `setPortPoePersistent: device ${deviceId} not found in cache - refresh the device list first.`)
			return
		}

		const result = await setPortPoeMode(this.legacyConfig(), device.macAddress, portIdx, enabled ? 'auto' : 'off')
		this.recordActionResult(`setPortPoePersistent(${deviceId}:${portIdx}, ${enabled ? 'on' : 'off'})`, result)

		if (result.outcome === 'ok') {
			await this.refreshSwitchPortDetails()
			this.checkFeedbacks('portPoePowered')
		}
	}

	private recordActionResult(label: string, result: { outcome: string; message?: string }): void {
		this.lastActionResult = `${label}: ${result.outcome}${result.message ? ` (${result.message})` : ''}`
		this.setVariableValues({ last_action_result: this.lastActionResult })

		if (result.outcome === 'ok') {
			this.log('info', `${label} succeeded.`)
		} else {
			this.log('warn', `${label} failed: ${result.outcome}${result.message ? ` - ${result.message}` : ''}`)
		}
	}
}
