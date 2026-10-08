/**
 * Writes a transformed export into the database, in one transaction: either
 * everything arrives or nothing does.
 *
 * Rows go in in sheet order, so every list the sheets gave in row order keeps
 * that order here. Each table is sent as one JSON parameter and expanded by
 * Postgres, which keeps a few thousand responses to a handful of round trips.
 */

const TABLES = [
  "csm.admin_sessions",
  "csm.login_attempts",
  "csm.admin_users",
  "csm.audit_log",
  "csm.reports",
  "csm.service_stats",
  "csm.responses",
  "csm.services",
  "csm.settings",
];

async function counts(db) {
  const [row] = await db.query(`
    select (select count(*)::int from csm.responses) as responses,
           (select count(*)::int from csm.services) as services,
           (select count(*)::int from csm.settings) as settings,
           (select count(*)::int from csm.admin_users) as admin_users,
           (select count(*)::int from csm.audit_log) as audit_log,
           (select count(*)::int from csm.reports) as reports,
           (select count(*)::int from csm.service_stats) as service_stats`);
  return row;
}

/**
 * `columns` are inserted from `rows` in their order; identity columns number
 * them as they arrive.
 */
async function insertRows(db, table, columns, rows) {
  if (!rows.length) return;
  const list = columns.join(", ");
  await db.query(
    `insert into ${table} (${list})
     select ${list}
     from json_populate_recordset(null::${table}, $1::text::json) with ordinality as r
     order by ordinality`,
    [JSON.stringify(rows)],
  );
}

const RESPONSE_COLUMNS = [
  "reference_id",
  "submission_id",
  "submitted_at",
  "transaction_date",
  "client_type",
  "sex",
  "age",
  "region",
  "region_code",
  "service_id",
  "service_code",
  "service_name",
  "other_service",
  "cc1",
  "cc2",
  "cc3",
  "sqd0",
  "sqd1",
  "sqd2",
  "sqd3",
  "sqd4",
  "sqd5",
  "sqd6",
  "sqd7",
  "sqd8",
  "suggestions",
  "email",
  "language",
  "coa_requested",
  "coa_title",
  "coa_name",
  "coa_agency",
  "coa_purpose",
  "coa_date_from",
  "coa_date_to",
  "coa_status",
  "coa_link",
  "coa_issued_at",
  "coa_issue_key",
  "coa_issued_details",
  "coa_decline_reason",
  "verification_code",
  "verification_url",
  "privacy_notice_version",
  "privacy_notice_presented_at",
];

export async function loadImport(db, tables, { replace = false } = {}) {
  return db.transaction(async (tx) => {
    const before = await counts(tx);
    const occupied = Object.values(before).some((n) => n > 0);
    if (occupied && !replace)
      throw new Error(
        `The database already holds data (${Object.entries(before)
          .filter(([, n]) => n)
          .map(([table, n]) => `${n} ${table.replace("_", " ")}`)
          .join(", ")}). Run again with --replace to clear it first.`,
      );
    if (occupied) {
      // The audit log refuses deletion by design; a replace is the one
      // deliberate exception, and its triggers come back on before commit.
      await tx.query("alter table csm.audit_log disable trigger user");
      await tx.query(`truncate ${TABLES.join(", ")} restart identity`);
      await tx.query("alter table csm.audit_log enable trigger user");
    }
    await tx.query(
      "update csm.audit_state set head_hash = '', dropped_count = 0, dropped_last = ''",
    );

    await insertRows(tx, "csm.settings", ["key", "value"], tables.settings);
    await insertRows(
      tx,
      "csm.services",
      [
        "service_id",
        "code",
        "name_en",
        "name_tl",
        "category",
        "active",
        "has_fees",
        "sort_order",
        "created_at",
        "updated_at",
      ],
      tables.services,
    );
    await insertRows(tx, "csm.responses", RESPONSE_COLUMNS, tables.responses);
    await insertRows(
      tx,
      "csm.service_stats",
      [
        "period_key",
        "service_id",
        "clients",
        "transactions",
        "remarks",
        "updated_at",
      ],
      tables.serviceStats,
    );
    await insertRows(
      tx,
      "csm.reports",
      [
        "report_id",
        "name",
        "period_key",
        "period_label",
        "file_id",
        "url",
        "created_at",
        "created_by",
      ],
      tables.reports,
    );
    await insertRows(
      tx,
      "csm.admin_users",
      [
        "user_id",
        "email",
        "name",
        "role",
        "active",
        "password_hash",
        "credential_version",
        "created_at",
        "updated_at",
      ],
      tables.adminUsers,
    );
    await insertRows(
      tx,
      "csm.audit_log",
      [
        "logged_at",
        "audit_id",
        "actor_email",
        "actor_role",
        "action",
        "target_type",
        "target_id",
        "outcome",
        "details",
        "request_id",
        "previous_hash",
        "entry_hash",
      ],
      tables.auditLog,
    );
    await tx.query(
      "update csm.audit_state set head_hash = $1, dropped_count = $2, dropped_last = $3",
      [
        tables.auditState.head_hash,
        tables.auditState.dropped_count,
        tables.auditState.dropped_last,
      ],
    );
    return { replaced: occupied ? before : null, loaded: await counts(tx) };
  });
}
