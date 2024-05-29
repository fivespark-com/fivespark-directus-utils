import { DataHubTypes } from './datahub-types.js';
import { Refactor } from './select.js';

export type SyncErrorsItem = Required<DataHubTypes['sync_errors']>;
export type ConfigEndpointsItem = Refactor<
  Required<DataHubTypes['config_endpoints']>,
  { status: 'enabled' | 'disabled' }
>;
