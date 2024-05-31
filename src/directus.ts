/* eslint-disable no-use-before-define */
/* eslint-disable camelcase */
import type { Knex } from 'knex';
export type { Knex } from 'knex';

import type { Item, PrimaryKey } from '@directus/types';
export type { Item, PrimaryKey } from '@directus/types';
export type { MutationOptions } from '@directus/api/dist/types';
export type { Query, DeepQuery, Aggregate, NestedDeepQuery } from '@directus/types/dist/query';
export type {
  Filter,
  ClientFilterOperator,
  FieldFilter,
  FieldFilterOperator,
  FieldValidationOperator,
  FilterOperator,
  LogicalFilter,
  LogicalFilterAND,
  LogicalFilterOR,
} from '@directus/types';
import type { Request, Response, Router as CreateExpressRouter } from 'express';
export { type ItemsService } from '@directus/api/dist/services/items';
import { type Accountability } from '@directus/types';
export { type Accountability } from '@directus/types';
import { type SchemaOverview } from '@directus/types';
import * as DirectusServices from '@directus/api/dist/services';

/**
 * Context available in action/filter hook contexts and endpoint requests
 */
export type DirectusEventContext = {
  /**
   * Current database transaction
   * Available only in action/filter hook contexts
   */
  database?: Knex;
  /**
   * Information about the current user.
   * Available only in action/filter hook and endpoint contexts
   */
  accountability: Accountability;
  /**
   * The current API schema in use
   * Available only in action/filter hook and endpoint contexts
   */
  schema: SchemaOverview;
};

// Request<P = core.ParamsDictionary, ResBody = any, ReqBody = any, ReqQuery = qs.ParsedQs, Locals extends Record<string, any> = Record<string, any>>
export type ApiEndpointRequest<ReqQuery = any, ReqBody = any, ResBody = any> = Request<
  any,
  ResBody,
  ReqBody,
  ReqQuery
> &
  DirectusEventContext;

export type ApiEndpointResponse = Response;

type ApiEndpointHandler = (req: ApiEndpointRequest, res: ApiEndpointResponse, next: () => any) => any;
type ApiRouterEndpoint = (route: string, ...handlers: ApiEndpointHandler[]) => ApiEndpointRouter;
type ExpressRouter = ReturnType<typeof CreateExpressRouter>;
export type ApiEndpointRouter = Omit<ExpressRouter, 'get' | 'post' | 'put' | 'patch' | 'delete'> & {
  get: ApiRouterEndpoint;
  post: ApiRouterEndpoint;
  put: ApiRouterEndpoint;
  patch: ApiRouterEndpoint;
  delete: ApiRouterEndpoint;
};

// export type ApiEndpointRouter = {
//   get: ApiRouterEndpoint;
//   post: ApiRouterEndpoint;
//   // TODO: other methods
// };

/**
 * Added to supply type for "One to Any" relations
 */
export type DirectusOneToAnyItem = {
  collection: string;
  id: number;
  /** PrimaryKey or the actual item, depending on query */
  item: any;
};

import { defineEndpoint as _defineEndpoint, defineHook as _defineHook } from '@directus/extensions';
import type { NonNull, Refactor } from './types/select.js';
import { endpointAuth } from './auth.js';
import { createMonitorHook } from './monitor-hook.js';

// Fix the type for `services` in `defineEndpoint` context callback function
type EndpointConfigFunction = Extract<Parameters<typeof _defineEndpoint>[0], (router: any, context: any) => any>;
type EndpointExtensionContext = Refactor<
  Parameters<EndpointConfigFunction>[1],
  {
    services: typeof DirectusServices;
  }
>;

/**
 * Wrapper function for `defineEndpoint` imported from `@directus/extensions-sdk`,
 * This wrapper provides better types for the `callback` parameter.
 * Disabled because code needs refactoring: adds endpoint authorization middleware
 * @param callback
 * @returns
 */
export function defineEndpoint(callback: (router: ApiEndpointRouter, context: EndpointExtensionContext) => void) {
  return _defineEndpoint((router, directus) => {
    router.use(endpointAuth(directus)); // Allow authenticated requests only
    callback(router as any, directus);
  });
}

