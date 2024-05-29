import type { NonNull } from './types/select.js';
import type {
  ApiFilterHookMetaData,
  DirectusFilterHookFunction,
  DirectusHookRegisterFunctions,
  DirectusRuntimeContext,
  Item,
  PrimaryKey,
} from './directus.js';
import { createHash } from 'crypto';

export type FivesparkMonitorHookMutations<T = Item> = Array<{
  action: 'create' | 'update';
  /** Primary key of the item */
  key: PrimaryKey;
  /** Old data for monitored fields */
  previous: Partial<T>;
  /** New data for monitored fields */
  current: Partial<T>;
}>;
export type FivesparkMonitorHookCallbackFunction<T extends Item = Item> = (
  mutations: FivesparkMonitorHookMutations<T>,
  meta: { collection: string; event: string; payload: Partial<T> },
  context: NonNull<Parameters<Parameters<DirectusHookRegisterFunctions['action']>[1]>[1], 'schema' | 'accountability'>,
) => void | Promise<void>;
export type FivesparkMonitorHookCallback<T = Item> = (
  payload: FivesparkMonitorHookMutations<T>,
  meta: ApiFilterHookMetaData,
  context: NonNull<Parameters<Parameters<DirectusHookRegisterFunctions['filter']>[1]>[1], 'schema' | 'accountability'>,
) => any;
export type FivesparkMonitorHookFunction<T = Item> = (
  event: string,
  /**
   * Fields to monitor for changes. Pass empty array to monitor all fields.
   */
  monitorFields: string[],
  handler: FivesparkMonitorHookCallback<T>,
) => void;

