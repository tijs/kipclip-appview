import { useEffect, useState } from "react";
import { useApp } from "../context/AppContext.tsx";
import { apiGet, apiPut } from "../utils/api.ts";
import {
  type DomainTagRule,
  validateDomainTagRules,
} from "../../shared/domain-tag-rules.ts";

export function DomainTagSettings() {
  const { tags } = useApp();
  const [rules, setRules] = useState<DomainTagRule[]>([]);
  const [revision, setRevision] = useState<string | null>(null);
  const [domain, setDomain] = useState("");
  const [tag, setTag] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiGet("/api/preferences/domain-tags").then(async (res) => {
      if (!res.ok) throw new Error("Could not load site tag rules.");
      const data = await res.json();
      if (active) {
        setRules(data.rules ?? []);
        setRevision(data.cid);
        setReady(true);
      }
    }).catch(() => {
      if (active) {
        setError(
          "Could not load site tag rules. Reload this page to try again.",
        );
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function save(next: DomainTagRule[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPut("/api/preferences", {
        domainTagRules: next,
        domainRulesRevision: revision,
      });
      if (res.status === 409) {
        setReady(false);
        throw new Error(
          "Rules changed on another device. Reload this page before saving again.",
        );
      }
      if (!res.ok) {
        throw new Error(
          "Could not confirm the save. Reload this page before trying again.",
        );
      }
      const data = await res.json();
      if (!data.domainRules || typeof data.domainRules.cid !== "string") {
        throw new Error(
          "The save could not be confirmed. Reload this page to check your rules.",
        );
      }
      setRules(data.domainRules.rules);
      setRevision(data.domainRules.cid);
      return true;
    } catch (err: any) {
      setReady(false);
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const rule = { domain: domain.trim().toLowerCase(), tag };
    if (!validateDomainTagRules([rule])) {
      setError("Enter a hostname and select an existing tag.");
      return;
    }
    if (
      rules.some((r) =>
        r.domain === rule.domain &&
        r.tag.toLowerCase() === rule.tag.toLowerCase()
      )
    ) {
      setError("That rule already exists.");
      return;
    }
    if (await save([...rules, rule])) {
      setDomain("");
      setTag("");
    }
  }

  return (
    <section className="bg-white rounded-lg shadow-md p-6 space-y-4">
      <h3 className="text-xl font-bold text-gray-800">Site tag suggestions</h3>
      <p className="text-sm text-gray-600">
        Suggest existing tags when a bookmark matches an exact hostname.
        Subdomains need their own rule; suggestions are added only when you
        choose them. These rules are stored in your public AT Protocol
        repository.
      </p>
      <label className="block text-sm" htmlFor="domain-tag-host">
        Hostname
      </label>
      <input
        id="domain-tag-host"
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        placeholder="arxiv.org"
        disabled={!ready || busy}
        className="border rounded px-3 py-2"
      />
      <label className="block text-sm" htmlFor="domain-tag-value">
        Existing tag
      </label>
      <select
        id="domain-tag-value"
        value={tag}
        onChange={(e) => setTag(e.target.value)}
        disabled={!ready || busy}
        className="border rounded px-3 py-2"
      >
        <option value="">Select a tag</option>
        {tags.map((item) => (
          <option key={item.uri} value={item.value}>{item.value}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={add}
        disabled={!ready || busy}
        className="block border rounded px-3 py-2"
      >
        Add rule
      </button>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <ul>
        {rules.map((rule, index) => (
          <li
            key={`${rule.domain}-${rule.tag}-${index}`}
            className="flex flex-wrap gap-3 items-center py-1"
          >
            <span className="min-w-0 break-all">
              {rule.domain} → {rule.tag}
            </span>
            <button
              type="button"
              disabled={!ready || busy}
              aria-label={`Remove ${rule.tag} rule for ${rule.domain}`}
              onClick={() => save(rules.filter((_, i) => i !== index))}
              className="underline"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
