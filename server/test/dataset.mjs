import { MONTH_NAMES } from "../dates.mjs";
import { legacyHash, legacyStored } from "../passwords.mjs";
import { SERVICES } from "./fixture.mjs";

/**
 * One varied set of records, loaded identically into the Apps Script
 * harness's sheets and into Postgres, so every read can be put to both.
 * Seeded, so a failure reproduces.
 */

export const ADMIN = {
  email: "host@ched.gov.ph",
  password: "correct horse battery",
};
const SALT = "salt-for-the-read-tests";

function random(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REGIONS = [
  ["National Capital Region", "NCR"],
  ["04 - Calabarzon", "IV-A"],
  ["Region 4", "IV-A"],
  ["Cordillera Administrative Region", "CAR"],
];
const SUGGESTIONS = [
  "",
  "",
  "Faster please",
  "Very helpful staff",
  "The queue was long",
  "=SUM(A1)",
];
const STATUSES = [
  "NONE",
  "NONE",
  "REQUESTED",
  "PROCESSING",
  "ISSUED",
  "ISSUED",
  "DECLINED",
  "ERROR: Drive quota exceeded",
];

export function buildDataset() {
  const pick = random(20261008);
  const choose = (list) => list[Math.floor(pick() * list.length)];
  const days = [
    "2025-11-03",
    "2025-12-19",
    "2026-01-15",
    "2026-02-27",
    "2026-03-31",
    "2026-04-01",
    "2026-05-12",
    "2026-06-30",
    "2026-07-01",
    "2026-08-08",
    "2026-09-16",
    "2026-09-30",
    "2026-10-01",
    "2026-10-07",
  ];
  const responses = [];
  for (let i = 0; i < 64; i++) {
    const service = choose(SERVICES);
    const [region, regionCode] = choose(REGIONS);
    const transactionDate = choose(days);
    const status = choose(STATUSES);
    const coaRequested = status !== "NONE";
    const issued = status === "ISSUED";
    const cc1 = choose(["1", "2", "3", "4", "4"]);
    const answer = () => choose(["1", "2", "3", "4", "5", "5", "5", "N/A"]);
    responses.push({
      referenceId: `CSM-${String(i).padStart(4, "0")}TEST${i % 10}`,
      submittedAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000),
      transactionDate,
      clientType: choose(["CITIZEN", "CITIZEN", "BUSINESS", "GOVERNMENT"]),
      sex: choose(["", "MALE", "FEMALE", "FEMALE"]),
      age: choose([null, 15, 16, 17, 30, 31, 45, 46, 88]),
      region,
      regionCode,
      serviceId: service.service_id,
      serviceCode: service.code,
      serviceName: service.name_en,
      otherService: service.category === "other" ? "Walk-in inquiry" : "",
      // Older forms let the Charter-unaware rate CC2 and CC3 anyway.
      cc1,
      cc2: cc1 === "4" && pick() < 0.5 ? "N/A" : choose(["1", "2", "3", "4"]),
      cc3: cc1 === "4" && pick() < 0.5 ? "N/A" : choose(["1", "2", "3"]),
      ...Object.fromEntries(
        [
          "sqd0",
          "sqd1",
          "sqd2",
          "sqd3",
          "sqd4",
          "sqd5",
          "sqd6",
          "sqd7",
          "sqd8",
        ].map((k) => [k, answer()]),
      ),
      suggestions: choose(SUGGESTIONS),
      email: `client${i}@${choose(["gmail.com", "ched.gov.ph", "example.ph"])}`,
      language: choose(["en", "tl"]),
      coaRequested,
      coaTitle: coaRequested ? choose(["Ms.", "Mr.", "Dr."]) : "",
      coaName: coaRequested ? `Client Number ${i}` : "",
      coaAgency: coaRequested ? "CHED" : "",
      coaPurpose: coaRequested ? "Proof of appearance" : "",
      coaDateFrom: coaRequested ? transactionDate : "",
      coaDateTo:
        coaRequested && pick() < 0.3
          ? transactionDate.replace(/-\d\d$/, "-28")
          : "",
      coaStatus: status,
      coaLink: issued ? `https://drive.google.com/file/d/F${i}/view` : "",
      coaIssuedAt: issued ? `2026-10-0${1 + (i % 7)} 1${i % 10}:0${i % 6}` : "",
      coaIssueKey: issued ? `key-${i}` : "",
      // Some certificates were edited after release, some predate the record.
      coaIssuedDetails:
        issued && pick() < 0.6
          ? JSON.stringify({
              name: `Ms. Printed Name ${i}`,
              agency: "CHED",
              purpose: "Proof of appearance",
              dateCoverage: "on October 1, 2026",
            })
          : "",
      coaDeclineReason:
        status === "DECLINED" ? "Not a transaction of this office" : "",
      verificationCode: coaRequested
        ? `OSDS-${String(i).padStart(20, "A")}`
        : "",
      verificationUrl: issued
        ? `https://portal.example/verification?code=${i}`
        : "",
    });
  }

  return {
    responses,
    settings: {
      office_name: "OSDS",
      coa_signatory: "Dr. Signatory",
      coa_designation: "Director IV",
      report_prepared_by: "Analyst",
    },
    stats: [
      {
        period_key: "2026-Q3",
        service_id: "S-CHARGES",
        clients: 40,
        transactions: 52,
        remarks: "Peak month",
      },
      {
        period_key: "2026-Q3",
        service_id: "S-FREE",
        clients: 12,
        transactions: null,
        remarks: "",
      },
      {
        period_key: "2026-Q2",
        service_id: "S-FREE",
        clients: 3,
        transactions: 3,
        remarks: "",
      },
    ],
    reports: [
      {
        report_id: "R-1",
        name: "CSM Summary Report — OSDS — 2nd Quarter 2026",
        period_key: "2026-Q2",
        period_label: "2nd Quarter 2026",
        file_id: "F-1",
        url: "https://docs.google.com/spreadsheets/d/F-1",
        created_at: new Date("2026-07-03T01:15:00Z"),
        created_by: "host@ched.gov.ph",
      },
      {
        report_id: "R-2",
        name: "CSM Summary Report — OSDS — 3rd Quarter 2026",
        period_key: "2026-Q3",
        period_label: "3rd Quarter 2026",
        file_id: "F-2",
        url: "https://docs.google.com/spreadsheets/d/F-2",
        created_at: new Date("2026-10-02T23:59:00Z"),
        created_by: "staff@ched.gov.ph",
      },
    ],
    users: [
      {
        user_id: "U-host",
        name: "Portal Host",
        role: "superadmin",
        email: ADMIN.email,
        active: true,
        created_at: new Date("2026-01-04T16:30:00Z"),
        updated_at: new Date("2026-09-30T17:00:00Z"),
      },
      {
        user_id: "U-staff",
        name: "Staff Member",
        role: "admin",
        email: "staff@ched.gov.ph",
        active: true,
        created_at: new Date("2026-02-01T02:00:00Z"),
        updated_at: new Date("2026-02-01T02:00:00Z"),
      },
      {
        user_id: "U-gone",
        name: "Former Staff",
        role: "admin",
        email: "former@ched.gov.ph",
        active: false,
        created_at: new Date("2026-03-09T09:00:00Z"),
        updated_at: new Date("2026-06-01T09:00:00Z"),
      },
    ],
  };
}

