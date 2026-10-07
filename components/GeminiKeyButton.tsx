"use client";

/**
 * Small key button that sits next to the weather in the OVERVIEW panel.
 * Opens a popover to paste / replace / remove the visitor's Gemini API key.
 * The key is kept in this browser only; with a key saved, tapping the orb
 * starts a Gemini Live voice conversation.
 */

import { useEffect, useRef, useState } from "react";
import { KeyRound, ArrowUpRight } from "lucide-react";
import { setKey, useGeminiKey, useGeminiStatus } from "@/lib/geminiStore";

const ACCENT = "#00e5ff";

const PHASE_TEXT: Record<string, string> = {
  connecting: "Connecting to Gemini...",
  listening: "Live - listening. Tap the orb to stop.",
  thinking: "Live - processing...",
  speaking: "Live - speaking. Tap the orb to stop.",
};

export default function GeminiKeyButton() {
  const saved = useGeminiKey();
  const status = useGeminiStatus();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const live = status.phase !== "off";
  const dot = status.error ? "#ff6b6b" : live ? "#34d399" : saved ? ACCENT : "rgba(240,237,232,0.35)";

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const save = () => {
    if (!draft.trim()) return;
    setKey(draft);
    setDraft("");
    setOpen(false);
  };

  const remove = () => {
    setKey("");
    setDraft("");
  };

  const btn: React.CSSProperties = {
    padding: "7px 12px", borderRadius: 8, fontSize: 11, letterSpacing: "0.06em",
    cursor: "pointer", border: `1px solid ${ACCENT}44`, background: `${ACCENT}14`, color: "rgba(240,237,232,0.92)",
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", alignSelf: "flex-end" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Gemini API key"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={saved ? "Gemini key saved" : "Add your Gemini API key"}
        style={{
          display: "flex", alignItems: "center", gap: 7, padding: "7px 11px",
          background: "rgba(6,14,26,0.72)", border: `1px solid ${ACCENT}2a`, borderRadius: 10,
          color: "rgba(240,237,232,0.9)", cursor: "pointer", backdropFilter: "blur(8px)",
        }}
      >
        <KeyRound size={15} style={{ color: ACCENT }} />
        <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}>Gemini</span>
        <span
          aria-hidden="true"
          style={{
            width: 7, height: 7, borderRadius: "50%", background: dot, boxShadow: `0 0 8px ${dot}`,
            animation: status.phase === "connecting" ? "sbBar 0.7s ease-in-out infinite alternate" : "none",
          }}
        />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Gemini API key"
          style={{
            position: "absolute", top: "calc(100% + 10px)", left: 0, zIndex: 70,
            width: "min(300px, 86vw)", padding: 14, display: "flex", flexDirection: "column", gap: 10,
            background: "rgba(4,3,12,0.94)", backdropFilter: "blur(24px)",
            border: `1px solid ${ACCENT}44`, borderRadius: 14,
            boxShadow: `0 0 40px ${ACCENT}18, 0 8px 32px rgba(0,0,0,0.6)`,
          }}
        >
          <div style={{ fontSize: 9, letterSpacing: "0.14em", color: `${ACCENT}99`, fontFamily: "var(--font-mono)" }}>
            GEMINI API KEY
          </div>

          <input
            ref={inputRef}
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            placeholder={saved ? "Key saved - paste a new one to replace" : "Paste your key (AIza...)"}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Gemini API key"
            style={{
              width: "100%", boxSizing: "border-box", padding: "9px 11px", fontSize: 12,
              background: "rgba(6,14,26,0.8)", border: `1px solid ${ACCENT}33`, borderRadius: 8,
              color: "#f0ede8", outline: "none",
            }}
          />

          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={save} disabled={!draft.trim()} style={{ ...btn, flex: 1, opacity: draft.trim() ? 1 : 0.45, cursor: draft.trim() ? "pointer" : "default" }}>
              Save
            </button>
            {saved && (
              <button type="button" onClick={remove} style={{ ...btn, background: "transparent", border: "1px solid rgba(255,255,255,0.18)", color: "rgba(240,237,232,0.7)" }}>
                Remove
              </button>
            )}
          </div>

          <div aria-live="polite" style={{ fontSize: 10.5, lineHeight: 1.5, color: status.error ? "#ff9b9b" : "rgba(240,237,232,0.55)" }}>
            {status.error
              ? status.error
              : live
                ? PHASE_TEXT[status.phase]
                : saved
                  ? "Key saved. Tap the orb to talk with Gemini."
                  : "Saved only in this browser. Add a key, then tap the orb to talk."}
          </div>

          {live && status.info && (
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 10, lineHeight: 1.5, color: `${ACCENT}bb`, fontFamily: "var(--font-mono)", borderTop: `1px solid ${ACCENT}1a`, paddingTop: 8 }}>
              {status.info}
            </div>
          )}

          <a
            href="https://aistudio.google.com/apikey"
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, color: `${ACCENT}cc`, textDecoration: "none", width: "fit-content" }}
          >
            Get a free key <ArrowUpRight size={11} />
          </a>
        </div>
      )}
    </div>
  );
}