let lastHookId = 0;
export function createMonitorHook(
  directus: DirectusRuntimeContext,
  filter: DirectusFilterHookFunction,
  action: DirectusHookRegisterFunctions['action'],
) {
  return function monitor<ItemType extends Item>(
    monitorCollection: string,
    monitorFields: string[],
    handler: FivesparkMonitorHookCallbackFunction<ItemType>,
  ) {
    const logger = directus.logger.child({}, { msgPrefix: '[monitor hook]' });
    const mutationsInProgress: Record<
      string,
      {
        timestamp: number;
        event: string;
        keys: PrimaryKey[];
        fields: string[];
        current: Array<{ key?: PrimaryKey; data: Partial<ItemType> }>;
      }
    > = {};

    const events = [`${monitorCollection}.items.create`, `${monitorCollection}.items.update`];
    const hookId = lastHookId++;
    const createFingerprint = (event: string, keys: PrimaryKey[] | undefined) => {
      return createHash('md5')
        .update(JSON.stringify({ hookId, event, keys: keys?.sort() }))
        .digest('hex');
    };
    events.forEach((event) => {
      // Use filter hook to prepare mutations array
      filter(event, async (payload: Partial<ItemType>, meta, context) => {
        if (meta.event.endsWith('.items.create')) {
          // No need to get current values for create events (NOTE we could also prevent binding the filter hook for this event)
          return;
        }
        if (!meta.event.endsWith('.items.update')) {
          // Not an update event, error
          throw new Error(`Unexpected event ${meta.event}`);
        }
        const { collection } = meta;
        const { schema, accountability } = context;
        const fields = Object.keys(payload).filter(
          (field) => monitorFields.length === 0 || monitorFields.includes(field),
        );
        const keys = (meta.keys ?? [meta.key]) as PrimaryKey[];

        // Fingerprint this event so we can add it to the mutationsInProgress object
        const fingerprint = createFingerprint(event, keys);

        // Fetch current data of changed items
        const itemsService = new directus.services.ItemsService<ItemType>(collection, { schema, accountability });
        const primaryKeyField = schema.collections[collection].primary;
        const currentItems = await itemsService.readMany(keys, {
          fields: [primaryKeyField, ...fields],
          limit: keys.length,
        });

        mutationsInProgress[fingerprint] = {
          timestamp: Date.now(),
          event,
          keys,
          fields,
          current: currentItems.map((item) => {
            const key = item[primaryKeyField];
            const data = { ...item };
            delete data[primaryKeyField];
            return { key, data };
          }),
        };

        // Check if there are very old mutations in progress that we should remove.
        // This can happen if a database update failed, so the corresponding action hook never fired
        // and no new update was executed on the same item(s) afterwards.
        const now = Date.now();
        // eslint-disable-next-line no-magic-numbers
        const FIVE_MINUTES = 1000 * 60 * 5;
        const oldMutations = Object.keys(mutationsInProgress).filter(
          (key) => now - (mutationsInProgress[key] as any).timestamp > FIVE_MINUTES,
        );
        for (const fingerprint of oldMutations) {
          logger.warn(
            `removing old in progress mutation ${fingerprint} because the corresponding action hook never fired`,
          );
          delete mutationsInProgress[fingerprint];
        }
      });

      // Use action hook to trigger the callback after data has been committed to the database
      action(event, async (meta, context) => {
        const { collection, payload } = meta;
        if (event.endsWith('.items.create')) {
          // Shortcut for create events, we don't need to compare with previous data
          const current = { ...payload };
          // Remove fields not being monitored
          for (const key of Object.keys(current)) {
            if (!monitorFields.includes(key)) {
              delete current[key];
            }
          }
          // Set monitored fields not being set to null
          for (const field of monitorFields) {
            if (typeof current[field] === 'undefined') {
              current[field] = null;
            }
          }
          try {
            const mutations = [
              { action: 'create', key: meta.key, previous: {}, current },
            ] as FivesparkMonitorHookMutations<ItemType>;
            await handler(mutations, { collection, event, payload }, context as any);
          } catch (error) {
            logger.error(`Error in monitor hook handler for event ${event}`, error);
          }
          return;
        }
        const keys = (meta.keys ?? [meta.key]) as PrimaryKey[];

        // Fingerprint this event so we can get it from the mutationsInProgress object
        const fingerprint = createFingerprint(event, keys);
        const mutation = mutationsInProgress[fingerprint];
        if (!mutation) {
          // No matching mutation from filter hook?
          logger.warn(`No matching filter hook for action hook with fingerprint ${fingerprint}`);
          return;
        }
        // Remove from state
        delete mutationsInProgress[fingerprint];

        // Check if the fields changed (might happen if other filter hooks changed the data to be saved)
        // Remove current data for fields not being updated after all
        const fields = Object.keys(payload).filter(
          (field) => monitorFields.length === 0 || monitorFields.includes(field),
        );
        const removedFields = mutation.fields.filter((field) => !fields.includes(field));
        for (const removedField of removedFields) {
          mutation.current.forEach((item) => delete item.data[removedField]);
        }
        // Warn about added fields
        const addedFields = fields.filter((field) => !mutation.fields.includes(field));
        for (const addedField of addedFields) {
          logger.warn(
            `Field ${addedField} was added by another filter hook after the mutation was prepared for event ${event}`,
          );
        }

        // Prepare mutations array
        const mutations = [] as FivesparkMonitorHookMutations<ItemType>;
        for (const key of keys) {
          const current = (mutation.current.find((item) => item.key === key) as any).data as ItemType;
          const updates = { ...payload };

          const hasChangesToMonitoredFields = monitorFields.some((field) => current[field] !== updates[field]);
          if (hasChangesToMonitoredFields) {
            // Shake out unchanged values and fields not being monitored
            for (const field of [...Object.keys(current), ...Object.keys(updates)]) {
              if (!monitorFields.includes(field) || current[field] === updates[field]) {
                delete current[field];
                delete updates[field];
              }
            }
            mutations.push({
              action: 'update',
              key,
              previous: current,
              current: updates,
            });
          }
        }

        // Now call the handler with mutations array as payload
        if (mutations.length > 0) {
          try {
            await handler(mutations, { collection, event, payload }, context as any);
          } catch (error) {
            logger.error(`Error in monitor hook handler for event ${event}`, error);
          }
        }
      });
    });
  };
}
