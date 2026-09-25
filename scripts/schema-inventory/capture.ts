/**
 * scripts/schema-inventory/capture.ts
 *
 * Loopback-only local capture runner.
 *
 * Reads schema-ONLY catalog metadata from a disposable local database using
 * read-only queries against `pg_catalog` / `information_schema` / the Supabase
 * migration ledger, then normalizes it into a redacted `SchemaInventory`
 * packet. It NEVER connects to a hosted/shared database: the DB URL is
 * asserted loopback-only before any connection is attempted, and every query
 * is a read-only SELECT against catalog tables (no table-row queries, no
 * credentials, no data).
 *
 * PII-safe by construction: raw SQL expressions (defaults, constraint/index/
 * trigger/view definitions, policy qualifiers, function bodies) are NEVER
 * stored — only sha256 hashes of their literal-safe normalized form. FK
 * columns and search_path preserve catalog order. ACLs are effective (default
 * PUBLIC grants are not hidden). Trigger state preserves the raw catalog code.
 *
 * The runner is the ONLY component that touches a live database; the diff
 * utility itself consumes pre-redacted packet files only.
 */

import { Client } from "pg";
import { assertLoopbackDbUrl } from "./validate";
import { INVENTORY_FORMAT_VERSION, type CatalogRecord, type CatalogSection, type SchemaInventory } from "./types";
import {
  mapActionCode,
  mapConstraintType,
  mapPolicyCommand,
  normalizeAcl,
  normalizeBoolean,
  normalizeRoles,
  normalizeSearchPath,
  sqlHash,
  toPrimitiveField,
  trimOrEmpty,
  verbatimHash,
} from "./normalize";

/** Columns of a single catalog query row (documented by the SELECT). */
type CatalogRow = Record<string, unknown>;

/**
 * Decode a catalog array value that node-postgres may return EITHER as a JS
 * array (for registered array types such as `text[]`) OR as the raw Postgres
 * array-literal string (for unregistered array types such as `name[]`, which
 * is exactly what `array_agg(a.attname ...)` yields). Returns a stable string
 * array in CATALOG ORDER; never throws and never fabricates values.
 */
export function decodePostgresStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === null || item === undefined ? "" : String(item)
    );
  }
  if (typeof value === "string") {
    return parsePostgresArrayLiteral(value);
  }
  return [];
}

/**
 * Parse a Postgres array-literal string into a string array in catalog order.
 * Handles quoted elements (`{"a b","c,d"}`), escaped quotes/backslashes inside
 * quoted elements (`{"a\"b"}`), empty arrays (`{}`), and unquoted `NULL`
 * elements (mapped to `""` so array position is preserved). Anything that is
 * not an array literal yields an empty array.
 */
export function parsePostgresArrayLiteral(input: string): string[] {
  const text = input.trim();
  if (text === "" || text === "{}") return [];
  if (!text.startsWith("{") || !text.endsWith("}")) return [];

  const inner = text.slice(1, -1);
  const elements: string[] = [];
  let current = "";
  let inQuotes = false;
  let wasQuoted = false;
  let escaped = false;
  let hasContent = false;

  for (const ch of inner) {
    hasContent = true;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inQuotes = !inQuotes;
      wasQuoted = true;
      continue;
    }
    if (ch === "," && !inQuotes) {
      elements.push(finalizeArrayElement(current, wasQuoted));
      current = "";
      wasQuoted = false;
      continue;
    }
    current += ch;
  }
  if (hasContent || current !== "" || inQuotes || wasQuoted) {
    elements.push(finalizeArrayElement(current, wasQuoted));
  }
  return elements;
}

/** Map an unquoted Postgres `NULL` array element to `""` (position-preserving). */
function finalizeArrayElement(raw: string, wasQuoted: boolean): string {
  if (!wasQuoted && raw.trim().toUpperCase() === "NULL") return "";
  return raw;
}

