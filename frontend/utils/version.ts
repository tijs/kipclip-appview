/**
 * Module-cached fetch of /api/version. Footer + About both call
 * useVersion() and share the same in-flight promise so the version
 * endpoint is hit at most once per page load.
 *
 * Fail-soft: a failed fetch resolves to null and the components render
 * without a version string. No console error spam — the endpoint is
 * cosmetic, not load-bearing.
 */

import { useEffect, useState } from "react";

export interface VersionInfo {
  version: string;
}

let cachedPromise: Promise<VersionInfo | null> | null = null;

function loadVersion(): Promise<VersionInfo | null> {
  return fetch("/api/version", {
    headers: { Accept: "application/json" },
  })
    .then((r) => (r.ok ? r.json() as Promise<VersionInfo> : null))
    .catch(() => null);
}

export function useVersion(): VersionInfo | null {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  useEffect(() => {
    if (!cachedPromise) cachedPromise = loadVersion();
    let cancelled = false;
    cachedPromise.then((v) => {
      if (!cancelled) setInfo(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return info;
}

/**
 * Build a deep-link to the Tangled tag page for a version, or null
 * when the version is "dev"/"unknown" (no tag exists).
 */
export function releaseUrl(version: string | undefined): string | null {
  if (!version) return null;
  if (!/^v\d+\.\d+\.\d+/.test(version)) return null;
  return `https://tangled.org/tijs.org/kipclip-appview/tags/${version}`;
}
