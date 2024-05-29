import { createError } from '@directus/errors';
import type { NextFunction, Request, Response } from 'express';
import { ApiEndpointRequest, DirectusRuntimeContext, Accountability } from './directus.js';
import { ConfigEndpointsItem } from './types/items.js';
import { Refactor, Select } from './types/select.js';

/**
 * Returns a middleware function that checks authorisation on a custom endpoint.
 *
 * basically it checks:
 * 1. if there is accountability (an authenticated request)
 * 2. if the user that is authenticated has direct access
 * 3. if the role of the user that is authenticated has direct access
 * Otherwise it'll throw a ForbiddenException
 *
 * Setup instructions:
 * Add a collection named `config_endpoints` with the following fields:
 * - endpoint: string
 * - status: string (enum: enabled, disabled)
 * - roles: many-to-many relation to directus_roles
 * - users: many-to-many relation to directus_users
 * You can also merge the "collections", "fields" and "relations" entries from auth.schema.json into your own schema.json file
 *
 * @param context the directus context
 * @returns a middleware function
 * @throws a ForbiddenException if route is not found or if user is not authorised to access endpoint
 */
export function endpointAuth(context: DirectusRuntimeContext) {
  return async function middlewareFunction(req: ApiEndpointRequest, res: Response, next: NextFunction) {
    const endpointUrl = req.originalUrl.split('?').shift() as string;
    const { logger } = context;
    logger.debug(`endpointAuth: Checking authR on endpoint ${endpointUrl}`);
    const { schema } = req;
    type ConfigEndpointsQueryItem = Refactor<
      Select<ConfigEndpointsItem, 'status' | 'allow_public_access' | 'roles' | 'users'>,
      {
        roles: Array<{ directus_roles_id: string }>;
        users: Array<{ directus_users_id: string }>;
      }
    >;
    const endpointConfigService = new context.services.ItemsService<ConfigEndpointsQueryItem>('config_endpoints', {
      schema,
    });

    try {
      const [currentEndpointConfig] = await endpointConfigService.readByQuery({
        fields: ['status', 'allow_public_access', 'roles.directus_roles_id', 'users.directus_users_id'],
        filter: {
          endpoint: {
            _eq: endpointUrl,
          },
        },
      });
      if (!currentEndpointConfig) {
        throw new Error('Unconfigured endpoint');
      }
      if (currentEndpointConfig.status !== 'enabled') {
        throw new Error('DISABLED endpoint');
      }
      if (currentEndpointConfig.allow_public_access) {
        logger.debug(`endpointAuth: Endpoint ${endpointUrl} allows public access`);
        next(); // All good
        return;
      }
      // The roles that are setup to access this route
      const authorizedRoles = currentEndpointConfig.roles.map((aRole) => aRole.directus_roles_id);
      // The users that are setup to access this route
      const authorizedUsers = currentEndpointConfig.users.map((aUser) => aUser.directus_users_id);
      /**
       * This is a sloppy if statement, but basically it checks:
       * 1. if there is accountability (an authenticated request)
       * 2. if the user that is authenticated has direct access
       * 3. if the role of the user that is authenticated has direct access
       * Otherwise it'll throw a ForbiddenException
       */
      if (
        !authorizedRoles.includes(req.accountability?.role as string) &&
        !authorizedUsers.includes(req.accountability?.user as string)
      ) {
        throw new Error(`User not authorized: ${JSON.stringify(req.accountability)}`);
      }

      next(); // All good
    } catch (error: any) {
      logger.error(`endpointAuth: Endpoint authR failed for ${req.originalUrl}: ${error?.message ?? error}`);

      // throw Forbidden exception instead of RouteNotFoundException
      // so that we don't give boefjes a clue as to which routes exist
      const ForbiddenError = createError('ENDPOINT_AUTH_FORBIDDEN', '');
      next(new ForbiddenError());
    }
  } as (req: Request, res: Response, next: NextFunction) => any;
}

/**
 * Temporarily elevates a user's rights by setting the admin flag to true. Does not affect the original accountability object.
 * This enables an API endpoint to use elevated rights for specific operations, so that change tracking reflects the user that caused the change.
 * @param accountability A user's accountability object
 * @returns An accountability object with the admin flag set to true
 */
export function elevateRights(accountability: Accountability): Accountability {
  return {
    ...accountability,
    admin: true,
  };
}