/** Read-only catalog queries, keyed by catalog section. */
export const CATALOG_QUERIES: ReadonlyArray<{ section: CatalogSection; sql: string }> = [
  {
    section: "migrationLedger",
    sql: `SELECT version::text AS version, name AS name
          FROM supabase_migrations.schema_migrations
          ORDER BY version::text`,
  },
  {
    section: "tables",
    sql: `SELECT n.nspname AS schema, c.relname AS name,
                 CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned' ELSE c.relkind::text END AS kind,
                 c.relpersistence AS persistence
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
          ORDER BY n.nspname, c.relname`,
  },
  {
    section: "columns",
    sql: `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
                 a.attnum AS ordinal,
                 pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
                 NOT a.attnotnull AS nullable,
                 pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
                 a.attgenerated AS generated
          FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
            AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY n.nspname, c.relname, a.attnum`,
  },
  {
    section: "constraints",
    sql: `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
                 con.contype AS type,
                 pg_catalog.pg_get_constraintdef(con.oid) AS definition
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
            AND con.contype IN ('p','u','c','x')
          ORDER BY n.nspname, c.relname, con.conname`,
  },
  {
    section: "foreignKeys",
    sql: `SELECT n.nspname AS schema, c.relname AS table, con.conname AS name,
                 con.confdeltype AS on_delete,
                 con.confupdtype AS on_update,
                 con.condeferrable AS deferrable,
                 con.condeferred AS initially_deferred,
                 (SELECT pg_catalog.array_agg(a.attname ORDER BY k.ord)
                  FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns,
                 fn.nspname AS referenced_schema,
                 fc.relname AS referenced_table,
                 (SELECT pg_catalog.array_agg(a.attname ORDER BY k.ord)
                  FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS referenced_columns
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
          JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND con.contype = 'f'
          ORDER BY n.nspname, c.relname, con.conname`,
  },
  {
    section: "indexes",
    sql: `SELECT n.nspname AS schema, c.relname AS table, ic.relname AS name,
                 ix.indisunique AS unique,
                 pg_catalog.pg_get_indexdef(ix.indexrelid) AS definition
          FROM pg_catalog.pg_index ix
          JOIN pg_catalog.pg_class c ON c.oid = ix.indrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_class ic ON ic.oid = ix.indexrelid
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
            AND NOT ix.indisprimary
          ORDER BY n.nspname, c.relname, ic.relname`,
  },
  {
    section: "sequences",
    sql: `SELECT n.nspname AS schema, c.relname AS name,
                 s.seqtypid::regtype::text AS data_type,
                 (SELECT tn.nspname || '.' || tc.relname || '.' || a.attname
                  FROM pg_catalog.pg_depend d
                  JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
                  JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
                  JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                  WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
                    AND d.refobjsubid > 0 AND d.deptype IN ('a','i')) AS owned_by
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid
          WHERE n.nspname = 'public' AND c.relkind = 'S'
          ORDER BY n.nspname, c.relname`,
  },
  {
    section: "views",
    sql: `SELECT n.nspname AS schema, c.relname AS name,
                 CASE c.relkind WHEN 'm' THEN 'materialized' ELSE 'view' END AS kind,
                 pg_catalog.pg_get_viewdef(c.oid) AS definition
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
          ORDER BY n.nspname, c.relname`,
  },
  {
    section: "functions",
    sql: `SELECT n.nspname AS schema, p.proname AS name,
                 pg_catalog.pg_get_function_identity_arguments(p.oid) AS signature,
                 pg_catalog.pg_get_function_result(p.oid) AS return_type,
                 l.lanname AS language,
                 p.provolatile AS volatility,
                 CASE p.prosecdef WHEN true THEN 'DEFINER' ELSE 'INVOKER' END AS security_mode,
                 p.proconfig AS config,
                 COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))::text[] AS acl,
                 p.prosrc AS body
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          JOIN pg_catalog.pg_language l ON l.oid = p.prolang
          WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
          ORDER BY n.nspname, p.proname, p.oid`,
  },
  {
    section: "triggers",
    sql: `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name,
                 f.proname AS function,
                 t.tgenabled AS state,
                 t.tgtype AS tgtype,
                 pg_catalog.pg_get_triggerdef(t.oid) AS definition
          FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_proc f ON f.oid = t.tgfoid
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
            AND NOT t.tgisinternal
          ORDER BY n.nspname, c.relname, t.tgname`,
  },
  {
    section: "rls",
    sql: `SELECT n.nspname AS schema, c.relname AS table,
                 c.relrowsecurity AS enabled,
                 c.relforcerowsecurity AS forced
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
          ORDER BY n.nspname, c.relname`,
  },
  {
    section: "policies",
    sql: `SELECT n.nspname AS schema, c.relname AS table, p.polname AS name,
                 p.polcmd AS command,
                 p.polpermissive AS permissive,
                 (SELECT pg_catalog.array_agg(r.rolname ORDER BY r.rolname)
                  FROM unnest(p.polroles) AS prole(oid)
                  JOIN pg_catalog.pg_roles r ON r.oid = prole.oid) AS roles,
                 pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expr,
                 pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS with_check_expr
          FROM pg_catalog.pg_policy p
          JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
          ORDER BY n.nspname, c.relname, p.polname`,
  },
  {
    section: "grants",
    sql: `SELECT n.nspname AS schema, 'TABLE' AS object_type, c.relname AS object_name,
                 CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
                 g.privilege_type AS privilege,
                 g.is_grantable AS grantable
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS g
          LEFT JOIN pg_catalog.pg_roles r ON r.oid = g.grantee
          WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
          UNION ALL
          SELECT n.nspname, 'SEQUENCE', c.relname,
                 CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END,
                 g.privilege_type, g.is_grantable
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS g
          LEFT JOIN pg_catalog.pg_roles r ON r.oid = g.grantee
          WHERE n.nspname = 'public' AND c.relkind = 'S'
          UNION ALL
          SELECT n.nspname, 'FUNCTION', p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
                 CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END,
                 g.privilege_type, g.is_grantable
          FROM pg_catalog.pg_proc p
          JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS g
          LEFT JOIN pg_catalog.pg_roles r ON r.oid = g.grantee
          WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
          ORDER BY schema, object_name, grantee, privilege`,
  },
  {
    section: "schemaPrivileges",
    sql: `SELECT n.nspname AS schema,
                 CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
                 g.privilege_type AS privilege,
                 g.is_grantable AS grantable
          FROM pg_catalog.pg_namespace n
          CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS g
          LEFT JOIN pg_catalog.pg_roles r ON r.oid = g.grantee
          WHERE n.nspname = 'public'
          ORDER BY n.nspname, grantee, privilege`,
  },
  {
    section: "defaultPrivileges",
    sql: `SELECT d.defaclrole::regrole::text AS owner_role,
                 n.nspname AS schema,
                 CASE d.defaclobjtype
                   WHEN 'r' THEN 'TABLE' WHEN 'S' THEN 'SEQUENCE'
                   WHEN 'f' THEN 'FUNCTION' WHEN 'T' THEN 'TYPE'
                   WHEN 'n' THEN 'SCHEMA' ELSE d.defaclobjtype END AS object_type,
                 CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE r.rolname END AS grantee,
                 g.privilege_type AS privilege,
                 g.is_grantable AS grantable
          FROM pg_catalog.pg_default_acl d
          LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
          CROSS JOIN LATERAL aclexplode(d.defaclacl) AS g
          LEFT JOIN pg_catalog.pg_roles r ON r.oid = g.grantee
          WHERE n.nspname = 'public' OR n.nspname IS NULL
          ORDER BY owner_role, schema, object_type, grantee, privilege`,
  },
  {
    section: "extensions",
    sql: `SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version
          FROM pg_catalog.pg_extension e
          JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
          ORDER BY e.extname`,
  },
];

