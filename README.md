# Fivespark Directus Utils

This repository contains a number of useful tools when using Directus:

* `monitorHook`: Adds a special hook that can monitor committed changes to specific columns in a collection, providing before/after data.
* `minimalUpsert`: Performs minimal updates to existing records by only committing changing values. Inserts new records.
* `defineEndpoint`: Adds endpoint authorization check middleware to Directus' own `defineEndpoint` function, and provides better callback functon types.
* `elevateRights`: Allow users to access/modify data they do not have access to through the Directus UI and/or API. This allows custom endpoints to change data using the user's accountability for change/revision tracking.
* `defineHook`: Provides better types for callback function arguments than Directus' own `defineHook` function.
* `logSyncError`: Adds database error logging including stack traces and debug info
* `preventAppCrashOnUnhandledRejections`: adds an event handler to `unhandledRejection` events on the `process` so uncaught exceptions are logged to the console instead of crashing the app. Keeping the app running is not recommended so this should only be used for debugging purposes.

# Utility types

It also adds some Typescript utility types:
* `Select<Type, NonNullProperties, NullableProperties>`: Takes the original type, but only keeps selected properties and removes the any `null` type from `NonNullProperties`
* `Refactor<Type, Refactors>`: Takes the original type, but refactors given properties to specific types.

### `Select` utility type

`Select` can be used for custom property selection where you can specify required (non-nullable) properties, and
optional properties (keeps the original type). Very useful to select fields from database collections, removing
the `null` and `undefined` types for required fields.

```ts
// This:
{
  sales_order: Select<SalesOrdersItem, 'id' | 'afas_id', 'date_updated'> & {
    customer: Select<CustomersItem, 'id'>;
  }
};

// Becomes:
{
  sales_order: {
    id: string;
    afas_id: string;
    date_updated: string | null;
    customer: {
      id: string;
    }
  }
}
```

### `Refactor` utility type

Custom utility function to refactor properties to other types
```ts
type User = { name: string; age: string; }
type ActualUser = Refactor<User, { age: number }>
```

### `NonNull` utility type
Custom utility function to remove `null` type from given properties. The same can be achieved using `Select`, see example
```ts
// Remove possible type `null` from properties `id` and `afas_id` of type `SalesOrdersItem`:
type SalesOrdersItem = { id: string | null; afas_id: string | null }
type NewType = NonNull<SalesOrdersItem, 'id'> // -> { id: string; afas_id: string | null }

// Alternative: use `Select` with non-null `id` and all other props as is
type NewType = Select<SalesOrdersItem, 'id', keyof SalesOrdersItem> // -> { id: string; afas_id: string | null }
```