/** The Responses sheet as Apps Script wrote it. */
export function loadIntoGas(gas, data) {
  for (const r of data.responses)
    gas.addResponse({
      Timestamp: r.submittedAt,
      ResponseID: r.referenceId,
      TransactionDate: r.transactionDate,
      Month:
        MONTH_NAMES[Number(r.transactionDate.slice(5, 7)) - 1].toUpperCase(),
      Year: Number(r.transactionDate.slice(0, 4)),
      ClientType: r.clientType,
      Sex: r.sex,
      Age: r.age == null ? "N/A" : r.age,
      Region: r.region,
      RegionCode: r.regionCode,
      ServiceID: r.serviceId,
      ServiceCode: r.serviceCode,
      ServiceName: r.serviceName,
      OtherService: r.otherService,
      CC1: r.cc1,
      CC2: r.cc2,
      CC3: r.cc3,
      SQD0: r.sqd0,
      SQD1: r.sqd1,
      SQD2: r.sqd2,
      SQD3: r.sqd3,
      SQD4: r.sqd4,
      SQD5: r.sqd5,
      SQD6: r.sqd6,
      SQD7: r.sqd7,
      SQD8: r.sqd8,
      Suggestions: r.suggestions,
      Email: r.email,
      Language: r.language,
      COARequested: r.coaRequested ? "YES" : "NO",
      COATitle: r.coaTitle,
      COAName: r.coaName,
      COAAgency: r.coaAgency,
      COAPurpose: r.coaPurpose,
      COADateFrom: r.coaDateFrom,
      COADateTo: r.coaDateTo,
      COAStatus: r.coaStatus,
      COALink: r.coaLink,
      COAIssuedAt: r.coaIssuedAt,
      COAIssueKey: r.coaIssueKey,
      COAIssuedDetails: r.coaIssuedDetails,
      COADeclineReason: r.coaDeclineReason,
      VerificationCode: r.verificationCode,
      VerificationURL: r.verificationUrl,
    });
  gas.setSheet("Settings", [
    ["key", "value"],
    ...Object.entries(data.settings),
  ]);
  gas.setSheet("ServiceStats", [
    [
      "period_key",
      "service_id",
      "clients",
      "transactions",
      "remarks",
      "updated_at",
    ],
    ...data.stats.map((s) => [
      s.period_key,
      s.service_id,
      s.clients ?? "",
      s.transactions ?? "",
      s.remarks,
      new Date(),
    ]),
  ]);
  gas.setSheet("Reports", [
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
    ...data.reports.map((r) => [
      r.report_id,
      r.name,
      r.period_key,
      r.period_label,
      r.file_id,
      r.url,
      r.created_at,
      r.created_by,
    ]),
  ]);
  gas.setSheet("Whitelist", [
    ["user_id", "name", "role", "email", "active", "created_at", "updated_at"],
    ...data.users.map((u) => [
      u.user_id,
      u.name,
      u.role,
      u.email,
      u.active,
      u.created_at,
      u.updated_at,
    ]),
  ]);
  // The credentials half of each account, which a save without a new
  // password still updates.
  gas.setSheet("Users", [
    ["Email", "PasswordHash", "Salt", "Name", "Role", "Active", "CreatedAt"],
    ...data.users.map((u) => [
      u.email,
      "hash",
      "salt",
      u.name,
      u.role,
      u.active,
      u.created_at,
    ]),
  ]);
  gas.setSheet("Audit", [
    [
      "timestamp",
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
  ]);
  // Every admin action below is an authorised one; sign-in is tested elsewhere.
  gas.call(
    "requireAdmin_ = requireSuperadmin_ = function () { return { email: 'host@ched.gov.ph', role: 'superadmin' }; }",
  );
}

export async function loadIntoDb(db, data) {
  const columns = {
    reference_id: "referenceId",
    submitted_at: "submittedAt",
    transaction_date: "transactionDate",
    client_type: "clientType",
    sex: "sex",
    age: "age",
    region: "region",
    region_code: "regionCode",
    service_id: "serviceId",
    service_code: "serviceCode",
    service_name: "serviceName",
    other_service: "otherService",
    cc1: "cc1",
    cc2: "cc2",
    cc3: "cc3",
    sqd0: "sqd0",
    sqd1: "sqd1",
    sqd2: "sqd2",
    sqd3: "sqd3",
    sqd4: "sqd4",
    sqd5: "sqd5",
    sqd6: "sqd6",
    sqd7: "sqd7",
    sqd8: "sqd8",
    suggestions: "suggestions",
    email: "email",
    language: "language",
    coa_requested: "coaRequested",
    coa_title: "coaTitle",
    coa_name: "coaName",
    coa_agency: "coaAgency",
    coa_purpose: "coaPurpose",
    coa_date_from: "coaDateFrom",
    coa_date_to: "coaDateTo",
    coa_status: "coaStatus",
    coa_link: "coaLink",
    coa_issued_at: "coaIssuedAt",
    coa_issue_key: "coaIssueKey",
    coa_issued_details: "coaIssuedDetails",
    coa_decline_reason: "coaDeclineReason",
    verification_code: "verificationCode",
    verification_url: "verificationUrl",
  };
  const names = Object.keys(columns);
  for (const r of data.responses) {
    const value = (column) => {
      const v = r[columns[column]];
      if (column === "coa_issued_at") return v ? `${v}:00+08` : null;
      if (
        [
          "coa_date_from",
          "coa_date_to",
          "coa_issued_details",
          "verification_code",
        ].includes(column)
      )
        return v || null;
      return v;
    };
    await db.query(
      `insert into csm.responses (${names.join(", ")})
       values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map(value),
    );
  }
  for (const [key, value] of Object.entries(data.settings))
    await db.query("insert into csm.settings (key, value) values ($1, $2)", [
      key,
      value,
    ]);
  for (const s of data.stats)
    await db.query(
      `insert into csm.service_stats (period_key, service_id, clients, transactions, remarks)
       values ($1, $2, $3, $4, $5)`,
      [s.period_key, s.service_id, s.clients, s.transactions, s.remarks],
    );
  for (const r of data.reports)
    await db.query(
      `insert into csm.reports (report_id, name, period_key, period_label, file_id, url, created_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        r.report_id,
        r.name,
        r.period_key,
        r.period_label,
        r.file_id,
        r.url,
        r.created_at,
        r.created_by,
      ],
    );
  for (const u of data.users)
    await db.query(
      `insert into csm.admin_users (user_id, email, name, role, active, password_hash,
         credential_version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, 'v1', $7, $8)`,
      [
        u.user_id,
        u.email,
        u.name,
        u.role,
        u.active,
        legacyStored(legacyHash(ADMIN.password, SALT), SALT),
        u.created_at,
        u.updated_at,
      ],
    );
}
