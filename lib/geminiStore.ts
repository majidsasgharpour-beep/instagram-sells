"use client";

/**
 * Tiny external store shared by the key button (OVERVIEW panel) and the orb
 * (ApexWorld): the Gemini API key and the live-session status.
 *
 * The key lives only in this browser's localStorage. It is never sent to this
 * app's server - the browser talks to Google directly (see geminiLive.ts).
 */

import { useSyncExternalStore } from "react";

const KEY_NAME = "apex.gemini.apiKey";

export type Phase = "off" | "connecting" | "listening" | "thinking" | "speaking";
export type GeminiStatus = { phase: Phase; error: string | null };

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

let status: GeminiStatus = { phase: "off", error: null };
let keyCache = "";
let keyLoaded = false;

function loadKey() {
  try { keyCache = (localStorage.getItem(KEY_NAME) ?? "").trim(); } catch { keyCache = ""; }
  keyLoaded = true;
}

export function getKey(): string {
  if (typeof window === "undefined") return "";
  if (!keyLoaded) loadKey();
  return keyCache;
}

export function setKey(key: string) {
  const k = key.trim();
  try {
    if (k) localStorage.setItem(KEY_NAME, k);
    else localStorage.removeItem(KEY_NAME);
  } catch { /* storage blocked: keep it for this tab only */ }
  keyCache = k;
  keyLoaded = true;
  emit();
}

export function getStatus(): GeminiStatus {
  return status;
}

export function setStatus(patch: Partial<GeminiStatus>) {
  const next = { ...status, ...patch };
  if (next.phase === status.phase && next.error === status.error) return;
  status = next;
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  // another tab saved or removed the key
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY_NAME || e.key === null) { loadKey(); emit(); }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

const SERVER_STATUS: GeminiStatus = { phase: "off", error: null };

export const useGeminiKey = () => useSyncExternalStore(subscribe, getKey, () => "");
export const useGeminiStatus = () => useSyncExternalStore(subscribe, getStatus, () => SERVER_STATUS);