export type ApiHookCallerContext = DirectusEventContext;
export type ApiActionHookMetaData<T = any> = {
  /**
   * If this is an insert, primary key value being inserted
   */
  key?: PrimaryKey;

  /**
   * If this is an update, primary key values being updated
   */
  keys?: PrimaryKey[];

  /**
   * Collection that triggered the action hook
   */
  collection: string;

  /**
   * Event the action hook is bound to
   */
  event: string;

  /**
   * Data being inserted or updated
   */
  payload: T;
};

export type ApiFilterHookMetaData = {
  /**
   * If this is an insert, primary key value being inserted
   */
  key?: PrimaryKey;

  /**
   * If this is an update, primary key values being updated
   */
  keys?: PrimaryKey[];

  /**
   * Collection that triggered the filter hook
   */
  collection: string;

  /**
   * Event the filter hook is bound to
   */
  event: string;

  /**
   * Fields being updated/inserted/queried
   */
  fields?: string[];

  /**
   * Data being inserted or updated
   */
  payload: any;
};

// Fix the type for `services` in `defineHook` context callback function
type DirectusHookConfigFunction = Parameters<typeof _defineHook>[0];
export type DirectusRuntimeContext = Omit<Parameters<DirectusHookConfigFunction>[1], 'services'> & {
  services: typeof DirectusServices;
};

// Fix the type for `action` and `filter` hook callback function parameters, add `mutations` hook
export type DirectusHookRegisterFunctions = Parameters<DirectusHookConfigFunction>[0];
export type DirectusActionHookContext = NonNull<
  Parameters<Parameters<DirectusHookRegisterFunctions['action']>[1]>[1],
  'schema' | 'accountability'
>;
export type DirectusFilterHookContext = NonNull<
  Parameters<Parameters<DirectusHookRegisterFunctions['filter']>[1]>[1],
  'schema' | 'accountability'
>;
type HookRegisterFunctions = Omit<DirectusHookRegisterFunctions, 'action' | 'filter'> & {
  action: (event: string, handler: (meta: ApiActionHookMetaData, context: DirectusActionHookContext) => void) => void;
  filter: <T extends Item = Item>(
    event: string,
    handler: (payload: T, meta: ApiFilterHookMetaData, context: DirectusFilterHookContext) => void,
  ) => void;
  /**
   * Custom Fivespark "mutations" hooks - only get notified if data actually changed
   */
  monitor: ReturnType<typeof createMonitorHook>;
};
export type DirectusFilterHookFunction = HookRegisterFunctions['filter'];

/**
 * Wrapper function for `defineHook` imported from `@directus/extensions-sdk`,
 * This wrapper provides better types for the `context` parameter of the `callback` function.
 * @param callback
 * @returns
 */
export function defineHook(
  /**
   * @param register object containing `action` and `filter` functions to register hooks with
   * @param directus object containing Directus' runtime context to get access to the `logger`, `services` and `database` etc
   */
  callback: (register: HookRegisterFunctions, directus: DirectusRuntimeContext) => void,
) {
  return _defineHook((register, directus) => {
    const { filter, action } = register;
    // const context = { logger, services, database };
    callback({ ...(register as any), monitor: createMonitorHook(directus, filter as any, action as any) }, directus);
  });
}

/**
 * Interface that combines Directus runtime context with hook/endpoint event context so we can use just 1 context object to pass around in code.
 * This interface allows both contexts to be passed around the code using a single object:
 * @example
 * ```ts
 * export async function myHandler(context: FivesparkDataHubContext) {
 *   const { logger, services } = context.directus;
 *   const { schema, accountability } = context.event;
 *   const itemService = new services.ItemsService<MyItemType>('my_items', { schema, accountability });
 *   // ...
 * }
 * ```
 * In endpoints:
 * @example
 * ```ts
 * export default defineEndpoint((router, directus) => {
 *   router.get('/my-endpoint', async (req, res) => {
 *    directus.logger.info('Endpoint called');
 *    const context = { directus, event: req };
 *    const result = await myHandler(context);
 *    res.json(result);
 *  }
 * }
 * ```
 * In hooks:
 * @example
 * ```ts
 * export default defineHook(({ action }, directus) => {
 *  action('my_collection.items.create', async (meta, context) => {
 *   directus.logger.info('Item created');
 *   const context = { directus, event: context };
 *   const result = await myHandler(context);
 *  });
 * });
 * ```
 */
export interface FivesparkDataHubContext {
  directus: DirectusRuntimeContext;
  event: DirectusEventContext;
}

export { elevateRights } from './auth.js';
