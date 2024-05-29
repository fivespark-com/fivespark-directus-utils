/**
 * Select can be used for custom property selection where you can specify required (non-nullable) properties, and
 * optional properties (keeps the original type). Very useful to select fields from database collections, removing
 * the `null` and `undefined` types for required fields.
 * @example
 * // This:
 * {
 *   sales_order: Select<SalesOrdersItem, 'id' | 'afas_id', 'date_updated'> & {
 *     customer: Select<CustomersItem, 'id'>;
 *   }
 * };
 *
 * // Becomes:
 * {
 *   sales_order: {
 *     id: string;
 *     afas_id: string;
 *     date_updated: string | null;
 *     customer: {
 *       id: string;
 *     }
 *   }
 * }
 */
export type Select<Type, Required extends keyof Type, Nullable extends keyof Type = void> = {
  [Key in Required]: NonNullable<Type[Key]>;
} & {
  [Key in Nullable]: Type[Key];
};

/**
 * Custom utility function to remove `null` type from given properties. The same can be achieved using `Select`, see example
 * @example
 * // Remove possible type `null` from properties `id` and `afas_id` of type `SalesOrdersItem`:
 * type SalesOrdersItem = { id: string | null; afas_id: string | null }
 * NonNull<SalesOrdersItem, 'id'> // -> { id: string; afas_id: string | null }
 *
 * // Alternative: use `Select` with non-null `id` and all other props as is
 * Select<SalesOrdersItem, 'id', keyof SalesOrdersItem> // -> { id: string; afas_id: string | null }
 */
export type NonNull<Type, Keys extends keyof Type = keyof Type> = Omit<Type, Keys> & {
  [Key in Keys]: NonNullable<Type[Key]>;
};

/**
 * Custom utility function to refactor properties to other types
 * @example
 * type User = { name: string; age: string; }
 * Refactor<User, { age: number }> // -> { name: string; age: number }
 */
export type Refactor<Type, Override extends Partial<Record<keyof Type, NewType>>> = Omit<Type, keyof Override> & {
  [Key in keyof Override]: Override[Key];
};
