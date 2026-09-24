import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

/**
 * The Privacy Notice shown on the survey, and the version it is recorded under.
 *
 * Kept in one module so the two cannot drift: the version sent with a
 * submission is the version of the words on this page. Change the text below
 * and change the version with it — a response filed as "1.1" has to mean the
 * client was shown exactly this, or the record documents nothing. The response
 * also records the language the form was in, so version and language together
 * name the text that was on screen once a Filipino notice exists.
 *
 * 1.0  First notice: the Certificate of Appearance fields only.
 * 1.1  "Information We Collect" lists the survey's own fields as well — email,
 *      client type, sex, age, region, service, ratings and suggestions — which
 *      1.0 left out; "Purpose of Processing" names client-satisfaction
 *      measurement.
 */
export const PRIVACY_NOTICE_VERSION = "1.1";

/** The one-line notice above Submit. Split so "Privacy Notice" can be a link. */
export const PRIVACY_NOTE = {
  en: {
    before:
      "By submitting this form, you confirm that you have read and understood how CHED-OSDS processes your personal information as described in the ",
    link: "Privacy Notice",
    after: ".",
  },
  tl: {
    before:
      "Sa pagsusumite ng form na ito, kinukumpirma ninyong nabasa at naunawaan ninyo kung paano pinoproseso ng CHED-OSDS ang inyong personal na impormasyon ayon sa ",
    link: "Privacy Notice",
    after: ".",
  },
};

/** Helper text under "Purpose of appearance". */
export const PURPOSE_PRIVACY_HELP = {
  en: "Please do not provide sensitive personal information or information about other individuals unless necessary for your transaction.",
  tl: "Mangyaring huwag magbigay ng sensitibong personal na impormasyon o impormasyon tungkol sa ibang tao maliban kung kailangan para sa inyong transaksyon.",
};

/** The dialog's own labels, which follow the form's language. */
const DIALOG_TEXT = {
  en: {
    close: "Close",
    closeLabel: "Close the Privacy Notice",
    version: "Privacy Notice version",
  },
  tl: {
    close: "Isara",
    closeLabel: "Isara ang Privacy Notice",
    version: "Bersyon ng Privacy Notice",
    // Shown above the English notice while no approved Filipino text exists.
    englishOnly:
      "Ang buong Privacy Notice ay nasa Ingles pa lamang. Kung may tanong kayo tungkol dito, sumulat sa osds@ched.gov.ph.",
  },
};

/**
 * The notice itself, per language. Only English so far, deliberately: this is
 * a legal document, and a translation the office has not approved would be
 * presented to clients as though it were the official text. A Filipino client
 * gets the English notice with a line in Filipino saying so. Once the office
 * (or its Data Protection Officer) approves a Filipino text, add it here as
 * `tl` and it is shown in Filipino mode with nothing else to change — the
 * version stays shared, so a Filipino text must say what the English says.
 */
const NOTICE_BODY = {
  en: NoticeBodyEn,
};

/**
 * The full notice, in a native modal <dialog>.
 *
 * Native rather than hand-built: showModal() puts the page behind it out of
 * reach of keyboard and screen reader, closes on Escape, and returns focus to
 * the link that opened it — each of which a div-based modal has to reimplement
 * and usually gets partly wrong. It is only ever shown and hidden, never
 * mounted and unmounted with the page, so nothing typed into the form is
 * touched by opening it.
 *
 * Whether it is open lives in the element alone, and the parent only ever asks
 * it to open, by changing `openCount`. The obvious design — an open flag the
 * dialog clears from its "close" event — depends on that event firing, and it
 * does not everywhere: an embedded browser was found firing none, even for a
 * bare <dialog>, and in-app browsers are exactly where a client may open this
 * form. There the flag stayed "open", the next click set it to "open" again,
 * nothing re-rendered, and the notice could be read once and never again. A
 * counter changes on every click, so every click opens it.
 */
