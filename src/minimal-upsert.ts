import type { DirectusRuntimeContext, FivesparkDataHubContext, MutationOptions, Item, PrimaryKey, FieldFilter } from './directus.js';

/**
 * Performs a minimal update to an existing item by checking which fields will actually change.
 * Creates the item if it doesn't exist, does nothing if there are no effective changes.
 */
export async function minimalUpsert<T extends Item>(
  context: FivesparkDataHubContext,
  service: InstanceType<DirectusRuntimeContext['services']['ItemsService']>,
  data: Partial<T>,
  pkFilter?: FieldFilter,
  options?: MutationOptions,
) {
  const collectionInfo = context.event.schema.collections[service.collection]!;
  const pkField = collectionInfo.primary;
  if (pkFilter && pkField in pkFilter && typeof pkFilter[pkField] === 'undefined') {
    delete pkFilter[pkField];
  }
  if (Object.keys(pkFilter ?? {}).length === 0) {
    pkFilter = undefined;
  }

  // Clone the data to avoid modifying the original
  function cloneDeep(val: any): any {
    // Not using --> return JSON.parse(JSON.stringify(obj)); // <-- because that could change the types of some values (eg Dates)
    if (val instanceof Array) {
      return val.map((item: any) => cloneDeep(item));
    }
    if (typeof val !== 'object' || val === null) {
      return val;
    }
    const result = {} as Record<string, unknown>;
    for (const key of Object.keys(val)) {
      const value = val[key];
      if (typeof value === 'undefined') {
        // Don't copy undefined values
        continue;
      }
      if (typeof value === 'object' && value !== null) {
        result[key] = cloneDeep(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }
  const update = cloneDeep(data);

  // Check if there are any relational fields being updated
  function getUpdateInfo(collection: string, obj: Record<string, unknown>) {
    const result = { fields: [] as string[], filter: {} as FieldFilter, deep: {} as any };
    const collectionInfo = context.event.schema.collections[collection]!;
    const isArray = obj instanceof Array;
    const fields = isArray // array of objects in o2m relations
      ? obj.reduce((fields, item) => {
          Object.keys(item).forEach((key) => fields.includes(key) || fields.push(key));
          return fields;
        }, [] as string[])
      : Object.keys(obj);
    const pkField = collectionInfo.primary;
    for (const field of fields) {
      const items = isArray ? obj : [obj];
      for (const item of items) {
        const value = item[field];
        if (field === pkField && typeof value !== 'undefined') {
          // Add it to the filter
          if (isArray) {
            if (result.filter[field]) {
              (result.filter[field] as any)._in.push(value as PrimaryKey);
            } else {
              result.filter[field] = { _in: [value as PrimaryKey] };
            }
          } else {
            result.filter[field] = { _eq: value as PrimaryKey };
          }
        }
        const fieldInfo = collectionInfo.fields[field]!;
        const isRelational = fieldInfo.special.includes('m2o') || fieldInfo.special.includes('o2m');
        if (isRelational && typeof value === 'object' && value !== null) {
          // Load relational fields
          const targetCollection = fieldInfo.special.includes('m2o')
            ? (context.event.schema.relations.find((rel) => rel.collection === collection && rel.field === field)!
                .related_collection as string)
            : context.event.schema.relations.find(
                (rel) => rel.related_collection === collection && rel.schema?.foreign_key_column === pkField,
              )!.collection;

          const relational = getUpdateInfo(targetCollection, value as Record<string, unknown>);
          if (Object.keys(relational.filter).length > 0) {
            result.deep[field] = { _filter: relational.filter, _limit: -1 };
          }
          if (relational.fields.length > 0) {
            result.fields = Array.from(new Set([...result.fields, ...relational.fields.map((f) => `${field}.${f}`)]));
          }
        } else if (!result.fields.includes(field)) {
          result.fields.push(field);
        }
      }
    }
    return result;
  }

  const info = getUpdateInfo(service.collection, update);

  let currentItem: Item | undefined;
  const filter = { ...pkFilter, ...info.filter };
  if (pkFilter || typeof filter[pkField] !== 'undefined') {
    const fields = [pkField, ...info.fields];
    const existing = await service.readByQuery({ fields, filter, deep: info.deep });
    if (existing.length === 1) {
      currentItem = existing[0]!;
    }
    if (existing.length > 1) {
      throw new Error(`Multiple ${service.collection} items found for filter ${JSON.stringify(filter)}`);
    }
  }
  if (!currentItem) {
    if (data[pkField] === null) {
      delete data[pkField];
    }
    const pkValue = await service.createOne(update, options);
    return { key: pkValue, action: 'create' };
  }

  function getFieldInfo(targetField: string) {
    let { collection } = service;
    const isIndex = (str: string) => /^\d+$/.test(str);
    const parts = targetField.split('.');
    let targetFieldName = parts.pop()!;
    if (isIndex(targetFieldName)) {
      targetFieldName = parts.pop()!;
    }
    for (const part of parts) {
      if (isIndex(part)) {
        continue;
      }
      const collectionInfo = context.event.schema.collections[collection]!;
      const fieldInfo = collectionInfo.fields[part]!;
      const { field: fieldName } = fieldInfo;
      if (fieldInfo.special.includes('m2o')) {
        collection = context.event.schema.relations.find(
          (rel) => rel.collection === collection && rel.field === fieldName,
        )!.related_collection as string;
      } else if (fieldInfo.special.includes('o2m')) {
        collection = context.event.schema.relations.find(
          (rel) => rel.related_collection === collection && rel.schema?.foreign_key_column === collectionInfo.primary,
        )!.collection;
      } else {
        throw new Error(`No relational data found for field ${fieldName} in ${targetField}`);
      }
    }
    const collectionInfo = context.event.schema.collections[collection]!;
    const fieldInfo = collectionInfo.fields[targetFieldName]!;
    return { collectionInfo, fieldInfo };
  }

  function deleteField(field: string) {
    const parts = field.split('.');
    const fieldName = parts.pop()!;
    let value = update;
    for (const part of parts) {
      value = value[part] as Record<string, unknown>;
    }
    if (value instanceof Array) {
      value.splice(Number(fieldName), 1);
    } else {
      delete value[fieldName];
    }
    if (parts.length > 0 && Object.keys(value).length === 0) {
      deleteField(parts.join('.')); // Recursively delete empty objects
    }
  }

  function removeUnchangedValues(current: any, updated: any, targetField?: string) {
    const { collectionInfo, fieldInfo } = targetField
      ? getFieldInfo(targetField)
      : { collectionInfo: service.schema.collections[service.collection]!, fieldInfo: null };

    const pkField = collectionInfo.primary;
    if (current instanceof Array && updated instanceof Array) {
      // o2m relation. Sort by PK field, compare all items in array
      const pkField = collectionInfo.primary;
      current.sort((a, b) => (a[pkField] < b[pkField] ? -1 : 1));
      updated.sort((a, b) => (a[pkField] < b[pkField] ? -1 : 1));
      for (let i = 0; i < current.length; i += 1) {
        const matchingUpdated = updated.find((x) => x[pkField] === current[i][pkField]);
        if (matchingUpdated) {
          removeUnchangedValues(current[i], matchingUpdated, `${targetField}.${i}`);
        }
      }
      if (updated.length === 0) {
        // No o2m items left
        deleteField(targetField!);
      }
    } else if (
      fieldInfo?.type !== 'json' &&
      typeof current === 'object' &&
      current !== null &&
      typeof updated === 'object' &&
      updated !== null
    ) {
      // Recursively remove unchanged values
      for (const key of Object.keys(updated).filter((key) => key in current)) {
        removeUnchangedValues(current[key], updated[key], targetField ? `${targetField}.${key}` : key);
      }
      if (Object.keys(updated).length === 1 && pkField in updated && !fieldInfo?.special.includes('o2m')) {
        delete updated[pkField];
      }
      if (Object.keys(updated).length === 0 && targetField) {
        deleteField(targetField);
      }
    } else if (fieldInfo) {
      const isEqual = ((a: any, b: any) => {
        if (fieldInfo.special.includes('date-updated') || fieldInfo.special.includes('date-created')) {
          return true; // The set value in the update will be ignored and overwritten by Directus
        }
        if (fieldInfo.type === 'json' || fieldInfo.type.startsWith('geometry')) {
          return JSON.stringify(a) === JSON.stringify(b);
        }
        if (fieldInfo.type === 'decimal' || fieldInfo.type === 'float' || fieldInfo.type === 'integer') {
          return Number(a) === Number(b);
        }
        if (fieldInfo.type === 'date' || fieldInfo.type === 'dateTime' || fieldInfo.type === 'timestamp') {
          return new Date(a as any).getTime() === new Date(b as any).getTime();
        }
        if (fieldInfo.type === 'string') {
          return String(a) === String(b);
        }
        if (fieldInfo.type === 'alias') {
          throw new Error('Alias fields are not supported in minimalUpsert');
        }
        return a === b;
      })(current, updated);
      if (isEqual && fieldInfo.field !== pkField) {
        deleteField(targetField!);
      }
    }
  }

  removeUnchangedValues(currentItem, update);

  const pkValue = currentItem[pkField] as PrimaryKey;
  if (Object.keys(update).length === 0) {
    // No changes
    return { key: pkValue, action: 'none' };
  }

  await service.updateOne(pkValue, update, options);
  return { key: pkValue, action: 'update' };
}
