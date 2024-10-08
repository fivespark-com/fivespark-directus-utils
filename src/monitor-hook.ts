import type { NonNull } from './types/select.js';
import type {
  DirectusFilterHookFunction,
  DirectusHookRegisterFunctions,
  DirectusRuntimeContext,
  Item,
  PrimaryKey,
} from './directus.js';
import { createHash } from 'crypto';

export type FivesparkMonitorHookMutations<ItemType, IsPartial extends boolean> = Array<{
  action: 'create' | 'update' | 'delete';
  /** Primary key of the item */
  key: PrimaryKey;
  /** Old data for monitored fields */
  previous: IsPartial extends true ? Partial<ItemType> : ItemType;
  /** New data for monitored fields */
  current: IsPartial extends true ? Partial<ItemType> : ItemType;
  /**
   * Utility function to easily check for particular changes.
   * @example
   * mutation.hasChanged('status'); // true if status changed
   * mutation.hasChanged('status', 'draft'); // true if status changed from 'draft' to something else
   * mutation.hasChanged('status', 'draft', 'published') // true if status changed from 'draft' to 'published'
   */
  hasChanged(field: keyof ItemType, from?: any, to?: any): boolean;
}>;

let lastHookId = 0;
export function createMonitorHook(
  directus: DirectusRuntimeContext,
  filter: DirectusFilterHookFunction,
  action: DirectusHookRegisterFunctions['action'],
) {
  return function monitor<ItemType extends Item = Item, K extends keyof ItemType = keyof ItemType>(
    /**
     * Collection to monitor for changes
     */
    monitorCollection: string,
    /**
     * Fields to monitor. Pass empty array to monitor all fields.
     */
    monitorFieldsOrOptions:
      | K[]
      | {
          /**
           * Fields to monitor. Pass empty array to monitor all fields.
           */
          fields: K[];
          /**
           * Whether to include values for monitored fields that did not change during mutations to other monitored fields.
           * By default only fields that actually changed are included in the `current` and `previous` data.
           * @default false
           */
          includeUnchanged?: boolean;
          /**
           * Which events to handle. Defaults to all events.
           * @default ['create', 'update', 'delete']
           */
          events?: Array<'create' | 'update' | 'delete'>;
          /**
           * Whether to use the accountability of the user that performed the update.
           * Set to false if the user has no permissions to access the fields.
           * @default true
           */
          useAccountability?: boolean;
        },
    handler: // <
    // ---------------------------------------------------------------------------------------------------------------
    // <IsPartial extends boolean = typeof monitorFieldsOrOptions extends { includeUnchanged: true } ? false : true>
    // ---------------------------------------------------------------------------------------------------------------
    // This doesn't look like it's currently implemented correctly in TypeScript:
    // `IsPartial` always becomes `true` regardless of the value of `monitorFieldsOrOptions.includeUnchanged`
    // As workaround, let caller decide whether to pass `Type` or `Partial<Type>` to the `monitor<Type>` generic.
    // TODO: Create multiple `monitor` function signatures to handle this. Might need to refactor it for that
    // IsPartial extends boolean = false,
    //>
    (
      mutations: FivesparkMonitorHookMutations<ItemType, false>,
      meta: { collection: string; event: string; payload: Partial<ItemType> },
      context: NonNull<
        Parameters<Parameters<DirectusHookRegisterFunctions['action']>[1]>[1],
        'schema' | 'accountability'
      >,
    ) => void | Promise<void>,
  ) {
    const monitorOptions = {
      fields: monitorFieldsOrOptions instanceof Array ? monitorFieldsOrOptions : monitorFieldsOrOptions.fields,
      includeUnchanged: monitorFieldsOrOptions instanceof Array ? false : monitorFieldsOrOptions.includeUnchanged,
      events:
        monitorFieldsOrOptions instanceof Array || !monitorFieldsOrOptions.events
          ? ['create', 'update', 'delete']
          : monitorFieldsOrOptions.events,
      useAccountability: monitorFieldsOrOptions instanceof Array ? true : monitorFieldsOrOptions.useAccountability,
    };
    const logger = directus.logger.child({}, { msgPrefix: '[monitor hook]' });
    const mutationsInProgress: Record<
      string,
      {
        timestamp: number;
        event: string;
        keys: PrimaryKey[];
        fields: string[];
        current: Array<{ key?: PrimaryKey; data: ItemType }>;
      }
    > = {};

    const events = [
      ...(monitorOptions.events.includes('create') ? [`${monitorCollection}.items.create`] : []),
      ...(monitorOptions.events.includes('update') ? [`${monitorCollection}.items.update`] : []),
      ...(monitorOptions.events.includes('delete') ? [`${monitorCollection}.items.delete`] : []),
    ];
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
        if (!meta.event.endsWith('.items.update') && !meta.event.endsWith('.items.delete')) {
          // Not an update event, error
          throw new Error(`Unexpected event ${meta.event}`);
        }
        const eventName = meta.event.split('.').pop() as 'create' | 'update' | 'delete';
        const { collection } = meta;
        const { schema, accountability } = context;
        const fields =
          monitorOptions.includeUnchanged || eventName === 'delete'
            ? monitorOptions.fields
            : (Object.keys(payload) as K[]).filter(
                (field) => monitorOptions.fields.length === 0 || monitorOptions.fields.includes(field),
              );
        const keys =
          eventName === 'delete' ? (payload as unknown as PrimaryKey[]) : ((meta.keys ?? [meta.key]) as PrimaryKey[]);

        // Fingerprint this event so we can add it to the mutationsInProgress object
        const fingerprint = createFingerprint(event, keys);

        // Fetch current data of changed items
        const itemsService = new directus.services.ItemsService<ItemType>(collection, { schema, accountability : monitorOptions.useAccountability ? accountability : null });
        const primaryKeyField = schema.collections[collection].primary;
        const currentItems = await itemsService.readMany(keys, {
          fields: [primaryKeyField, ...fields],
          limit: keys.length,
        });

        mutationsInProgress[fingerprint] = {
          timestamp: Date.now(),
          event,
          keys,
          fields: fields as string[],
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
        const eventName = meta.event.split('.').pop() as 'create' | 'update' | 'delete';
        if (eventName === 'create') {
          // Shortcut for create events, we don't need to compare with previous data
          const current = { ...payload };
          // Remove fields not being monitored
          for (const key of Object.keys(current) as K[]) {
            if (!monitorOptions.fields.includes(key)) {
              delete current[key];
            }
          }
          // Set monitored fields not being set to null
          for (const field of monitorOptions.fields) {
            if (typeof current[field] === 'undefined') {
              current[field] = null;
            }
          }
          try {
            const mutations = [{ action: 'create', key: meta.key, previous: {}, current }] as Parameters<
              typeof handler
            >[0]; //as FivesparkMonitorHookMutations<ItemType, false>;
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

        if (event.endsWith('.items.delete')) {
          // Shortcut for delete events, we don't need to compare with previous data
          try {
            const mutations = mutation.current.map((m) => ({
              action: 'delete',
              key: m.key,
              previous: m.data,
              current: {},
              hasChanged(field, from, to) {
                return false;
              },
            })) as Parameters<typeof handler>[0]; // as FivesparkMonitorHookMutations<ItemType, false>;
            await handler(mutations, { collection, event, payload }, context as any);
          } catch (error) {
            logger.error(`Error in monitor hook handler for event ${event}`, error);
          }
        }

        // Check if the fields changed (might happen if other filter hooks changed the data to be saved)
        // Remove current data for fields not being updated after all
        const fields = monitorOptions.includeUnchanged
          ? monitorOptions.fields
          : (Object.keys(payload) as K[]).filter(
              (field) => monitorOptions.fields.length === 0 || monitorOptions.fields.includes(field),
            );
        const removedFields = mutation.fields.filter((field) => !fields.includes(field as K));
        for (const removedField of removedFields) {
          mutation.current.forEach((item) => delete item.data[removedField as K]);
        }
        // Warn about added fields
        const addedFields = fields.filter((field) => !mutation.fields.includes(field as string));
        for (const addedField of addedFields) {
          logger.warn(
            `Field ${addedField as string} was added by another filter hook after the mutation was prepared for event ${event}`,
          );
        }

        // Prepare mutations array
        const mutations = [] as Parameters<typeof handler>[0];
        for (const key of keys) {
          const previous = (mutation.current.find((item) => `${item.key}` === `${key}`) as any).data as ItemType;
          const current = {
            ...(monitorOptions.includeUnchanged ? previous : {}),
            ...payload,
          };

          const hasChangesToMonitoredFields = monitorOptions.fields.some((field) => previous[field] !== current[field]);
          if (hasChangesToMonitoredFields) {
            // Shake out fields not being monitored and fields that didn't change (unless includeUnchanged is set to true)
            for (const field of [...Object.keys(previous), ...Object.keys(current)]) {
              if (
                !monitorOptions.fields.includes(field as K) ||
                (!monitorOptions.includeUnchanged && previous[field] === current[field])
              ) {
                delete previous[field];
                delete current[field];
              }
            }
            mutations.push({
              action: 'update',
              key,
              previous,
              current,
              hasChanged(field, from, to) {
                return (
                  this.previous[field] !== this.current[field] &&
                  (typeof from === 'undefined' || this.previous[field] === from) &&
                  (typeof to === 'undefined' || this.current[field] === to)
                );
              },
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
