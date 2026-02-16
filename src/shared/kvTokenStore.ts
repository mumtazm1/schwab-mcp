import {
	KVTokenStore as SDKKVTokenStore,
	type TokenIdentifiers,
	type KVNamespace,
} from '@sudowealth/schwab-api'
import { TOKEN_KEY_PREFIX, TTL_31_DAYS } from './constants'
import { logger } from './log'

// Create a type that matches the existing interface
export interface KvTokenStore<T = any> {
	load(ids: TokenIdentifiers): Promise<T | null>
	save(ids: TokenIdentifiers, data: T): Promise<void>
	kvKey(ids: TokenIdentifiers): string
	migrate(fromIds: TokenIdentifiers, toIds: TokenIdentifiers): Promise<boolean>
	migrateIfNeeded(
		fromIds: TokenIdentifiers,
		toIds: TokenIdentifiers,
	): Promise<void>
}

/**
 * Creates a KV-backed token store using the SDK implementation
 * This maintains backward compatibility with the existing interface
 */
export function makeKvTokenStore<T = any>(kv: KVNamespace): KvTokenStore<T> {
	const sdkStore = new SDKKVTokenStore(kv, {
		keyPrefix: TOKEN_KEY_PREFIX,
		ttl: TTL_31_DAYS,
		autoMigrate: true,
	})

	// Generate key helper
	const generateKey = (ids: TokenIdentifiers): string => {
		if (ids.schwabUserId) return `${TOKEN_KEY_PREFIX}${ids.schwabUserId}`
		if (ids.clientId) return `${TOKEN_KEY_PREFIX}${ids.clientId}`
		throw new Error('No identifier provided for token key')
	}

	return {
		load: async (ids: TokenIdentifiers) => {
			const key = generateKey(ids)
			const value = await kv.get(key, 'json')
			return value as T | null
		},
		save: async (ids: TokenIdentifiers, data: T) => {
			const key = generateKey(ids)
			await kv.put(key, JSON.stringify(data), { expirationTtl: TTL_31_DAYS })
		},
		kvKey: (ids: TokenIdentifiers) => {
			return generateKey(ids)
		},
		migrate: async (fromIds: TokenIdentifiers, toIds: TokenIdentifiers) => {
			return sdkStore.migrate(fromIds, toIds)
		},
		migrateIfNeeded: async (
			fromIds: TokenIdentifiers,
			toIds: TokenIdentifiers,
		) => {
			const success = await sdkStore.migrate(fromIds, toIds)
			if (!success) {
				logger.warn('Token migration was not needed or failed', {
					from: sdkStore.generateKey(fromIds),
					to: sdkStore.generateKey(toIds),
				})
			}
		},
	}
}

// Re-export the type for backward compatibility
export type { TokenIdentifiers }
