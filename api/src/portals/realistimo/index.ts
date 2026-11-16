/*
 * Realistimo portal: XML feed adapter and renderer, geo resolver, and the optional REST sync
 * (import trigger and import log). See the files for the details of each part.
 */

export {
  createRealistimoAdapter,
  REALISTIMO_DISPLAY_NAME,
  REALISTIMO_KEY,
  validateForRealistimo,
  type RealistimoAdapterOptions,
} from './adapter.js';
export {
  createRealistimoClient,
  DEFAULT_REALISTIMO_API_TIMEOUT_MS,
  interpretLatestLog,
  interpretStartResponse,
  type ImportLogCounts,
  type ImportLogOffer,
  type ImportLogState,
  type ImportResultKind,
  type LatestLogResult,
  type RealistimoClient,
  type RealistimoClientOptions,
  type StartImportResult,
  type StartOutcome,
} from './api-client.js';
export {
  createRealistimoFeedRenderer,
  FEED_UPDATED_MAX_AGE_MS,
  REALISTIMO_FEED_CONTENT_TYPE,
  realistimoFeedLastModified,
  realistimoFeedUpdated,
  type RealistimoFeedRendererOptions,
} from './feed.js';
export {
  createGeoResolver,
  DEFAULT_GEO_CSV_PATH,
  GeoDataError,
  geoSubsetInfo,
  loadGeoSubset,
  parseGeoCsv,
  REALISTIMO_GEO_CSV_URL,
  type GeoLevel,
  type GeoResolution,
  type GeoResolver,
  type GeoResolverOptions,
  type GeoRow,
} from './geo.js';
export {
  buildRealistimoOffer,
  REALISTIMO_BROKER_ID_PREFIX,
  realistimoBrokerId,
  realistimoSubcategory,
  type RealistimoBroker,
  realistimoLastUpdate,
  type RealistimoOfferPayload,
} from './offer.js';
export {
  CONFIGURATION_ERROR_BACKOFF_MS,
  CONFIGURATION_START_OUTCOMES,
  decideImportTrigger,
  EMPTY_SYNC_STATE,
  isConfigurationOutcome,
  offerErrorsFromLog,
  offersOkFromLog,
  parseSyncSummary,
  REALISTIMO_IMPORT_ERROR_PREFIX,
  runRealistimoSyncCycle,
  type OfferImportError,
  type RealistimoSyncCycleInput,
  type RealistimoSyncCycleResult,
  type RealistimoSyncState,
  type RealistimoSyncSummary,
  type TriggerDecision,
  type TriggerDecisionInput,
} from './sync.js';
export {
  formatSofiaDateTime,
  IMPORT_COOLDOWN_MS,
  importCooldownEndsAt,
  isImportCoolingDown,
  isWithinImportWindow,
  sofiaStartOfDay,
} from './time.js';
