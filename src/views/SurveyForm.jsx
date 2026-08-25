import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  FileSignature,
  Info,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  CC_UNAWARE_VALUE,
  CLIENT_TYPES,
  COPY,
  COURTESY_TITLES,
  OTHER_SERVICE_CODE,
  REGIONS,
  SEXES,
  SQD_SCALE,
  ccAnswers,
  ccApplicable,
  portalToday,
  sqdAnswers,
  sqdApplicable,
  t,
} from "../lib/csm";
import { getPortalConfig, submitResponse } from "../lib/api";
import { Bilingual, Brand, LanguageToggle, TurnstileWidget } from "./shared";
import { navigate } from "../router";

/**
 * A change detector, not a security control. Two attempts carrying the same
 * answers must produce the same id so a retry is recognised as the duplicate
 * it is — while an answer corrected after a failed attempt must produce a
 * different one, so the correction is stored rather than silently dropped in
 * favour of the version that landed first.
 */
const fingerprint = (value) => {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index++)
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
};

const newSubmissionId = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * A fresh form carries a fresh submission id, sent with the response and held
 * steady across every retry of that response. A submission that reached the
 * sheet before the network gave up is then recognised rather than written
 * twice — the client retries on timeouts, and Apps Script is slow enough under
 * load for that to happen.
 */
const createEmptyForm = () => ({
  submissionId: newSubmissionId(),
  wantsCoa: "",
  coaTitle: "Mr.",
  coaName: "",
  coaAgency: "",
  coaPurpose: "",
  coaDateFrom: portalToday(),
  coaDateTo: "",
  email: "",
  clientType: "",
  transactionDate: portalToday(),
  sex: "",
  age: "",
  region: "",
  serviceId: "",
  otherService: "",
  suggestions: "",
  website: "",
});

const STEPS = [
  { en: "Certificate of Appearance", tl: "Certificate of Appearance" },
  { en: "Client information", tl: "Impormasyon ng kliyente" },
  { en: "Citizen's Charter", tl: "Citizen's Charter" },
  { en: "Service Quality Dimensions", tl: "Service Quality Dimensions" },
  { en: "Suggestions", tl: "Mga mungkahi" },
];

function ChoiceGroup({ name, options, value, onChange, language, columns = 1 }) {
  return (
    <div className={`choice-group cols-${columns}`} role="radiogroup">
      {options.map((option) => (
        <label
          key={option.value}
          className={`choice${value === option.value ? " selected" : ""}`}
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="choice-dot" aria-hidden="true" />
          <Bilingual entry={option} language={language} />
        </label>
      ))}
    </div>
  );
}

