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
 * `code` is what the CSM Summary Report counts by. The report's region row is
 * generated from this list, so adding a region here flows through to the sheet.
 */
export const REGIONS = [
  { value: "Region NCR", code: "NCR", en: "Region NCR", tl: "Rehiyon NCR" },
  { value: "Region 1", code: "I", en: "Region 1", tl: "Rehiyon 1" },
  { value: "Region 2", code: "II", en: "Region 2", tl: "Rehiyon 2" },
  { value: "Region 3", code: "III", en: "Region 3", tl: "Rehiyon 3" },
  { value: "Region 4", code: "IV-A", en: "Region 4", tl: "Rehiyon 4" },
  { value: "Region 5", code: "V", en: "Region 5", tl: "Rehiyon 5" },
  { value: "Region 6", code: "VI", en: "Region 6", tl: "Rehiyon 6" },
  { value: "Region 7", code: "VII", en: "Region 7", tl: "Rehiyon 7" },
  { value: "Region 8", code: "VIII", en: "Region 8", tl: "Rehiyon 8" },
  { value: "Region 9", code: "IX", en: "Region 9", tl: "Rehiyon 9" },
  { value: "Region 10", code: "X", en: "Region 10", tl: "Rehiyon 10" },
  { value: "Region 11", code: "XI", en: "Region 11", tl: "Rehiyon 11" },
  { value: "Region 12", code: "XII", en: "Region 12", tl: "Rehiyon 12" },
  { value: "Region CAR", code: "CAR", en: "Region CAR", tl: "Rehiyon CAR" },
  {
    value: "Region CARAGA",
    code: "CARAGA",
    en: "Region CARAGA",
    tl: "Rehiyon CARAGA",
  },
  {
    value: "Region MIMAROPA",
    code: "IV-B",
    en: "Region MIMAROPA",
    tl: "Rehiyon MIMAROPA",
  },
  { value: "BARMM", code: "BARMM", en: "BARMM", tl: "BARMM" },
  { value: "NIR", code: "NIR", en: "NIR", tl: "NIR" },
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

/** Citizen's Charter block. Option `value` is the number stored in the sheet. */
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
        en: "I do not know what a CC is and I did not see one in this office. (Answer 'N/A' on CC2 and CC3)",
        tl: "Hindi ko alam kung ano ang CC at wala akong nakita sa napuntahang opisina. (Sagutan ng 'N/A' ang CC2 at CC3)",
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
      { value: "N/A", en: "N/A", tl: "N/A" },
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
      { value: "N/A", en: "N/A", tl: "N/A" },
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
  { value: "N/A", emoji: "—", en: "N/A", tl: "N/A" },
];

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
