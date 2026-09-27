/**
 * scripts/schema-inventory/diff.ts
 *
 * Deterministic diff engine for normalized schema inventories.
 *
 * Classification contract (exactly these five dispositions):
 *   - `equivalent`           — object present in both inventories with
 *                              identical normalized fields;
 *   - `remote-only intended` — object present only in the remote inventory
 *                              AND explicitly authorized by a reviewed
 *                              disposition manifest (never auto-labeled);
 *   - `local-only missing`   — object present only in the local inventory
 *                              AND explicitly authorized by a reviewed
 *                              disposition manifest (never auto-labeled);
 *   - `conflict`             — object present in both with differing
 *                              normalized fields (unresolved discrepancy);
 *   - `unknown`              — the object cannot be classified deterministically:
 *                              duplicate identities, or an unmatched object with
 *                              no reviewed disposition manifest entry.
 *
 * `conflict` and `unknown` BLOCK history reconciliation: the register is
 * `blocked` and callers must fail closed. An object present on only one side
 * with NO manifest entry is `unknown` (fail closed), NOT auto-classified as
 * intended/missing.
 *
 * The engine is a pure function of its inputs: same inputs → same register.
 * Entries are sorted by (section, identity, disposition).
 */

import {
  BLOCKING_DISPOSITIONS,
  CATALOG_SECTIONS,
  type CatalogRecord,
  type CatalogSection,
  type DiffEntry,
  type DiffRegister,
  type DiffSummary,
  type Disposition,
  type DispositionManifest,
  type ReviewedDispositionValue,
  type SchemaInventory,
} from "./types";

/** Error thrown when a register contains blocking dispositions. */
export class SchemaDiffBlockedError extends Error {
  readonly register: DiffRegister;

  constructor(register: DiffRegister) {
    const blocking = register.entries.filter((e) =>
      BLOCKING_DISPOSITIONS.includes(e.disposition)
    );
    super(
      `Schema diff is BLOCKED: ${blocking.length} blocking difference(s) ` +
        `(conflict/unknown). Production reconciliation must not proceed.`
    );
    this.name = "SchemaDiffBlockedError";
    this.register = register;
  }
}

/** Stable canonical JSON for deterministic field comparison (sorted keys). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** Fields of a record, minus metadata, in canonical form. */
function canonicalFields(record: CatalogRecord): string {
  return stableStringify(record.fields);
}

/** Build identity → record index map for a section, detecting duplicates. */
function indexSection(
  records: CatalogRecord[]
): { byIdentity: Map<string, CatalogRecord>; duplicates: Set<string> } {
  const byIdentity = new Map<string, CatalogRecord>();
  const duplicates = new Set<string>();
  for (const record of records) {
    if (byIdentity.has(record.identity)) duplicates.add(record.identity);
    else byIdentity.set(record.identity, record);
  }
  return { byIdentity, duplicates };
}

function emptySummary(): DiffSummary {
  return {
    equivalent: 0,
    "remote-only intended": 0,
    "local-only missing": 0,
    conflict: 0,
    unknown: 0,
  };
}

/**
 * Index a reviewed disposition manifest by `section\0identity`, returning the
 * authorized disposition for each covered object. Entries for dispositions
 * that can never be authorized are ignored (the manifest validator already
 * rejects them; this is defense in depth).
 */
function indexManifest(
  manifest: DispositionManifest | undefined
): Map<string, ReviewedDispositionValue> {
  const byKey = new Map<string, ReviewedDispositionValue>();
  for (const entry of manifest?.reviewed ?? []) {
    byKey.set(`${entry.section}\u0000${entry.identity}`, entry.disposition);
  }
  return byKey;
}

/**
 * Diff a remote (production-authoritative) inventory against a local
 * inventory. Deterministic; never throws for well-formed inputs.
 *
 * Unmatched objects (present on exactly one side) are classified
 * `remote-only intended` / `local-only missing` ONLY when the reviewed
 * disposition manifest explicitly authorizes that exact mapping. Otherwise
 * they are `unknown` and block reconciliation.
 */
export function diffInventories(
  remote: SchemaInventory,
  local: SchemaInventory,
  manifest?: DispositionManifest
): DiffRegister {
  const entries: DiffEntry[] = [];
  const summary = emptySummary();
  const authorized = indexManifest(manifest);

  for (const section of CATALOG_SECTIONS) {
    const remoteRecords = remote.catalog[section] ?? [];
    const localRecords = local.catalog[section] ?? [];
    const remoteIndex = indexSection(remoteRecords);
    const localIndex = indexSection(localRecords);

    const identities = new Set<string>([
      ...remoteIndex.byIdentity.keys(),
      ...localIndex.byIdentity.keys(),
      ...remoteIndex.duplicates,
      ...localIndex.duplicates,
    ]);
    const sortedIdentities = [...identities].sort();

    for (const identity of sortedIdentities) {
      const remoteRecord = remoteIndex.byIdentity.get(identity);
      const localRecord = localIndex.byIdentity.get(identity);
      const ambiguous =
        remoteIndex.duplicates.has(identity) || localIndex.duplicates.has(identity);
      const manifestKey = `${section}\u0000${identity}`;
      const authorizedDisposition = authorized.get(manifestKey);

      let disposition: Disposition;
      let reason: string | undefined;
      let source = "";

      if (ambiguous) {
        disposition = "unknown";
        reason = `Duplicate identity "${identity}" within one inventory makes the mapping ambiguous.`;
        source = remoteRecord?.source ?? localRecord?.source ?? section;
      } else if (remoteRecord && localRecord) {
        source = remoteRecord.source;
        if (canonicalFields(remoteRecord) === canonicalFields(localRecord)) {
          disposition = "equivalent";
        } else {
          disposition = "conflict";
          reason = `Normalized fields differ between remote and local for "${identity}".`;
        }
      } else if (remoteRecord) {
        if (authorizedDisposition === "remote-only intended") {
          disposition = "remote-only intended";
        } else {
          disposition = "unknown";
          reason = `Remote-only object "${identity}" (${section}) is not covered by a reviewed disposition manifest; it cannot be auto-classified as intended.`;
        }
        source = remoteRecord.source;
      } else if (localRecord) {
        if (authorizedDisposition === "local-only missing") {
          disposition = "local-only missing";
        } else {
          disposition = "unknown";
          reason = `Local-only object "${identity}" (${section}) is not covered by a reviewed disposition manifest; it cannot be auto-classified as missing.`;
        }
        source = localRecord.source;
      } else {
        // Unreachable: identity came from one of the indexes.
        continue;
      }

      summary[disposition] += 1;
      entries.push({
        section: section as CatalogSection,
        identity,
        source,
        disposition,
        reason,
      });
    }
  }

  entries.sort((a, b) => {
    const bySection = a.section.localeCompare(b.section);
    if (bySection !== 0) return bySection;
    const byIdentity = a.identity.localeCompare(b.identity);
    if (byIdentity !== 0) return byIdentity;
    return a.disposition.localeCompare(b.disposition);
  });

  const blocked = entries.some((e) => BLOCKING_DISPOSITIONS.includes(e.disposition));
  return { blocked, summary, entries };
}

/**
 * Fail closed: throw `SchemaDiffBlockedError` when any entry is `conflict` or
 * `unknown`. Returns the register unchanged when it is safe.
 */
export function assertNoBlocking(register: DiffRegister): DiffRegister {
  if (register.blocked) throw new SchemaDiffBlockedError(register);
  return register;
}