export function PrivacyNoticeDialog({ openCount, language = "en" }) {
  const dialog = useRef(null);
  const text = DIALOG_TEXT[language] || DIALOG_TEXT.en;
  const Body = NOTICE_BODY[language];

  // A browser without <dialog> still gets the notice, without the modal
  // behaviour.
  const supported = () => typeof dialog.current?.showModal === "function";

  const closeDialog = () => {
    const element = dialog.current;
    if (!element) return;
    if (supported()) element.close();
    else element.removeAttribute("open");
  };

  // The count already acted on, starting at whatever it was when this mounted.
  // Only a count that has moved since is a click asking for the notice. Keyed on
  // `openCount` alone, a mount with a count above zero opened it — which is
  // what happened after "Submit another response": the success page unmounts
  // this, the form comes back with the count from before, and the notice
  // opened on its own over the new response.
  const handled = useRef(openCount);

  useEffect(() => {
    const element = dialog.current;
    if (!element || openCount === handled.current) return;
    handled.current = openCount;
    if (element.open) return;
    if (supported()) element.showModal();
    else element.setAttribute("open", "");
  }, [openCount]);

  return (
    <dialog
      ref={dialog}
      className="privacy-dialog"
      aria-labelledby="privacy-dialog-title"
      onClick={(event) => {
        // Only the backdrop: the inner wrapper covers the whole dialog box, so
        // a click that lands on the dialog element itself is outside it.
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div className="privacy-dialog-inner">
        <div className="privacy-dialog-head">
          <h2 id="privacy-dialog-title">Privacy Notice</h2>
          <button
            type="button"
            className="privacy-dialog-close"
            aria-label={text.closeLabel}
            onClick={closeDialog}
          >
            <X size={18} />
          </button>
        </div>

        {Body ? (
          <div className="privacy-dialog-body">
            <Body />
          </div>
        ) : (
          <div className="privacy-dialog-body">
            <p className="privacy-dialog-language">{text.englishOnly}</p>
            {/* Marked English, so a screen reader set to Filipino switches
                voice rather than reading English with Filipino rules. */}
            <div lang="en">
              <NoticeBodyEn />
            </div>
          </div>
        )}

        <div className="privacy-dialog-foot">
          <small>
            {text.version} {PRIVACY_NOTICE_VERSION}
          </small>
          <button
            type="button"
            className="button primary"
            onClick={closeDialog}
          >
            {text.close}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function NoticeBodyEn() {
  return (
    <>
      <p>
        The Commission on Higher Education (CHED), through the Office of Student
        Development and Services (OSDS), respects your right to privacy and is
        committed to protecting your personal information in accordance with
        Republic Act No. 10173, or the Data Privacy Act of 2012, its
        Implementing Rules and Regulations, and other applicable issuances.
      </p>

      <h3>Information We Collect</h3>
      <p>
        For purposes of measuring client satisfaction with its services,
        documenting your visit, and processing your Certificate of Appearance if
        you request one, CHED-OSDS may collect the following information.
      </p>
      <p>When you answer the survey:</p>
      <ul>
        <li>Email address</li>
        <li>Client type</li>
        <li>Sex and age, if you provide them</li>
        <li>Region of residence</li>
        <li>Service availed and date of transaction</li>
        <li>
          Your answers to the Citizen&rsquo;s Charter and service quality
          questions, and any suggestions you write
        </li>
        <li>
          The language you used and the version of this notice shown to you
        </li>
      </ul>
      <p>When you request a Certificate of Appearance, also:</p>
      <ul>
        <li>Title</li>
        <li>Full name</li>
        <li>Agency, school, or company</li>
        <li>Purpose of appearance or transaction</li>
        <li>Date or period of appearance</li>
      </ul>
      <p>
        CHED-OSDS may also keep other information you voluntarily provide in
        connection with your transaction. Please avoid providing sensitive
        personal information or information about other individuals unless it is
        necessary for your transaction.
      </p>

      <h3>Purpose of Processing</h3>
      <p>
        Your information will be collected and processed only for legitimate and
        official purposes, including:
      </p>
      <ul>
        <li>measuring client satisfaction and improving CHED-OSDS services;</li>
        <li>documenting your visit or transaction with CHED-OSDS;</li>
        <li>processing and issuing your Certificate of Appearance;</li>
        <li>
          verifying the authenticity of certificates issued through the system;
        </li>
        <li>maintaining official transaction records;</li>
        <li>generating administrative and statistical reports; and</li>
        <li>
          complying with applicable legal, regulatory, audit, and
          records-management requirements.
        </li>
      </ul>
      <p>
        Your information will not be used for purposes incompatible with those
        stated above unless required or permitted by law.
      </p>

      <h3>Legal Basis</h3>
      <p>
        CHED-OSDS processes personal information as necessary for the
        performance of its official functions and responsibilities as a
        government agency and for compliance with applicable legal and
        regulatory requirements.
      </p>
      <p>
        Where consent is specifically required by law for a particular
        processing activity, appropriate consent will be obtained separately.
      </p>

      <h3>Disclosure and Sharing</h3>
      <p>
        Your personal information will be accessible only to authorized CHED
        personnel and service providers, when applicable, who require access for
        legitimate official purposes.
      </p>
      <p>
        Information may also be disclosed to other government agencies or
        competent authorities when required or authorized by law.
      </p>
      <p>
        CHED-OSDS will not sell, rent, or use your personal information for
        commercial marketing purposes.
      </p>

      <h3>Data Security</h3>
      <p>
        CHED-OSDS implements reasonable and appropriate organizational,
        physical, and technical security measures to protect personal
        information against unauthorized access, disclosure, alteration, loss,
        or misuse.
      </p>

      <h3>Retention of Information</h3>
      <p>
        Personal information will be retained only for as long as necessary to
        fulfill the purposes for which it was collected and in accordance with
        applicable CHED records-retention policies, government
        records-management requirements, and other applicable laws and
        regulations.
      </p>
      <p>
        Upon expiration of the applicable retention period, records will be
        securely disposed of or anonymized, as appropriate.
      </p>

      <h3>Your Rights</h3>
      <p>
        Subject to applicable laws and regulations, you may exercise your rights
        as a data subject, including the right to:
      </p>
      <ul>
        <li>be informed about the processing of your personal information;</li>
        <li>access your personal information;</li>
        <li>request correction of inaccurate or incomplete information;</li>
        <li>object to certain processing activities when applicable;</li>
        <li>request erasure or blocking when allowed by law;</li>
        <li>
          obtain appropriate remedies in case of violations of your data privacy
          rights; and
        </li>
        <li>lodge a complaint with the National Privacy Commission.</li>
      </ul>
      <p>
        Some requests may be subject to limitations when CHED is required by law
        or government records-management rules to retain or process particular
        records.
      </p>

      <h3>Contact Information</h3>
      <p>
        For questions, concerns, or requests regarding the processing of your
        personal information, you may contact:
      </p>
      <address>
        Commission on Higher Education
        <br />
        Office of Student Development and Services
        <br />
        C.P. Garcia Avenue, Diliman, Quezon City
        <br />
        Email: <a href="mailto:osds@ched.gov.ph">osds@ched.gov.ph</a>
      </address>
    </>
  );
}
