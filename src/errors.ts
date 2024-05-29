import pino from 'pino';
import type { SyncErrorsItem } from './types/items.js';
import type { DirectusRuntimeContext } from './directus.js';

export function preventAppCrashOnUnhandledRejections() {
  process.on('unhandledRejection', (err: any) => {
    const logger = pino();
    logger.error('CRITICAL: Prevented Node.js process exit because of an unhandled promise rejection');
    logger.error(err?.stack ?? err?.message ?? err);
  });
}

export interface SyncErrorDetails {
  /**
   * Source service
   */
  sourceService: string;

  /**
   * Source service collection / table / endpoint
   */
  sourceCollection: string | string[];

  /**
   * Id of the item from source being synced
   */
  sourceId: string | number;

  /**
   * Target service
   */
  targetService: string;

  /**
   * Target service collection / table / endpoint
   */
  targetCollection: string | string[];

  /**
   * If an item is being edited (not created), its id
   */
  targetId?: string | number | null;

  /**
   * Error thrown (provides stack trace), or error message only
   */
  error: Error | string;

  /**
   * Additional data (JSON) that helps debugging this error
   */
  debugData?: Record<string, any>;

  /**
   * Message to add (prepend) to the original error message
   */
  customMessage?: string;
}

const MAX_MESSAGE_LENGTH = 255;

/**
 * Logs a synchronization error to the console and to the database.
 * In order for this to work, you have to create a collection called `sync_errors` in your Directus project with the following fields:
 * - source: string
 * - source_id: string
 * - target: string
 * - target_id: string
 * - message: string
 * - stack_trace: string
 * - debug_data: json
 * You can also merge the "collections" and "fields" entries from errors.schema.json into your own schema.json file
 * @param directus
 * @param details
 */
export async function logSyncError(directus: DirectusRuntimeContext, details: SyncErrorDetails) {
  // Log to console first
  const message =
    (details.customMessage ? `${details.customMessage} | ` : '') +
    (details.error instanceof Error ? details.error.message : details.error);
  directus.logger.error(
    `SYNC ERROR: ${details.sourceService}.${details.sourceCollection} (id ${details.sourceId}) -> ${
      details.targetService
    }.${details.targetCollection} (id ${details.targetId ?? 'null'}): ${message}`,
  );

  // Now log to database
  const schema = await directus.getSchema();
  const errorsItemService = new directus.services.ItemsService<SyncErrorsItem>('sync_errors', { schema });

  try {
    await errorsItemService.createOne({
      source: `${details.sourceService}.${details.sourceCollection}`,
      source_id: details.sourceId.toString(),
      target: `${details.targetService}.${details.targetCollection}`,
      target_id: details.targetId?.toString() ?? null,
      message: message.slice(0, MAX_MESSAGE_LENGTH),
      stack_trace: details.error instanceof Error ? details.error.stack : null,
      debug_data: details.debugData ? JSON.stringify(details.debugData) : null,
    });
  } catch (err: any) {
    // If logging an error fails, what should we do? Send an email?
    directus.logger.fatal(err);
  }
}
