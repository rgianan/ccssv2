import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  CalendarCheck,
  ClipboardCheck,
  FileSignature,
  GraduationCap,
  Languages,
  Lock,
  Plane,
  ShieldCheck,
  Stethoscope,
  Timer,
} from "lucide-react";
import { Brand, LanguageToggle } from "./shared";
import { COPY, DEFAULT_SERVICES, SQD_SCALE, t } from "../lib/csm";
import { getPortalConfig } from "../lib/api";
import { navigate } from "../router";

const PROGRAM_ICONS = [Stethoscope, GraduationCap, ClipboardCheck, Plane];

/** lucide dropped its brand icons, so the Facebook mark is inlined. */
function FacebookMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="17" height="17" aria-hidden="true">
      <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.51 1.49-3.9 3.77-3.9 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.88h2.78l-.45 2.9h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94Z" />
    </svg>
  );
}

/** Written for the client filling the form, not for the office reading the
 *  report — no internal shorthand, no form-numbering, nothing to look up. */
const HOW_IT_WORKS = [
  {
    icon: FileSignature,
    en: {
      title: "Ask for your Certificate of Appearance",
      body: "The first question asks if you need one. Say yes, give us a few details, and we will prepare it for you.",
    },
    tl: {
      title: "Humingi ng Certificate of Appearance",
      body: "Ang unang tanong ay kung kailangan mo nito. Sagutin ng oo, magbigay ng ilang detalye, at ihahanda namin ito para sa iyo.",
    },
  },
  {
    icon: ClipboardCheck,
    en: {
      title: "Tell us why you came",
      body: "A few quick details about you and the service you came here for.",
    },
    tl: {
      title: "Sabihin kung bakit ka pumunta",
      body: "Ilang mabilis na detalye tungkol sa iyo at sa serbisyong iyong pinuntahan.",
    },
  },
  {
    icon: BadgeCheck,
    en: {
      title: "Tell us how we did",
      body: "Short questions about your visit — how long it took, how you were treated, and whether you got what you needed. In English or Tagalog.",
    },
    tl: {
      title: "Sabihin kung kumusta ang serbisyo",
      body: "Maiikling tanong tungkol sa iyong pagpunta — gaano ito katagal, kung paano ka trinato, at kung nakuha mo ang kailangan mo. Sa Ingles o Tagalog.",
    },
  },
  {
    icon: CalendarCheck,
    en: {
      title: "We use your answers",
      body: "Your feedback shows us what to fix, and goes into the report we submit on how well this office serves the public.",
    },
    tl: {
      title: "Ginagamit namin ang iyong sagot",
      body: "Ipinapakita ng iyong puna kung ano ang dapat naming ayusin, at kasama ito sa ulat namin kung gaano kami kahusay maglingkod sa publiko.",
    },
  },
];

function Header({ language, setLanguage }) {
  return (
    <header className="landing-nav">
      <Brand />
      <nav>
        <a href="#programs">{language === "tl" ? "Mga Serbisyo" : "Services"}</a>
        <a href="#how">{language === "tl" ? "Paano Ito Gumagana" : "How it works"}</a>
        <a
          href="/verification"
          onClick={(event) => {
            event.preventDefault();
            navigate("/verification");
          }}
        >
          {language === "tl" ? "Beripikahin" : "Verify"}
        </a>
      </nav>
      <div className="landing-nav-actions">
        <LanguageToggle language={language} onChange={setLanguage} />
        <button
          className="button primary"
          onClick={() => navigate("/survey")}
          title="Open the Client Satisfaction Measurement form"
        >
          {language === "tl" ? "Sagutan ang Survey" : "Answer the survey"}
          <ArrowRight size={17} />
        </button>
      </div>
    </header>
  );
}

