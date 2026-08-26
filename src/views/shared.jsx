import React, { useEffect, useRef } from "react";
import { Languages } from "lucide-react";
import { LANGUAGES } from "../lib/csm";
import { Tip } from "./ui";
import { navigate } from "../router";

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";

/**
 * The source file is 3000×3000 and 288 KB — larger than the whole JavaScript
 * bundle — for a mark that renders at 38px. ImageKit resizes and re-encodes on
 * the fly, which brings it to about 6 KB; `f-auto` serves WebP or AVIF where
 * the browser accepts it. w-96 still covers a high-density display at 38px.
 */
export const CHED_LOGO =
  "https://ik.imagekit.io/k2qmtccm6/CHED_Logo_New.png?tr=w-96,q-85,f-auto";

export function TurnstileWidget({ action, onToken, resetKey = 0 }) {
  const container = useRef(null),
    widgetId = useRef(null);
  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) return;
    let cancelled = false;
    const render = () => {
      if (cancelled || !container.current || !window.turnstile) return;
      if (widgetId.current !== null) window.turnstile.remove(widgetId.current);
      widgetId.current = window.turnstile.render(container.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action,
        theme: "light",
        size: "flexible",
        callback: onToken,
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
      });
    };
    if (window.turnstile) render();
    else {
      let script = document.querySelector('script[data-csm-turnstile="true"]');
      if (!script) {
        script = document.createElement("script");
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.dataset.csmTurnstile = "true";
        document.head.appendChild(script);
      }
      script.addEventListener("load", render, { once: true });
    }
    return () => {
      cancelled = true;
      if (widgetId.current !== null && window.turnstile)
        window.turnstile.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [action, onToken, resetKey]);
  if (!TURNSTILE_SITE_KEY)
    return (
      <div className="alert">
        Turnstile is not configured. Add VITE_TURNSTILE_SITE_KEY in Vercel.
      </div>
    );
  return <div className="turnstile-wrap" ref={container} />;
}

export function Brand({
  subtitle = "Client Satisfaction Measurement",
  name = "CHED · OSDS",
  light = false,
}) {
  return (
    /* Every `.brand` rule is a descendant selector, so the wrapper this adds
       does not disturb the mark in any of the four places it appears. */
    <Tip placement="bottom" align="start" text="Return to the portal home page">
      <a
        className={`brand${light ? " light" : ""}`}
        href="/"
        onClick={(event) => {
          event.preventDefault();
          navigate("/");
        }}
      >
        {/* Explicit dimensions reserve the box before the image arrives, so the
          brand text does not jump when it does. */}
        <img
          src={CHED_LOGO}
          alt="Commission on Higher Education logo"
          width="38"
          height="38"
        />
        <span>
          <strong>{name}</strong>
          <small>{subtitle}</small>
        </span>
      </a>
    </Tip>
  );
}

export function LanguageToggle({ language, onChange }) {
  return (
    <div className="language-toggle" role="group" aria-label="Form language">
      <Languages size={15} />
      {/* aria-pressed, not a radiogroup: these read better as two independent
          toggles than as one of two choices, and unlike the rating scale there
          is no ordered set to move through. Without it the active language is
          carried by a CSS class alone and a screen reader announces the two
          buttons identically — in the one control that changes the language of
          every question on the page. */}
      {LANGUAGES.map((option) => (
        <Tip
          key={option.id}
          placement="bottom"
          text={`Show the form in ${option.label}`}
        >
          <button
            type="button"
            aria-pressed={language === option.id}
            className={language === option.id ? "active" : ""}
            onClick={() => onChange(option.id)}
          >
            {option.short}
          </button>
        </Tip>
      ))}
    </div>
  );
}

/** English stays visible in Tagalog mode and vice versa, so a reader can always
 *  fall back to the wording they recognize. */
export function Bilingual({ entry, language, className = "" }) {
  if (!entry) return null;
  const primary = language === "tl" ? entry.tl || entry.en : entry.en;
  const secondary = language === "tl" ? entry.en : entry.tl;
  return (
    <span className={`bilingual ${className}`}>
      <span className="bilingual-primary">{primary}</span>
      {secondary && secondary !== primary && (
        <span className="bilingual-secondary">{secondary}</span>
      )}
    </span>
  );
}