function SqdRating({ question, value, onChange, language }) {
  return (
    <fieldset className="sqd-item">
      <legend>
        <span className="sqd-number">{question.number}</span>
        <Bilingual entry={question} language={language} />
      </legend>
      <div className="sqd-scale">
        {SQD_SCALE.map((option) => (
          <button
            key={option.value}
            type="button"
            className={value === option.value ? "selected" : ""}
            onClick={() => onChange(option.value)}
            aria-label={`${question.number}: ${t(option, language)}`}
            title={t(option, language)}
          >
            <span className="sqd-emoji" aria-hidden="true">
              {option.emoji}
            </span>
            <small>{t(option, language)}</small>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function SurveyForm() {
  const [language, setLanguage] = useState("en"),
    [step, setStep] = useState(0),
    [form, setForm] = useState(createEmptyForm),
    [services, setServices] = useState([]),
    [cc, setCc] = useState({}),
    [sqd, setSqd] = useState({}),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(null),
    [error, setError] = useState(""),
    [turnstileToken, setTurnstileToken] = useState(""),
    [turnstileReset, setTurnstileReset] = useState(0);

  const loadServices = () =>
    getPortalConfig().then((config) => {
      const list = (config.services || []).filter((s) => s.active !== false);
      setServices(list);
      return list;
    });

  useEffect(() => {
    loadServices().catch((loadError) =>
      setError(loadError.message || "Unable to load the survey."),
    );
  }, []);

  const update = (key, value) => setForm((f) => ({ ...f, [key]: value }));
  const selectedService = services.find((s) => s.service_id === form.serviceId);
  const isOtherService = selectedService?.code === OTHER_SERVICE_CODE;
  const wantsCoa = form.wantsCoa === "yes";

  const serviceOptions = useMemo(
    () =>
      services.map((service) => ({
        value: service.service_id,
        en: service.name_en,
        tl: service.name_tl || service.name_en,
      })),
    [services],
  );

  const valid = useMemo(() => {
    if (step === 0)
      return (
        form.wantsCoa === "no" ||
        (wantsCoa &&
          form.coaName.trim() &&
          form.coaAgency.trim() &&
          form.coaPurpose.trim() &&
          form.coaDateFrom)
      );
    if (step === 1)
      return (
        /^\S+@\S+\.\S+$/.test(form.email) &&
        form.clientType &&
        form.transactionDate &&
        form.region &&
        form.serviceId &&
        (!isOtherService || form.otherService.trim()) &&
        (!form.age || (Number(form.age) >= 1 && Number(form.age) <= 120))
      );
    if (step === 2) return ccApplicable(cc).every((question) => cc[question.id]);
    if (step === 3)
      return sqdApplicable(selectedService).every((question) => sqd[question.id]);
    return true;
    // selectedService matters here: which SQD questions are required depends
    // on it, and it resolves only once the service list has loaded.
  }, [step, form, cc, sqd, wantsCoa, isOtherService, selectedService]);

  // Two clicks landing in the same tick share one render's closure, so both
  // would advance. Comparing against the step the click was made on makes the
  // second a no-op, instead of skipping a step and the validation with it.
  const advance = (delta) => setStep((s) => (s === step ? s + delta : s));

  // The submit path needs a ref rather than `busy` for the same reason: both
  // clicks read the pre-render value of the state flag.
  const submitting = useRef(false);

  async function next() {
    setError("");
    if (!valid)
      return setError(
        language === "tl"
          ? "Pakikumpleto ang lahat ng kinakailangang sagot bago magpatuloy."
          : "Please complete every required answer before continuing.",
      );
    if (step < STEPS.length - 1) {
      advance(1);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (!turnstileToken)
      return setError(
        language === "tl"
          ? "Kumpletuhin ang security verification bago magsumite."
          : "Please complete the security verification before submitting.",
      );
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      // The id sent to the backend combines the form's id with a fingerprint
      // of the answers, so a plain retry dedupes while an edited resubmission
      // is stored as the correction it is.
      const { submissionId, ...answers } = {
        ...form,
        language,
        serviceCode: selectedService?.code || "",
        serviceName: selectedService?.name_en || "",
        ...ccAnswers(cc),
        ...sqdAnswers(sqd, selectedService),
      };
      const result = await submitResponse(
        { ...answers, submissionId: `${submissionId}-${fingerprint(answers)}` },
        turnstileToken,
      );
      if (result.status === "BAD_REQUEST") {
        // The office marked this service as charging a fee while the form was
        // open, so SQD5 is now required but was never rendered. Telling the
        // client to rate a fee they cannot see would strand them — every
        // further Submit repeats the same refusal. Fetch the service list
        // again and take them back to the question instead.
        if (result.code === "SQD5_REQUIRED") {
          await loadServices().catch(() => {});
          setSqd((state) => ({ ...state, sqd5: "" }));
          setStep(3);
          setTurnstileToken("");
          setTurnstileReset((value) => value + 1);
          window.scrollTo({ top: 0 });
          return setError(
            language === "tl"
              ? "May bagong tanong tungkol sa bayarin para sa serbisyong ito. Pakisagutan ito bago magsumite."
              : "This service now asks about fees. Please answer the added question, then submit again.",
          );
        }
        throw new Error(result.message || "Please check your answers.");
      }
      setDone(result);
      window.scrollTo({ top: 0 });
    } catch (submitError) {
      setError(submitError.message);
      setTurnstileToken("");
      setTurnstileReset((value) => value + 1);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (done)
    return (
      <main className="success-page">
        <div className="success-card">
          <div className="success-icon">
            <Check />
          </div>
          <p className="eyebrow">
            {language === "tl" ? "Natanggap ang sagot" : "Response received"}
          </p>
          <h1>{language === "tl" ? "Maraming salamat!" : "Thank you!"}</h1>
          <p>
            {language === "tl"
              ? "Naitala na ang iyong sagot sa Client Satisfaction Measurement ng OSDS."
              : "Your Client Satisfaction Measurement response has been recorded by the OSDS."}
          </p>
          {done.referenceId && (
            <p className="reference-id">
              {language === "tl" ? "Reference" : "Reference"}:{" "}
              <b>{done.referenceId}</b>
            </p>
          )}
          {done.coaRequested && (
            <div className="success-coa">
              <FileSignature />
              <div>
                <strong>
                  {language === "tl"
                    ? "Naitala ang hiling mong Certificate of Appearance."
                    : "Your Certificate of Appearance request is queued."}
                </strong>
                <span>
                  {language === "tl"
                    ? `Ipapadala ng OSDS ang link sa ${form.email} kapag nalagdaan na ito.`
                    : `OSDS will email the signed certificate link to ${form.email}.`}
                </span>
              </div>
            </div>
          )}
          <div className="success-actions">
            <button
              className="button secondary"
              onClick={() => navigate("/")}
              title="Return to the portal home page"
            >
              {language === "tl" ? "Bumalik sa Home" : "Back to home"}
            </button>
            <button
              className="button ghost"
              title="Submit another response"
              onClick={() => {
                setDone(null);
                setStep(0);
                setForm(createEmptyForm());
                setCc({});
                setSqd({});
                setTurnstileToken("");
                setTurnstileReset((value) => value + 1);
              }}
            >
              {language === "tl" ? "Magsumite ulit" : "Submit another response"}
            </button>
          </div>
        </div>
      </main>
    );

  return (
    <div className="survey-page">
      <header className="topbar">
        <Brand />
        <div className="topbar-actions">
          <LanguageToggle language={language} onChange={setLanguage} />
          <a
            className="topbar-link"
            href="/verification"
            onClick={(event) => {
              event.preventDefault();
              navigate("/verification");
            }}
            title="Verify an issued Certificate of Appearance"
          >
            <BadgeCheck size={17} />
            {language === "tl" ? "Beripikahin" : "Verify"}
          </a>
        </div>
      </header>

      <main className="survey-shell">
        <section className="survey-intro">
          <p className="eyebrow">
            <Sparkles size={15} /> {t(COPY.helpUs, language)}
          </p>
          <h1>{t(COPY.formTitle, language)}</h1>
          <p>{t(COPY.intro, language)}</p>
          <div className="privacy-note">
            <ShieldCheck />
            <div>
              <strong>{t(COPY.privacy, language)}</strong>
              <span>
                {language === "tl"
                  ? "Tumatagal ito ng humigit-kumulang 3–5 minuto."
                  : "It takes about 3–5 minutes to complete."}
              </span>
            </div>
          </div>
        </section>

        <section className="survey-card">
          <div className="step-header">
            <span>
              {language === "tl" ? "Hakbang" : "Step"} {step + 1}{" "}
              {language === "tl" ? "ng" : "of"} {STEPS.length}
            </span>
            <strong>{t(STEPS[step], language)}</strong>
          </div>
          <div className="progress">
            <i style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
          </div>

          <div className="form-body">
            {step === 0 && (
              <>
                <div className="section-heading">
                  <span>01</span>
                  <div>
                    <h2>
                      {language === "tl"
                        ? "Kailangan mo ba ng Certificate of Appearance?"
                        : "Do you need a Certificate of Appearance?"}
                    </h2>
                    <p>
                      {language === "tl"
                        ? "Ito ang unang tanong upang malaman namin agad kung maghahanda kami ng sertipiko para sa iyo."
                        : "We ask this first so the office knows right away whether to prepare a certificate for you."}
                    </p>
                  </div>
                </div>
                <label className="honeypot" aria-hidden="true">
                  Website
                  <input
                    tabIndex="-1"
                    autoComplete="off"
                    value={form.website}
                    onChange={(event) => update("website", event.target.value)}
                  />
                </label>
                <ChoiceGroup
                  name="wantsCoa"
                  value={form.wantsCoa}
                  onChange={(value) => update("wantsCoa", value)}
                  language={language}
                  columns={2}
                  options={[
                    {
                      value: "yes",
                      en: "Yes, please issue a Certificate of Appearance.",
                      tl: "Oo, mangyaring maglabas ng Certificate of Appearance.",
                    },
                    {
                      value: "no",
                      en: "No, I only want to answer the survey.",
                      tl: "Hindi, gusto ko lang sagutan ang survey.",
                    },
                  ]}
                />
                {wantsCoa && (
                  <div className="coa-fields">
                    <div className="notice">
                      <Info size={15} />
                      {language === "tl"
                        ? "Ang mga detalyeng ito ang lalabas sa sertipiko. Pakisuri bago magpatuloy."
                        : "These details are printed on the certificate. Please check them before continuing."}
                    </div>
                    <div className="field-grid narrow">
                      <label>
                        {language === "tl" ? "Titulo" : "Title"}
                        <div className="select-wrap">
                          <select
                            value={form.coaTitle}
                            onChange={(event) =>
                              update("coaTitle", event.target.value)
                            }
                          >
                            {COURTESY_TITLES.map((title) => (
                              <option key={title}>{title}</option>
                            ))}
                          </select>
                          <ChevronDown />
                        </div>
                      </label>
                      <label className="span-2">
                        {language === "tl"
                          ? "Buong pangalan ng kliyente"
                          : "Full name of client"}{" "}
                        <b>*</b>
                        <input
                          value={form.coaName}
                          onChange={(event) =>
                            update("coaName", event.target.value)
                          }
                          placeholder="Juana Dela Cruz"
                          autoComplete="name"
                        />
                      </label>
                    </div>
                    <label>
                      {language === "tl"
                        ? "Ahensya / paaralan / kompanya"
                        : "Agency / school / company"}{" "}
                      <b>*</b>
                      <input
                        value={form.coaAgency}
                        onChange={(event) =>
                          update("coaAgency", event.target.value)
                        }
                        placeholder="Pamantasan ng Lungsod ng Maynila"
                      />
                    </label>
                    <label>
                      {language === "tl"
                        ? "Layunin ng pagpunta"
                        : "Purpose of appearance"}{" "}
                      <b>*</b>
                      <input
                        value={form.coaPurpose}
                        onChange={(event) =>
                          update("coaPurpose", event.target.value)
                        }
                        placeholder={
                          language === "tl"
                            ? "pagsusumite ng aplikasyon sa SIAP Phase 2"
                            : "submitting a SIAP Phase 2 application"
                        }
                      />
                      <small>
                        {language === "tl"
                          ? 'Isulat ito bilang pandugtong ng pangungusap: "…para sa layunin ng ___."'
                          : 'Write it so it completes the sentence "…for the purpose of ___."'}
                      </small>
                    </label>
                    <div className="field-grid">
                      <label>
                        {language === "tl"
                          ? "Petsa ng pagpunta"
                          : "Date of appearance"}{" "}
                        <b>*</b>
                        <input
                          type="date"
                          value={form.coaDateFrom}
                          onChange={(event) =>
                            update("coaDateFrom", event.target.value)
                          }
                        />
                      </label>
                      <label>
                        {language === "tl"
                          ? "Hanggang (opsyonal)"
                          : "Until (optional)"}
                        <input
                          type="date"
                          min={form.coaDateFrom}
                          value={form.coaDateTo}
                          onChange={(event) =>
                            update("coaDateTo", event.target.value)
                          }
                        />
                        <small>
                          {language === "tl"
                            ? "Punan lamang kung tumagal nang higit sa isang araw."
                            : "Fill this only if your visit covered more than one day."}
                        </small>
                      </label>
                    </div>
                  </div>
                )}
              </>
            )}

            {step === 1 && (
              <>
                <div className="section-heading">
                  <span>02</span>
                  <div>
                    <h2>
                      {language === "tl"
                        ? "Tungkol sa iyong transaksyon"
                        : "About your transaction"}
                    </h2>
                    <p>{t(COPY.privacy, language)}</p>
                  </div>
                </div>
                <label>
                  {language === "tl" ? "Email" : "Email"} <b>*</b>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(event) => update("email", event.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                  />
                </label>
                <fieldset className="field-block">
                  <legend>
                    {language === "tl" ? "Uri ng kliyente" : "Client type"}{" "}
                    <b>*</b>
                  </legend>
                  <ChoiceGroup
                    name="clientType"
                    value={form.clientType}
                    onChange={(value) => update("clientType", value)}
                    language={language}
                    columns={3}
                    options={CLIENT_TYPES}
                  />
                </fieldset>
                <div className="field-grid">
                  <label>
                    {language === "tl"
                      ? "Petsa ng transaksyon"
                      : "Date of transaction"}{" "}
                    <b>*</b>
                    <input
                      type="date"
                      value={form.transactionDate}
                      onChange={(event) =>
                        update("transactionDate", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    {language === "tl" ? "Edad" : "Age"}
                    <input
                      type="number"
                      min="1"
                      max="120"
                      value={form.age}
                      onChange={(event) => update("age", event.target.value)}
                      placeholder={language === "tl" ? "Edad" : "Age"}
                    />
                  </label>
                </div>
                <fieldset className="field-block">
                  <legend>{language === "tl" ? "Kasarian" : "Sex"}</legend>
                  <ChoiceGroup
                    name="sex"
                    value={form.sex}
                    onChange={(value) => update("sex", value)}
                    language={language}
                    columns={2}
                    options={SEXES}
                  />
                </fieldset>
                <label>
                  {language === "tl"
                    ? "Rehiyon ng tirahan"
                    : "Region of residence"}{" "}
                  <b>*</b>
                  <div className="select-wrap">
                    <select
                      value={form.region}
                      onChange={(event) => update("region", event.target.value)}
                    >
                      <option value="">
                        {language === "tl" ? "Pumili" : "Select"}
                      </option>
                      {REGIONS.map((region) => (
                        <option key={region.value} value={region.value}>
                          {t(region, language)}
                        </option>
                      ))}
                    </select>
                    <ChevronDown />
                  </div>
                </label>
                <fieldset className="field-block">
                  <legend>
                    {language === "tl" ? "Serbisyong nakuha" : "Service availed"}{" "}
                    <b>*</b>
                  </legend>
                  <ChoiceGroup
                    name="serviceId"
                    value={form.serviceId}
                    onChange={(value) => update("serviceId", value)}
                    language={language}
                    options={serviceOptions}
                  />
                  {isOtherService && (
                    <label className="other-service">
                      {language === "tl"
                        ? "Pakisulat ang serbisyong nakuha"
                        : "Please specify the service you availed"}{" "}
                      <b>*</b>
                      <input
                        value={form.otherService}
                        onChange={(event) =>
                          update("otherService", event.target.value)
                        }
                        placeholder={
                          language === "tl"
                            ? "hal. pagtatanong tungkol sa Undergraduate Scholarships"
                            : "e.g. inquiries regarding Undergraduate Scholarships"
                        }
                      />
                    </label>
                  )}
                </fieldset>
              </>
            )}

            {step === 2 && (
              <>
                <div className="section-heading">
                  <span>03</span>
                  <div>
                    <h2>
                      {language === "tl"
                        ? "Mga tanong tungkol sa Citizen's Charter (CC)"
                        : "Citizen's Charter (CC) questions"}
                    </h2>
                    <p>{t(COPY.ccIntro, language)}</p>
                  </div>
                </div>
                {ccApplicable(cc).map((question) => (
                  <fieldset className="field-block" key={question.id}>
                    <legend>
                      <span className="sqd-number">{question.number}</span>
                      <Bilingual entry={question} language={language} /> <b>*</b>
                    </legend>
                    <ChoiceGroup
                      name={question.id}
                      value={cc[question.id]}
                      onChange={(value) =>
                        setCc((state) => ({ ...state, [question.id]: value }))
                      }
                      language={language}
                      options={question.options}
                    />
                  </fieldset>
                ))}
                {cc.cc1 === CC_UNAWARE_VALUE && (
                  <div className="notice">
                    <Info size={15} />
                    {language === "tl"
                      ? "Salamat — ang natitirang tanong tungkol sa Citizen's Charter ay hindi na kailangang sagutan. Magpatuloy sa susunod na bahagi."
                      : "Thanks — the remaining Citizen's Charter questions do not apply to you. Continue to the next section."}
                  </div>
                )}
              </>
            )}

            {step === 3 && (
              <>
                <div className="section-heading">
                  <span>04</span>
                  <div>
                    <h2>
                      {language === "tl"
                        ? "Mga Sukatan ng Kalidad ng Serbisyo (SQD)"
                        : "Service Quality Dimensions (SQD)"}
                    </h2>
                    <p>{t(COPY.sqdIntro, language)}</p>
                  </div>
                </div>
                <div className="scale-legend">
                  {SQD_SCALE.map((option) => (
                    <span key={option.value}>
                      <b aria-hidden="true">{option.emoji}</b>
                      {t(option, language)}
                    </span>
                  ))}
                </div>
                {!selectedService?.has_fees && (
                  <div className="notice">
                    <Info size={15} />
                    {language === "tl"
                      ? "Walang bayad ang serbisyong ito, kaya hindi na kasama ang tanong tungkol sa bayarin."
                      : "This service carries no fee, so the question about fees is not asked."}
                  </div>
                )}
                {sqdApplicable(selectedService).map((question) => (
                  <SqdRating
                    key={question.id}
                    question={question}
                    language={language}
                    value={sqd[question.id]}
                    onChange={(value) =>
                      setSqd((state) => ({ ...state, [question.id]: value }))
                    }
                  />
                ))}
              </>
            )}

            {step === 4 && (
              <>
                <div className="section-heading">
                  <span>05</span>
                  <div>
                    <h2>{language === "tl" ? "Mga mungkahi" : "Suggestions"}</h2>
                    <p>
                      {language === "tl"
                        ? "Suriin ang buod, pagkatapos ay isumite ang iyong sagot."
                        : "Review the summary, then submit your response."}
                    </p>
                  </div>
                </div>
                <label>
                  {t(COPY.suggestions, language)}
                  <textarea
                    value={form.suggestions}
                    onChange={(event) =>
                      update("suggestions", event.target.value)
                    }
                    maxLength={1500}
                    placeholder={
                      language === "tl"
                        ? "Ang iyong mungkahi ay malugod naming tinatanggap…"
                        : "Your suggestions are welcome…"
                    }
                  />
                </label>
                <div className="review-summary">
                  <h3>{language === "tl" ? "Buod" : "Summary"}</h3>
                  <dl>
                    <div>
                      <dt>
                        {language === "tl" ? "Serbisyo" : "Service availed"}
                      </dt>
                      <dd>
                        {isOtherService
                          ? `${form.otherService || "—"} (Other Services)`
                          : selectedService?.name_en || "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>{language === "tl" ? "Email" : "Email"}</dt>
                      <dd>{form.email || "—"}</dd>
                    </div>
                    <div>
                      <dt>
                        {language === "tl"
                          ? "Certificate of Appearance"
                          : "Certificate of Appearance"}
                      </dt>
                      <dd>
                        {wantsCoa
                          ? `${language === "tl" ? "Hiniling" : "Requested"} — ${form.coaTitle} ${form.coaName}`
                          : language === "tl"
                            ? "Hindi hiniling"
                            : "Not requested"}
                      </dd>
                    </div>
                  </dl>
                </div>
                <TurnstileWidget
                  action="client_submit"
                  onToken={setTurnstileToken}
                  resetKey={turnstileReset}
                />
              </>
            )}

            {error && <div className="alert">{error}</div>}
          </div>

          <footer className="form-footer">
            <button
              className="button ghost"
              disabled={step === 0}
              onClick={() => advance(-1)}
              title="Return to the previous step"
            >
              <ArrowLeft size={18} /> {language === "tl" ? "Bumalik" : "Back"}
            </button>
            <button
              className="button primary"
              disabled={busy || (step === STEPS.length - 1 && !turnstileToken)}
              onClick={next}
              title={
                step === STEPS.length - 1
                  ? "Submit your Client Satisfaction Measurement response"
                  : "Continue to the next step"
              }
            >
              {busy
                ? language === "tl"
                  ? "Isinusumite…"
                  : "Submitting…"
                : step === STEPS.length - 1
                  ? language === "tl"
                    ? "Isumite"
                    : "Submit"
                  : language === "tl"
                    ? "Magpatuloy"
                    : "Continue"}
              {!busy &&
                (step === STEPS.length - 1 ? (
                  <Check size={18} />
                ) : (
                  <ArrowRight size={18} />
                ))}
            </button>
          </footer>
        </section>
      </main>
    </div>
  );
}