export function LandingPage() {
  const [language, setLanguage] = useState("en");
  const [services, setServices] = useState([]);
  useEffect(() => {
    getPortalConfig()
      .then((config) =>
        setServices(
          (config.services || []).filter(
            (service) => service.category === "main" && service.active !== false,
          ),
        ),
      )
      .catch(() => setServices([]));
  }, []);
  // Falls back to the four seeded programs so the marketing page still renders
  // if the backend is unreachable.
  const programs = services.length
    ? services
    : DEFAULT_SERVICES.map((service, index) => ({
        ...service,
        service_id: `seed-${index}`,
      }));

  return (
    <div className="landing">
      <Header language={language} setLanguage={setLanguage} />

      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <ShieldCheck size={15} /> Republic of the Philippines · Commission on
            Higher Education
          </p>
          <h1>
            {language === "tl" ? (
              <>
                Sabihin mo kung paano ka
                <br />
                <em>namin napaglingkuran.</em>
              </>
            ) : (
              <>
                Tell us how the
                <br />
                <em>OSDS served you.</em>
              </>
            )}
          </h1>
          <p className="hero-lead">{t(COPY.intro, language)}</p>
          <div className="hero-actions">
            <button
              className="button primary large"
              onClick={() => navigate("/survey")}
              title="Start the Client Satisfaction Measurement survey"
            >
              {language === "tl" ? "Simulan ang Survey" : "Start the survey"}
              <ArrowRight size={18} />
            </button>
            <button
              className="button outline large"
              onClick={() => navigate("/verification")}
              title="Verify an issued Certificate of Appearance"
            >
              <BadgeCheck size={18} />
              {language === "tl"
                ? "Beripikahin ang Sertipiko"
                : "Verify a certificate"}
            </button>
          </div>
          <ul className="hero-trust">
            <li>
              <Timer size={15} />
              {language === "tl" ? "3–5 minuto" : "3–5 minutes"}
            </li>
            <li>
              <Languages size={15} />
              {language === "tl" ? "Ingles at Tagalog" : "English and Tagalog"}
            </li>
            <li>
              <Lock size={15} />
              {language === "tl" ? "Kumpidensyal" : "Kept confidential"}
            </li>
          </ul>
        </div>

        <aside className="hero-card" aria-hidden="true">
          <div className="hero-card-head">
            <span className="eyebrow">SQD0</span>
            <strong>{t(COPY.helpUs, language)}</strong>
          </div>
          <p className="hero-card-question">
            {language === "tl"
              ? "Nasiyahan ako sa serbisyo na aking natanggap sa napuntahang tanggapan."
              : "I am satisfied with the service that I availed."}
          </p>
          <div className="hero-scale">
            {SQD_SCALE.filter((option) => option.value !== "N/A").map(
              (option, index) => (
                <div
                  key={option.value}
                  className={`hero-scale-option${index === 4 ? " picked" : ""}`}
                >
                  <span>{option.emoji}</span>
                  <small>{t(option, language)}</small>
                </div>
              ),
            )}
          </div>
          <div className="hero-card-foot">
            <BadgeCheck size={16} />
            {language === "tl"
              ? "Naitala ang iyong sagot"
              : "Your response is recorded"}
          </div>
        </aside>
      </section>

      <section className="section" id="programs">
        <div className="section-head">
          <p className="eyebrow">
            {language === "tl" ? "Sakop ng Survey" : "Covered by the survey"}
          </p>
          <h2>
            {language === "tl"
              ? "Mga pangunahing serbisyo ng OSDS"
              : "The OSDS main programs"}
          </h2>
          <p>
            {language === "tl"
              ? "Sinusukat ang bawat programa nang hiwalay sa CSM Summary Report. Ang ibang transaksyon ay nakalista sa ilalim ng Other Services."
              : "Each program is measured separately in the CSM Summary Report. Anything else is recorded under Other Services."}
          </p>
        </div>
        <div className="program-grid">
          {programs.map((program, index) => {
            const Icon = PROGRAM_ICONS[index % PROGRAM_ICONS.length];
            return (
              <article key={program.service_id || program.code}>
                <i>
                  <Icon />
                </i>
                <span className="program-code">{program.code}</span>
                <h3>
                  {language === "tl" && program.name_tl
                    ? program.name_tl
                    : program.name_en}
                </h3>
              </article>
            );
          })}
          <article className="program-other">
            <i>
              <ClipboardCheck />
            </i>
            <span className="program-code">OTHER</span>
            <h3>
              {language === "tl"
                ? "Iba pang serbisyo — isulat ang transaksyon sa form."
                : "Other services — name your transaction in the form."}
            </h3>
          </article>
        </div>
      </section>

      <section className="section alt" id="how">
        <div className="section-head">
          <p className="eyebrow">
            {language === "tl" ? "Paano ito gumagana" : "How it works"}
          </p>
          <h2>
            {language === "tl"
              ? "Apat na hakbang, isang upuan"
              : "Four steps, one sitting"}
          </h2>
        </div>
        <ol className="steps">
          {HOW_IT_WORKS.map((step, index) => {
            const Icon = step.icon;
            const copy = language === "tl" ? step.tl : step.en;
            return (
              <li key={copy.title}>
                <i>
                  <Icon />
                </i>
                <span className="step-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3>{copy.title}</h3>
                <p>{copy.body}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="coa-callout">
        <div>
          <p className="eyebrow">
            <FileSignature size={15} /> Certificate of Appearance
          </p>
          <h2>
            {language === "tl"
              ? "Kailangan mo ng patunay ng pagpunta?"
              : "Need proof that you appeared?"}
          </h2>
          <p>
            {language === "tl"
              ? "Piliin ang oo sa unang tanong ng survey. Ihahanda ng OSDS ang iyong Certificate of Appearance at ipapadala ang link sa iyong email."
              : "Choose yes on the survey's first question. OSDS prepares your Certificate of Appearance and emails you the link once it is signed and released."}
          </p>
          <button
            className="button primary large"
            onClick={() => navigate("/survey")}
            title="Start the survey and request a Certificate of Appearance"
          >
            {language === "tl"
              ? "Humiling sa pamamagitan ng survey"
              : "Request it through the survey"}
            <ArrowRight size={18} />
          </button>
        </div>
        <figure className="coa-preview" aria-hidden="true">
          <header>CERTIFICATE OF APPEARANCE</header>
          <p>
            This is to certify that <b>Ms. Juana Dela Cruz</b>, of the{" "}
            <b>Pamantasan ng Lungsod ng Maynila</b>, appeared at the Office of
            Student Development and Services (OSDS) for the purpose of{" "}
            <b>SIAP Phase 2 application</b> on August 8, 2026.
          </p>
          <footer>
            <span />
            <small>Signatory · Designation</small>
          </footer>
        </figure>
      </section>

      <footer className="landing-footer">
        <Brand
          light
          name="Commission on Higher Education"
          subtitle="Office of Student Development and Services"
        />
        {/* Most clients reach this on a phone, so the numbers dial directly. */}
        <div className="footer-contact">
          <span>{language === "tl" ? "Tumawag sa amin:" : "Contact us:"}</span>
          <a href="tel:+63284411220">(02)8441-1220</a>
          <a href="tel:+63289880001">(02)8988-0001</a>
        </div>
        <a
          className="footer-social"
          href="https://fb.com/osds.chedco"
          target="_blank"
          rel="noreferrer noopener"
          title="Open the OSDS page on Facebook"
        >
          <FacebookMark />
          {language === "tl"
            ? "Sundan ang OSDS sa Facebook"
            : "Follow OSDS on Facebook"}
        </a>
      </footer>
    </div>
  );
}