/** Names of every catalog query (must be SELECT-only; asserted in tests). */
export const CATALOG_QUERY_NAMES: ReadonlySet<string> = new Set(
  CATALOG_QUERIES.map((q) => q.section)
);

function buildMigrationRecord(row: CatalogRow): CatalogRecord {
  return {
    identity: String(row.version ?? ""),
    source: "supabase_migrations.schema_migrations",
    fields: {
      version: String(row.version ?? ""),
      name: trimOrEmpty(String(row.name ?? "")),
    },
  };
}

function buildTableRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  return {
    identity: `${schema}.${name}`,
    source: `pg_class: ${schema}.${name}`,
    fields: {
      schema,
      name,
      kind: trimOrEmpty(String(row.kind ?? "")),
      persistence: trimOrEmpty(String(row.persistence ?? "")),
    },
  };
}

function buildColumnRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const table = trimOrEmpty(String(row.table ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  return {
    identity: `${schema}.${table}.${name}`,
    source: `pg_attribute: ${schema}.${table}.${name}`,
    fields: {
      schema,
      table,
      name,
      ordinal: toPrimitiveField(row.ordinal) as number,
      dataType: trimOrEmpty(String(row.data_type ?? "")),
      nullable: normalizeBoolean(row.nullable) ?? false,
      // Raw default expressions are never retained — only a hash.
      defaultHash: row.default_expr == null ? null : sqlHash(String(row.default_expr)),
      generated: trimOrEmpty(String(row.generated ?? "")),
    },
  };
}

function buildConstraintRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const table = trimOrEmpty(String(row.table ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  const type = mapConstraintType(String(row.type ?? ""));
  return {
    identity: `${schema}.${table}.${name}`,
    source: `pg_constraint: ${schema}.${table}.${name}`,
    fields: {
      schema,
      table,
      name,
      type,
      // Raw constraint definitions are never retained — only a hash.
      definitionHash: sqlHash(String(row.definition ?? "")),
    },
  };
}

function buildForeignKeyRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const table = trimOrEmpty(String(row.table ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  const columns = decodePostgresStringArray(row.columns);
  const referencedColumns = decodePostgresStringArray(row.referenced_columns);
  return {
    identity: `${schema}.${table}.${name}`,
    source: `pg_constraint(f): ${schema}.${table}.${name}`,
    fields: {
      schema,
      table,
      name,
      // Column order is preserved (composite FK column order is meaningful).
      columns,
      referencedSchema: trimOrEmpty(String(row.referenced_schema ?? "")),
      referencedTable: trimOrEmpty(String(row.referenced_table ?? "")),
      referencedColumns,
      onDelete: mapActionCode(String(row.on_delete ?? "")),
      onUpdate: mapActionCode(String(row.on_update ?? "")),
      deferrable: normalizeBoolean(row.deferrable) ?? false,
      initiallyDeferred: normalizeBoolean(row.initially_deferred) ?? false,
    },
  };
}

function buildIndexRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const table = trimOrEmpty(String(row.table ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  return {
    identity: `${schema}.${table}.${name}`,
    source: `pg_index: ${schema}.${table}.${name}`,
    fields: {
      schema,
      table,
      name,
      unique: normalizeBoolean(row.unique) ?? false,
      // Raw index definitions are never retained — only a hash.
      definitionHash: sqlHash(String(row.definition ?? "")),
    },
  };
}

function buildSequenceRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  return {
    identity: `${schema}.${name}`,
    source: `pg_sequence: ${schema}.${name}`,
    fields: {
      schema,
      name,
      dataType: trimOrEmpty(String(row.data_type ?? "")),
      ownedBy: row.owned_by == null ? null : trimOrEmpty(String(row.owned_by)),
    },
  };
}

function buildViewRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  return {
    identity: `${schema}.${name}`,
    source: `pg_class(view): ${schema}.${name}`,
    fields: {
      schema,
      name,
      kind: trimOrEmpty(String(row.kind ?? "")),
      // Raw view definitions are never retained — only a hash.
      definitionHash: sqlHash(String(row.definition ?? "")),
    },
  };
}

function buildFunctionRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  const signature = trimOrEmpty(String(row.signature ?? ""));
  const config = decodePostgresStringArray(row.config);
  const searchPathEntry = config.find((c) => c.startsWith("search_path="));
  const searchPath = searchPathEntry ? searchPathEntry.slice("search_path=".length) : "";
  return {
    identity: `${schema}.${name}(${signature})`,
    source: `pg_proc: ${schema}.${name}(${signature})`,
    fields: {
      schema,
      name,
      signature,
      returnType: trimOrEmpty(String(row.return_type ?? "")),
      language: trimOrEmpty(String(row.language ?? "")),
      volatility: trimOrEmpty(String(row.volatility ?? "")),
      securityMode: trimOrEmpty(String(row.security_mode ?? "INVOKER")),
      // search_path order is preserved.
      searchPath: normalizeSearchPath(searchPath),
      // Effective ACLs: proacl falls back to the default ACL (so default
      // PUBLIC EXECUTE is never hidden). Grantor suffixes are stripped.
      acl: normalizeAcl(decodePostgresStringArray(row.acl)),
      // Function bodies are NEVER stored — only a VERBATIM sha256 of the raw
      // body text. No whitespace normalization is applied: `--` line comments,
      // block comments, dollar-quoted strings, and quoted literals all carry
      // meaning that whitespace collapse would silently corrupt.
      bodyHash: verbatimHash(String(row.body ?? "")),
    },
  };
}

/**
 * Decode a Postgres `tgtype` bitfield into a stable trigger record:
 * `{ timing, events }` where timing is ROW/STATEMENT and events is the sorted
 * list of INSERT/UPDATE/DELETE/TRUNCATE.
 */
export function decodeTriggerType(tgtype: unknown): { timing: string; events: string[] } {
  const bits = Number(tgtype ?? 0);
  const timing = bits & 1 ? "ROW" : "STATEMENT";
  const events: string[] = [];
  if (bits & 4) events.push("INSERT");
  if (bits & 8) events.push("DELETE");
  if (bits & 16) events.push("UPDATE");
  if (bits & 32) events.push("TRUNCATE");
  return { timing, events };
}

function buildTriggerRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const table = trimOrEmpty(String(row.table ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  const state = trimOrEmpty(String(row.state ?? ""));
  const { timing, events } = decodeTriggerType(row.tgtype);
  return {
    identity: `${schema}.${table}.${name}`,
    source: `pg_trigger: ${schema}.${table}.${name}`,
    fields: {
      schema,
      table,
      name,
      function: trimOrEmpty(String(row.function ?? "")),
      // Raw trigger state is preserved (O = enabled, D = disabled,
      // R = replica, A = always).
      state,
      // Timing (ROW vs STATEMENT) and events from the tgtype bitfield.
      timing,
      events,
      // Raw trigger definitions are never retained — only a hash.
      definitionHash: sqlHash(String(row.definition ?? "")),
    },
  };
}

function buildRlsRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const table = trimOrEmpty(String(row.table ?? ""));
  return {
    identity: `${schema}.${table}`,
    source: `pg_class(relrowsecurity): ${schema}.${table}`,
    fields: {
      schema,
      table,
      enabled: normalizeBoolean(row.enabled) ?? false,
      forced: normalizeBoolean(row.forced) ?? false,
    },
  };
}

function buildPolicyRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const table = trimOrEmpty(String(row.table ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  const roles = decodePostgresStringArray(row.roles);
  return {
    identity: `${schema}.${table}.${name}`,
    source: `pg_policy: ${schema}.${table}.${name}`,
    fields: {
      schema,
      table,
      name,
      command: mapPolicyCommand(String(row.command ?? "")),
      roles: normalizeRoles(roles),
      permissive: normalizeBoolean(row.permissive) ?? true,
      // Raw policy qualifiers are never retained — only hashes.
      usingHash: row.using_expr == null ? null : sqlHash(String(row.using_expr)),
      withCheckHash: row.with_check_expr == null ? null : sqlHash(String(row.with_check_expr)),
    },
  };
}

function buildGrantRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const objectType = trimOrEmpty(String(row.object_type ?? ""));
  const objectName = trimOrEmpty(String(row.object_name ?? ""));
  const grantee = trimOrEmpty(String(row.grantee ?? ""));
  const privilege = trimOrEmpty(String(row.privilege ?? ""));
  return {
    identity: `${schema}.${objectType}.${objectName}.${grantee}.${privilege}`,
    source: `aclexplode: ${schema}.${objectType}.${objectName}`,
    fields: {
      schema,
      objectType,
      objectName,
      grantee,
      privilege,
      grantable: normalizeBoolean(row.grantable) ?? false,
    },
  };
}

function buildSchemaPrivilegeRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const grantee = trimOrEmpty(String(row.grantee ?? ""));
  const privilege = trimOrEmpty(String(row.privilege ?? ""));
  return {
    identity: `${schema}.${grantee}.${privilege}`,
    source: `pg_namespace(nspacl): ${schema}`,
    fields: {
      schema,
      grantee,
      privilege,
      grantable: normalizeBoolean(row.grantable) ?? false,
    },
  };
}

