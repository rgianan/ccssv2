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

const HOW_IT_WORKS = [
  {
    icon: FileSignature,
    en: {
      title: "Request a Certificate of Appearance",
      body: "The very first question asks whether you need a Certificate of Appearance. Choose yes and we collect the few details needed to issue it.",
    },
    tl: {
      title: "Humiling ng Certificate of Appearance",
      body: "Ang unang tanong ay kung kailangan mo ng Certificate of Appearance. Piliin ang oo at kukunin namin ang ilang detalyeng kailangan para maibigay ito.",
    },
  },
  {
    icon: ClipboardCheck,
    en: {
      title: "Tell us about your transaction",
      body: "Client type, date, sex, age, region, and the OSDS service you availed of.",
    },
    tl: {
      title: "Ibahagi ang tungkol sa iyong transaksyon",
      body: "Uri ng kliyente, petsa, kasarian, edad, rehiyon, at ang serbisyong OSDS na iyong nakuha.",
    },
  },
  {
    icon: BadgeCheck,
    en: {
      title: "Rate the service",
      body: "Three Citizen's Charter questions and the nine Service Quality Dimensions, in English or Tagalog.",
    },
    tl: {
      title: "Iratings ang serbisyo",
      body: "Tatlong tanong tungkol sa Citizen's Charter at ang siyam na Service Quality Dimensions, sa Ingles o Tagalog.",
    },
  },
  {
    icon: CalendarCheck,
    en: {
      title: "We act on it",
      body: "Responses roll up into the quarterly and annual CSM Summary Report submitted by this office.",
    },
    tl: {
      title: "Aaksyunan namin ito",
      body: "Ang mga sagot ay pinagsasama sa quarterly at annual na CSM Summary Report na isinusumite ng tanggapang ito.",
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

      <section className="metric-band">
        {[
          [
            programs.length,
            language === "tl" ? "Pangunahing programa" : "Main programs",
          ],
          ["9", language === "tl" ? "Service Quality Dimensions" : "Service Quality Dimensions"],
          ["3", language === "tl" ? "Tanong sa Citizen's Charter" : "Citizen's Charter questions"],
          ["2", language === "tl" ? "Wika" : "Languages"],
        ].map(([value, label]) => (
          <article key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </article>
        ))}
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
            <small>Signatory · Designation · OSDS</small>
          </footer>
        </figure>
      </section>

      <footer className="landing-footer">
        <Brand light subtitle="Office of Student Development and Services" />
        <p>
          {language === "tl"
            ? "Ang datos na nakalap dito ay ginagamit lamang para sa Client Satisfaction Measurement at para sa mga hinihiling na Certificate of Appearance."
            : "Data collected here is used only for Client Satisfaction Measurement and for requested Certificates of Appearance."}
        </p>
        <div className="landing-footer-links">
          <a
            href="/survey"
            onClick={(event) => {
              event.preventDefault();
              navigate("/survey");
            }}
          >
            {language === "tl" ? "Survey" : "Survey"}
          </a>
          <a
            href="/verification"
            onClick={(event) => {
              event.preventDefault();
              navigate("/verification");
            }}
          >
            {language === "tl" ? "Beripikasyon" : "Verification"}
          </a>
          <a
            href="/admin"
            onClick={(event) => {
              event.preventDefault();
              navigate("/admin");
            }}
          >
            {language === "tl" ? "Admin" : "Admin"}
          </a>
        </div>
      </footer>
    </div>
  );
}
