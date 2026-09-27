/**
 * scripts/schema-inventory/index.ts
 *
 * Public API for the schema inventory/diff utility.
 *
 * The utility is production-safe by construction:
 *   - pure normalized catalog structures (`types.ts`),
 *   - deterministic diff with exactly the five dispositions, fail-closed
 *     `conflict`/`unknown` handling, and manifest-gated `remote-only intended`
 *     / `local-only missing` classifications (`diff.ts`),
 *   - rejection of non-loopback DB URLs, non-catalog/data-bearing keys, raw
 *     SQL fields, and incomplete packets (`validate.ts`),
 *   - loopback-only local capture with read-only catalog queries and PII-safe
 *     hashed records (`capture.ts`),
 *   - redacted output everywhere (`redact.ts`).
 */

export {
  BLOCKING_DISPOSITIONS,
  CATALOG_SECTIONS,
  DISPOSITIONS,
  INVENTORY_FORMAT_VERSION,
  MANIFEST_FORMAT_VERSION,
  type CatalogRecord,
  type CatalogSection,
  type DiffEntry,
  type DiffRegister,
  type DiffSummary,
  type Disposition,
  type DispositionManifest,
  type InventorySource,
  type ReviewedDisposition,
  type ReviewedDispositionValue,
  type SchemaInventory,
} from "./types";

export {
  collapseWhitespace,
  mapActionCode,
  mapConstraintType,
  mapPolicyCommand,
  normalizeAcl,
  normalizeBoolean,
  normalizeRoles,
  normalizeSearchPath,
  normalizeSqlExpression,
  sha256Hex,
  sqlHash,
  toPrimitiveField,
  trimOrEmpty,
  verbatimHash,
} from "./normalize";

export {
  InventoryValidationError,
  SECTION_FIELDS,
  SHA256_HEX_PATTERN,
  FIELD_TYPES,
  assertLoopbackDbUrl,
  assertNoProhibitedKeys,
  isLoopbackDbUrl,
  parseDispositionManifest,
  parseInventoryPacket,
  validateDispositionManifest,
  validateInventoryPacket,
} from "./validate";

export {
  SchemaDiffBlockedError,
  assertNoBlocking,
  diffInventories,
  stableStringify,
} from "./diff";

export { redactString, redactValue, toRedactedJson } from "./redact";

export {
  CATALOG_QUERIES,
  buildInventoryFromQueries,
  captureLocalInventory,
  decodePostgresStringArray,
  decodeTriggerType,
  parsePostgresArrayLiteral,
} from "./capture";