function buildDefaultPrivilegeRecord(row: CatalogRow): CatalogRecord {
  const ownerRole = trimOrEmpty(String(row.owner_role ?? ""));
  const schema = row.schema == null ? "" : trimOrEmpty(String(row.schema));
  const objectType = trimOrEmpty(String(row.object_type ?? ""));
  const grantee = trimOrEmpty(String(row.grantee ?? ""));
  const privilege = trimOrEmpty(String(row.privilege ?? ""));
  return {
    identity: `${ownerRole}.${schema}.${objectType}.${grantee}.${privilege}`,
    source: `pg_default_acl: ${ownerRole}.${schema}.${objectType}`,
    fields: {
      ownerRole,
      schema,
      objectType,
      grantee,
      privilege,
      grantable: normalizeBoolean(row.grantable) ?? false,
    },
  };
}

function buildExtensionRecord(row: CatalogRow): CatalogRecord {
  const schema = trimOrEmpty(String(row.schema ?? ""));
  const name = trimOrEmpty(String(row.name ?? ""));
  return {
    identity: `${schema}.${name}`,
    source: `pg_extension: ${schema}.${name}`,
    fields: {
      schema,
      name,
      version: trimOrEmpty(String(row.version ?? "")),
    },
  };
}

/** Row → normalized record builders per section. */
const BUILDERS: Record<CatalogSection, (row: CatalogRow) => CatalogRecord> = {
  migrationLedger: buildMigrationRecord,
  tables: buildTableRecord,
  columns: buildColumnRecord,
  constraints: buildConstraintRecord,
  foreignKeys: buildForeignKeyRecord,
  indexes: buildIndexRecord,
  sequences: buildSequenceRecord,
  views: buildViewRecord,
  functions: buildFunctionRecord,
  triggers: buildTriggerRecord,
  rls: buildRlsRecord,
  policies: buildPolicyRecord,
  grants: buildGrantRecord,
  schemaPrivileges: buildSchemaPrivilegeRecord,
  defaultPrivileges: buildDefaultPrivilegeRecord,
  extensions: buildExtensionRecord,
};

