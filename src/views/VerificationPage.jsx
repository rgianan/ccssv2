import React, { useEffect, useState } from "react";
import { ArrowLeft, BadgeCheck, X } from "lucide-react";
import { verifyCertificate } from "../lib/api";
import { Brand } from "./shared";
import { Tip } from "./ui";
import { navigate } from "../router";

export function VerificationPage() {
  const initialCode =
    new URLSearchParams(window.location.search).get("code") || "";
  const [code, setCode] = useState(initialCode.toUpperCase()),
    [result, setResult] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  async function verify(event, submitted = code) {
    event?.preventDefault();
    const normalized = submitted.trim().toUpperCase();
    if (!normalized)
      return setError(
        "Enter the verification code printed on the certificate.",
      );
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(await verifyCertificate(normalized));
    } catch (verifyError) {
      setError(verifyError.message || "Unable to verify this certificate.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialCode) verify(null, initialCode);
  }, []);

  return (
    <div className="verification-page">
      <header className="topbar">
        <Brand />
        <Tip
          align="end"
          placement="bottom"
          text="Return to the portal home page"
        >
          <a
            className="topbar-link"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
          >
            <ArrowLeft size={17} /> Home
          </a>
        </Tip>
      </header>
      <main className="verification-shell">
        <section className="verification-intro">
          <p className="eyebrow">
            <BadgeCheck size={15} /> Certificate validation
          </p>
          <h1>Verify a Certificate of Appearance</h1>
          <p>
            Enter the code printed on the certificate, or scan its QR code, to
            confirm that the Office of Student Development and Services issued
            it.
          </p>
        </section>
        <form className="verification-card" onSubmit={verify}>
          <label>
            Certificate verification code
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="OSDS-XXXXXXXXXXXXXXXXXXXX"
              autoComplete="off"
            />
          </label>
          {/* `block`: this button is full-width inside the card, and an
              inline-flex wrapper collapsed it to its text. */}
          <Tip
            block
            text="Check this code against the office's issuance register"
          >
            <button className="button primary" disabled={busy}>
              <BadgeCheck size={18} />{" "}
              {busy ? "Checking…" : "Verify certificate"}
            </button>
          </Tip>
          {error && <div className="alert">{error}</div>}
          {result &&
            (result.valid ? (
              <article className="verification-result valid">
                <BadgeCheck />
                <div>
                  <span>Authentic certificate</span>
                  <h2>{result.name}</h2>
                  <dl>
                    <div>
                      <dt>Agency</dt>
                      <dd>{result.agency || "—"}</dd>
                    </div>
                    <div>
                      <dt>Purpose</dt>
                      <dd>{result.purpose || "—"}</dd>
                    </div>
                    <div>
                      <dt>Date covered</dt>
                      <dd>{result.dateCoverage || "—"}</dd>
                    </div>
                    <div>
                      <dt>Issued</dt>
                      <dd>{result.issuedAt || "—"}</dd>
                    </div>
                    <div>
                      <dt>Verification code</dt>
                      <dd>{result.verificationCode}</dd>
                    </div>
                  </dl>
                  {/* No link to the stored PDF: it lives in the office's Drive
                      and shows "Request access" to anyone outside CHED, which
                      is a dead end on the one page meant to reassure a
                      stranger. The details above are the verification. */}
                </div>
              </article>
            ) : (
              <article className="verification-result invalid">
                <X />
                <div>
                  <span>Certificate not verified</span>
                  <p>
                    No issued certificate matches this code. Check the code
                    carefully or contact the OSDS.
                  </p>
                </div>
              </article>
            ))}
        </form>
      </main>
    </div>
  );
}
