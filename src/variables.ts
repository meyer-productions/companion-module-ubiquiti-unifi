import type {
	CompanionVariableDefinition,
	CompanionVariableDefinitions,
	CompanionVariableValue,
} from '@companion-module/base'
import type ModuleInstance from './main.js'

export type VariablesSchema = {
	connection_status: string
	application_version: string
	site_id: string
	device_count: number
	device_count_online: number
	last_poll_time: string
	last_action_result: string
	// Variables generated per device/port (device_<slug>_online, port_<slug>_<idx>_link, ...).
	[key: string]: CompanionVariableValue
}

/** Converts a device name into a slug that is safe for variable IDs, e.g. "FOH-SW-Audio" -> "foh_sw_audio". */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}

/** Converts a MAC address into a stable variable ID part, e.g. "e0:63:da:3f:85:4e" -> "e0_63_da_3f_85_4e". */
export function slugifyMac(macAddress: string): string {
	return macAddress.toLowerCase().replace(/[^a-z0-9]+/g, '_')
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const definitions: Record<string, CompanionVariableDefinition> = {
		connection_status: { name: 'Connection status' },
		application_version: { name: 'UniFi Network application version' },
		site_id: { name: 'Site ID' },
		device_count: { name: 'Number of devices' },
		device_count_online: { name: 'Number of devices online' },
		last_poll_time: { name: 'Last update' },
		last_action_result: { name: 'Last action result' },
	}

	for (const device of self.devices) {
		const slug = slugify(device.name)
		definitions[`device_${slug}_online`] = { name: `${device.name}: online (Online/Offline)` }
		if (device.features.includes('accessPoint')) {
			definitions[`device_${slug}_client_count`] = { name: `${device.name}: connected clients` }
		}
	}

	for (const detail of self.deviceDetails.values()) {
		const slug = slugify(detail.name)
		for (const port of detail.ports ?? []) {
			if (!port.poe) continue
			definitions[`port_${slug}_${port.idx}_link`] = { name: `${detail.name} port ${port.idx}: link state (up/down)` }
			definitions[`port_${slug}_${port.idx}_poe`] = {
				name: `${detail.name} port ${port.idx}: PoE delivering power (up/down)`,
			}
			definitions[`port_${slug}_${port.idx}_poe_enabled`] = {
				name: `${detail.name} port ${port.idx}: PoE enabled (ON/OFF)`,
			}
		}
	}

	for (const client of self.knownClients.values()) {
		const macSlug = slugifyMac(client.macAddress)
		definitions[`client_${macSlug}_online`] = {
			name: `Client "${client.name}"${client.ipAddress ? ` (${client.ipAddress})` : ''}: online (Online/Offline)`,
		}
	}

	self.setVariableDefinitions(definitions as CompanionVariableDefinitions<VariablesSchema>)
}