/**
 * Execute the read-only catalog queries against a connected pg client and
 * build a normalized inventory. `runQuery` is injectable for unit testing;
 * the real runner wraps a `pg.Client`.
 */
export async function buildInventoryFromQueries(
  runQuery: (sql: string) => Promise<CatalogRow[]>
): Promise<SchemaInventory> {
  const catalog = {} as Record<CatalogSection, CatalogRecord[]>;
  for (const { section, sql } of CATALOG_QUERIES) {
    const rows = await runQuery(sql);
    catalog[section] = rows.map((row) => BUILDERS[section](row));
  }
  return {
    formatVersion: INVENTORY_FORMAT_VERSION,
    source: "local",
    capturedAt: new Date().toISOString(),
    catalog,
  };
}

/**
 * Capture a normalized local inventory from a loopback-only database URL.
 * Rejects non-loopback URLs before opening any connection. Uses read-only
 * catalog SELECTs; the connection is configured read-only and closed in all
 * paths. Never queries table rows.
 */
export async function captureLocalInventory(dbUrl: string): Promise<SchemaInventory> {
  assertLoopbackDbUrl(dbUrl);
  const client = new Client({
    connectionString: dbUrl,
    // Defense in depth: even if a future query regresses to a write, the
    // session is read-only.
    options: "-c default_transaction_read_only=on",
    statement_timeout: 30_000,
    query_timeout: 30_000,
  });
  try {
    await client.connect();
    return await buildInventoryFromQueries(async (sql) => {
      const result = await client.query(sql);
      return result.rows as CatalogRow[];
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}