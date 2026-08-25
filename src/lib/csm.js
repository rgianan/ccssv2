/**
 * Canonical CSM vocabulary shared by the public form, the admin module, and the
 * Apps Script report writer. Every stored value is the English `value` string —
 * Tagalog exists only for display, so switching language never changes the data
 * that lands in the sheet or the generated report.
 */

export const LANGUAGES = [
  { id: "en", label: "English", short: "EN" },
  { id: "tl", label: "Tagalog", short: "TL" },
];

/**
 * A response is dated by the office that receives it, not by the client's
 * device. Apps Script formats and buckets every date in this zone (see
 * appsscript.json), so the form has to offer the same day the backend would
 * call today — `toISOString()` is UTC and lands on yesterday until 8am here,
 * which pushes submissions into the previous quarter at a period boundary.
 */
export const PORTAL_TIME_ZONE = "Asia/Manila";

const portalDateParts = (date) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PORTAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
};

/** yyyy-MM-dd in the portal's timezone — the shape the backend stores. */
export const portalToday = (date = new Date()) => {
  const { year, month, day } = portalDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

/** Calendar year and quarter (1-4) in the portal's timezone. */
export const portalPeriodNow = (date = new Date()) => {
  const { year, month } = portalDateParts(date);
  return { year, quarter: String(Math.floor((month - 1) / 3) + 1) };
};

export const CLIENT_TYPES = [
  { value: "Citizen", en: "Citizen", tl: "Mamamayan" },
  { value: "Business", en: "Business", tl: "Negosyo" },
  {
    value: "Government",
    en: "Government (employee or another agency)",
    tl: "Pamahalaan (empleyado o ibang ahensya)",
  },
];

export const SEXES = [
  { value: "Male", en: "Male", tl: "Lalaki" },
  { value: "Female", en: "Female", tl: "Babae" },
];

/**
 * The official region names, in the order the office lists them.
 *
 * `code` is what the CSM Summary Report counts by, and these codes are
 * deliberately unchanged from the portal's earlier, shorter labels — the
 * report's region columns and every response already recorded still line up.
 * The names are proper nouns, so there is no Tagalog variant to fall back to.
 */
export const REGIONS = [
  { value: "National Capital Region", code: "NCR", en: "National Capital Region" },
  { value: "01 - Ilocos Region", code: "I", en: "01 - Ilocos Region" },
  { value: "02 - Cagayan Valley", code: "II", en: "02 - Cagayan Valley" },
  { value: "03 - Central Luzon", code: "III", en: "03 - Central Luzon" },
  { value: "04 - CALABARZON", code: "IV-A", en: "04 - CALABARZON" },
  { value: "05 - Bicol Region", code: "V", en: "05 - Bicol Region" },
  { value: "06 - Western Visayas", code: "VI", en: "06 - Western Visayas" },
  { value: "07 - Central Visayas", code: "VII", en: "07 - Central Visayas" },
  { value: "08 - Eastern Visayas", code: "VIII", en: "08 - Eastern Visayas" },
  { value: "09 - Zamboanga Peninsula", code: "IX", en: "09 - Zamboanga Peninsula" },
  { value: "10 - Northern Mindanao", code: "X", en: "10 - Northern Mindanao" },
  { value: "11 - Davao Region", code: "XI", en: "11 - Davao Region" },
  { value: "12 - Soccsksargen", code: "XII", en: "12 - Soccsksargen" },
  { value: "Caraga", code: "CARAGA", en: "Caraga" },
  {
    value: "Cordillera Administrative Region",
    code: "CAR",
    en: "Cordillera Administrative Region",
  },
  {
    value: "Bangsamoro Autonomous Region in Muslim Mindanao",
    code: "BARMM",
    en: "Bangsamoro Autonomous Region in Muslim Mindanao",
  },
  { value: "MIMAROPA", code: "IV-B", en: "MIMAROPA" },
  { value: "Negros Island Region", code: "NIR", en: "Negros Island Region" },
];

export const AGE_BRACKETS = [
  { label: "16 & Below (Child)", min: 0, max: 16 },
  { label: "17-30 (Young Adult)", min: 17, max: 30 },
  { label: "31-45 (Middle-aged Adult)", min: 31, max: 45 },
  { label: "Above 45 (Old-aged adult)", min: 46, max: 200 },
];

/** Seeded into the Services sheet on first setup. Admins add more from the UI. */
export const DEFAULT_SERVICES = [
  {
    code: "CEM/CED",
    name_en:
      "Application for Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)",
    name_tl:
      "Aplikasyon para sa Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)",
  },
  {
    code: "SIAP 1",
    name_en: "Application for Student Internship Program (SIAP) Phase 1",
    name_tl: "Aplikasyon para sa Student Internship Program (SIAP) Phase 1",
  },
  {
    code: "SIAP 2",
    name_en: "Application for Student Internship Program (SIAP) Phase 2",
    name_tl: "Aplikasyon para sa Student Internship Program (SIAP) Phase 2",
  },
  {
    code: "BI INDORSEMENT",
    name_en:
      "Request for Endorsement for Conversion/Extension of Visa of Foreign Students to the Bureau of Immigration",
    name_tl:
      "Kahilingan para sa Endorsement para sa Conversion/Extension ng Visa ng mga Dayuhang Estudyante sa Bureau of Immigration",
  },
];

export const OTHER_SERVICE_CODE = "OTHER";

/**
 * Citizen's Charter block. Option `value` is the number stored in the sheet.
 *
 * The wording and the option sets follow the harmonised CSM questionnaire in
 * ARTA Memorandum Circular No. 2023-05 (s. 2023). N/A remains a stored value
 * and still appears in the report exactly as the circular expects — it is
 * simply no longer a button. CC2 and CC3 ask about a Charter the client has
 * seen, so a client who picks CC1's fourth option is not shown them at all and
 * is recorded as N/A automatically. That is clearer than asking someone to
 * classify their own answer as inapplicable, and it is better data: nobody
 * rates the visibility of a document they have just said they never saw.
 */
export const CC_QUESTIONS = [
  {
    id: "cc1",
    number: "CC1",
    en: "Which of the following best describes your awareness of the CC?",
    tl: "Alin sa mga sumusunod ang naglalarawan sa iyong kaalaman sa CC?",
    options: [
      {
        value: "1",
        en: "I know what a CC is and I saw this office's CC.",
        tl: "Alam ko ang CC at nakita ko ito sa napuntahang opisina.",
      },
      {
        value: "2",
        en: "I know what a CC is but I did NOT see this office's CC.",
        tl: "Alam ko ang CC pero hindi ko ito nakita sa napuntahang opisina.",
      },
      {
        value: "3",
        en: "I learned of the CC only when I saw this office's CC.",
        tl: "Nalaman ko ang CC nang makita ko ito sa napuntahang opisina.",
      },
      {
        value: "4",
        en: "I do not know what a CC is and I did not see one in this office.",
        tl: "Hindi ko alam kung ano ang CC at wala akong nakita sa napuntahang opisina.",
      },
    ],
  },
  {
    id: "cc2",
    number: "CC2",
    en: "If aware of CC (answered 1-3 in CC1), would you say that the CC of this office was…",
    tl: "Kung alam mo ang CC (sumagot ng 1-3 sa CC1), masasabi mo ba na ang CC ng napuntahang opisina ay…",
    options: [
      { value: "1", en: "Easy to see", tl: "Madaling makita" },
      { value: "2", en: "Somewhat easy to see", tl: "Medyo madaling makita" },
      { value: "3", en: "Difficult to see", tl: "Mahirap makita" },
      { value: "4", en: "Not visible at all", tl: "Hindi makita" },
    ],
  },
  {
    id: "cc3",
    number: "CC3",
    en: "If aware of CC (answered options 1-3 in CC1), how much did the CC help you in your transaction?",
    tl: "Kung alam mo ang CC (sumagot ng 1-3 sa CC1), gaano nakatulong ang CC sa iyong transaksyon?",
    options: [
      { value: "1", en: "Helped very much", tl: "Sobrang nakatulong" },
      { value: "2", en: "Somewhat helped", tl: "Medyo nakatulong" },
      { value: "3", en: "Did not help", tl: "Hindi nakatulong" },
    ],
  },
];

/** `dimension` labels the column group in the CSM Summary Report. */
export const SQD_QUESTIONS = [
  {
    id: "sqd0",
    number: "SQD0",
    dimension: "",
    en: "I am satisfied with the service that I availed.",
    tl: "Nasiyahan ako sa serbisyo na aking natanggap sa napuntahang tanggapan.",
  },
  {
    id: "sqd1",
    number: "SQD1",
    dimension: "Responsiveness",
    en: "I spent a reasonable amount of time for my transaction.",
    tl: "Makatwiran ang oras na aking ginugol para sa pagproseso ng aking transaksyon.",
  },
  {
    id: "sqd2",
    number: "SQD2",
    dimension: "Reliability (Quality)",
    en: "The office followed the transaction's requirements and steps based on the information provided.",
    tl: "Ang opisina ay sumusunod sa mga kinakailangang dokumento at mga hakbang batay sa impormasyong ibinigay.",
  },
  {
    id: "sqd3",
    number: "SQD3",
    dimension: "Access & Facilities",
    en: "The steps (including payment) I needed to do for my transaction were easy and simple.",
    tl: "Ang mga hakbang sa pagproseso, kasama na ang pagbabayad, ay madali at simple.",
  },
  {
    id: "sqd4",
    number: "SQD4",
    dimension: "Communication",
    en: "I easily found information about my transaction from the office or its website.",
    tl: "Mabilis at madali akong nakahanap ng impormasyon tungkol sa aking transaksyon mula sa opisina o sa website nito.",
  },
  {
    id: "sqd5",
    number: "SQD5",
    dimension: "Costs",
    en: "I paid a reasonable amount of fees for my transaction.",
    tl: "Nagbayad ako ng makatwirang halaga ng bayarin para sa aking transaksyon.",
  },
  {
    id: "sqd6",
    number: "SQD6",
    dimension: "Integrity",
    en: "I feel the office was fair to everyone, or walang palakasan, during my transaction.",
    tl: "Pakiramdam ko ay patas ang opisina sa lahat, o walang palakasan, sa aking transaksyon.",
  },
  {
    id: "sqd7",
    number: "SQD7",
    dimension: "Assurance",
    en: "I was treated courteously by the staff, and (if asked for help) the staff was helpful.",
    tl: "Magalang akong trinato ng mga tauhan, at (kung sakaling ako ay humingi ng tulong) alam ko na sila ay handang tumulong sa akin.",
  },
  {
    id: "sqd8",
    number: "SQD8",
    dimension: "Outcome",
    en: "I got what I needed from the government office, or (if denied) denial of request was sufficiently explained to me.",
    tl: "Nakuha ko ang klase ng serbisyo na kailangan ko mula sa tanggapang ito, o (kung tinanggihan) sapat na naipaliwanag sa akin ang dahilan.",
  },
];

/**
 * The five-point Likert scale of ARTA Memorandum Circular No. 2023-05
 * (s. 2023). N/A is still a stored value and still appears in the report — the
 * circular's reckoning is unchanged — but it is no longer offered as a button.
 * A dimension that does not apply is not shown at all and is recorded as N/A
 * automatically, which is both clearer for the client and better data than
 * asking them to classify their own answer as inapplicable.
 */
export const SQD_SCALE = [
  {
    value: "1",
    emoji: "😢",
    en: "Strongly Disagree",
    tl: "Lubos na Hindi Sumasang-ayon",
  },
  { value: "2", emoji: "🙁", en: "Disagree", tl: "Hindi Sumasang-ayon" },
  {
    value: "3",
    emoji: "😐",
    en: "Neither Agree nor Disagree",
    tl: "Walang Kinikilingan",
  },
  { value: "4", emoji: "🙂", en: "Agree", tl: "Sumasang-ayon" },
  { value: "5", emoji: "😄", en: "Strongly Agree", tl: "Lubos na Sumasang-ayon" },
];

/**
 * CC1's fourth choice: the client has never encountered a Citizen's Charter.
 * Must equal CC_UNAWARE_VALUE_ in google-apps-script/Code.gs — see the note
 * there for what a divergence does to a client mid-survey.
 */
export const CC_UNAWARE_VALUE = "4";

/**
 * The Charter questions to actually ask. All three are shown up front so the
 * client can see how long the step is; only the minority who say they do not
 * know the Charter see CC2 and CC3 drop away, and a step getting shorter reads
 * far better than two questions appearing after an answer.
 */
export const ccApplicable = (cc) =>
  cc.cc1 === CC_UNAWARE_VALUE ? CC_QUESTIONS.slice(0, 1) : CC_QUESTIONS;

/** All three, with anything that was not asked recorded as N/A. */
export const ccAnswers = (cc) =>
  Object.fromEntries(
    CC_QUESTIONS.map((question) => [
      question.id,
      cc.cc1 === CC_UNAWARE_VALUE && question.id !== "cc1"
        ? "N/A"
        : cc[question.id] || "",
    ]),
  );

/**
 * What the report and dashboard tally per question. CC2 and CC3 can hold N/A
 * because they may be skipped; CC1 cannot, so counting one for it would print
 * a column that is always zero.
 */
export const ccTallyOptions = (question) =>
  question.id === "cc1"
    ? question.options
    : question.options.concat([{ value: "N/A", en: "N/A", tl: "N/A" }]);

/** SQD5 asks about fees, so it is only put to clients of a service that charges them. */
export const SQD_FEES_ID = "sqd5";

/** The dimensions to actually ask about, given the service being rated. */
export const sqdApplicable = (service) =>
  service?.has_fees
    ? SQD_QUESTIONS
    : SQD_QUESTIONS.filter((question) => question.id !== SQD_FEES_ID);

/**
 * The full set of nine, with anything that did not apply recorded as N/A.
 * The backend decides this too and does not trust what arrives here, but
 * sending the same thing keeps the payload honest about what was asked.
 */
export const sqdAnswers = (sqd, service) =>
  Object.fromEntries(
    SQD_QUESTIONS.map((question) => [
      question.id,
      question.id === SQD_FEES_ID && !service?.has_fees
        ? "N/A"
        : sqd[question.id] || "",
    ]),
  );

export const COURTESY_TITLES = ["Mr.", "Ms.", "Mrs.", "Dr.", "Engr.", "Atty."];

export const QUARTERS = [
  { value: "1", label: "1st Quarter (January – March)", months: [1, 2, 3] },
  { value: "2", label: "2nd Quarter (April – June)", months: [4, 5, 6] },
  { value: "3", label: "3rd Quarter (July – September)", months: [7, 8, 9] },
  { value: "4", label: "4th Quarter (October – December)", months: [10, 11, 12] },
];

/** UI chrome. Question text itself lives in the constants above. */
export const COPY = {
  formTitle: {
    en: "CHED-OSDS Online Clients/Citizens Satisfaction Survey Form",
    tl: "CHED-OSDS Online na Client/Citizen Satisfaction Survey Form",
  },
  helpUs: {
    en: "HELP US SERVE YOU BETTER!",
    tl: "TULUNGAN MO KAMING MAKAPAGSILBI NANG MAS MAHUSAY!",
  },
  intro: {
    en: "The Client Satisfaction Measurement (CSM) tracks the customer experience of government offices. Your feedback on your recently concluded transaction will help this office provide a better service.",
    tl: "Sinusukat ng Client Satisfaction Measurement (CSM) ang karanasan ng mamamayan sa mga tanggapan ng pamahalaan. Ang iyong puna sa kakatapos mong transaksyon ay makakatulong sa tanggapang ito na magbigay ng mas mahusay na serbisyo.",
  },
  privacy: {
    en: "Personal information shared will be kept confidential and you always have the option to answer this form.",
    tl: "Ang personal na impormasyong ibabahagi ay mananatiling kumpidensyal at nasa iyo pa rin ang pagpili kung sasagutan ang form na ito.",
  },
  ccIntro: {
    en: "The Citizen's Charter is an official document that reflects the services of a government agency/office including its requirements, fees, and processing times, among others.",
    tl: "Ang Citizen's Charter ay isang opisyal na dokumento na naglalaman ng mga serbisyo ng isang ahensya/tanggapan ng pamahalaan kasama ang mga kinakailangan, bayarin, at oras ng pagproseso, bukod sa iba pa.",
  },
  sqdIntro: {
    en: "For SQD 0-8, please select the option that best corresponds to your answer.",
    tl: "Para sa SQD 0-8, piliin ang opsyon na pinakaangkop sa iyong sagot.",
  },
  suggestions: {
    en: "Suggestions on how we can further improve our services (optional):",
    tl: "Mga mungkahi kung paano pa namin mapapabuti ang aming serbisyo (opsyonal):",
  },
};

export const t = (entry, language) =>
  !entry ? "" : language === "tl" ? entry.tl || entry.en : entry.en;
