/**
 * scripts/schema-inventory/types.ts
 *
 * Pure, normalized catalog inventory types for the OCF schema-provenance
 * reconciliation (AI-DLC change 2026-09-25-schema-provenance-reconciliation,
 * plan Work 2/4).
 *
 * The inventory is a schema-ONLY packet: it carries catalog metadata that
 * determines behavior (migration ledger, tables, columns, constraints,
 * foreign keys, indexes, sequences, views, functions, triggers, RLS
 * state/policies, grants, schema privileges, default privileges, extensions)
 * and NEVER carries row data, credentials, connection URLs, or raw SQL
 * definitions. SQL-shaped text (constraint/index/trigger/view definitions,
 * column defaults, policy qualifiers, function bodies) is retained ONLY as
 * stable sha256 hashes; every string is redacted at capture time, and the
 * diff utility re-validates and re-redacts on output.
 *
 * This module is dependency-free and side-effect-free.
 */

/** Current packet format version. */
export const INVENTORY_FORMAT_VERSION = 2 as const;

/** Provenance of an inventory packet. */
export type InventorySource = "remote" | "local";

/**
 * The catalog sections a packet MUST carry. Every section is required for a
 * packet to validate (incomplete packets fail closed). These are the ONLY
 * keys accepted under `catalog`; anything else is rejected as non-catalog /
 * data-bearing.
 */
export const CATALOG_SECTIONS = [
  "migrationLedger",
  "tables",
  "columns",
  "constraints",
  "foreignKeys",
  "indexes",
  "sequences",
  "views",
  "functions",
  "triggers",
  "rls",
  "policies",
  "grants",
  "schemaPrivileges",
  "defaultPrivileges",
  "extensions",
] as const;

export type CatalogSection = (typeof CATALOG_SECTIONS)[number];

/** A single normalized catalog record for one section. */
export interface CatalogRecord {
  /**
   * Stable identity within the section, e.g. `public.advisor`,
   * `public.advisor.advisor_id`, `20260318000001`. Identities must be
   * deterministic and independent of database OIDs / row counts / timestamps.
   */
  identity: string;
  /** Redacted catalog/source reference (e.g. `pg_class: public.advisor`). */
  source: string;
  /**
   * Behavior-bearing normalized fields (environment noise removed). String
   * arrays are reserved for documented ordered list fields (FK columns,
   * function search paths / ACLs, policy roles). SQL-shaped content is only
   * ever stored as sha256 hashes (`*Hash` fields) — never raw.
   */
  fields: Record<string, string | number | boolean | string[] | null>;
}

/**
 * A normalized schema inventory packet. `catalog` is keyed by section and
 * every section array MUST be present for the packet to validate.
 */
export interface SchemaInventory {
  formatVersion: typeof INVENTORY_FORMAT_VERSION;
  source: InventorySource;
  /** Redacted capture metadata (environment noise; not compared in diffs). */
  capturedAt: string;
  catalog: Record<CatalogSection, CatalogRecord[]>;
}

/**
 * Exactly the dispositions a diff register may assign. `conflict` and
 * `unknown` BLOCK reconciliation (fail closed). `remote-only intended` and
 * `local-only missing` may only be assigned to objects explicitly covered by
 * a reviewed disposition manifest — never inferred automatically.
 */
export const DISPOSITIONS = [
  "equivalent",
  "remote-only intended",
  "local-only missing",
  "conflict",
  "unknown",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/** Blocking dispositions: any diff containing these must fail closed. */
export const BLOCKING_DISPOSITIONS: readonly Disposition[] = ["conflict", "unknown"];

/**
 * Dispositions a reviewed manifest may authorize for unmatched objects.
 * These are the only non-blocking dispositions for objects that exist on
 * exactly one side.
 */
export type ReviewedDispositionValue = "remote-only intended" | "local-only missing";

/** Current disposition-manifest format version. */
export const MANIFEST_FORMAT_VERSION = 1 as const;

/**
 * One reviewed mapping decision for an object present on only one side.
 * Without an explicit reviewed entry, unmatched objects are classified
 * `unknown` and block reconciliation.
 */
export interface ReviewedDisposition {
  section: CatalogSection;
  /** Stable identity of the object (must match an inventory identity). */
  identity: string;
  disposition: ReviewedDispositionValue;
  /** Reviewed justification / reference for evidence. */
  reason?: string;
}

/**
 * A reviewed disposition manifest: the explicit, human-approved set of
 * remote-only / local-only mappings. The diff engine never auto-labels
 * unmatched objects; it only honors entries present in this manifest.
 */
export interface DispositionManifest {
  formatVersion: typeof MANIFEST_FORMAT_VERSION;
  reviewed: ReviewedDisposition[];
}

/** One classified difference between a remote and a local inventory. */
export interface DiffEntry {
  /** Catalog section the object belongs to, e.g. `tables`. */
  section: CatalogSection;
  /** Stable object identity within the section. */
  identity: string;
  /** Redacted catalog/source reference for evidence. */
  source: string;
  disposition: Disposition;
  /** Human-readable reason, present for conflict/unknown entries. */
  reason?: string;
}

/** Counts per disposition for a diff register. */
export type DiffSummary = Record<Disposition, number>;

/**
 * The deterministic difference register produced by `diffInventories`.
 * `blocked` is true when any entry has a blocking disposition; callers must
 * treat a blocked register as fail-closed (no history repair, no push).
 */
export interface DiffRegister {
  blocked: boolean;
  summary: DiffSummary;
  entries: DiffEntry[];
}