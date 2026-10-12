// API key scopes — restrict a key to specific providers, models or combos.
// Pure helpers (no DB / server imports) so the dashboard, the gateway and tests share them.
//
// Scope entry shape: { type: "provider" | "model" | "combo", value: string }
//   provider → value is a provider id or alias ("openai", "cc"); allows every model of it
//   model    → value is a "provider/model" id as listed by /v1/models
//   combo    → value is a combo name; allows calling the combo (its inner models are not checked)
// An empty / missing list means the key may use every model.

export const API_KEY_SCOPE_TYPES = ["provider", "model", "combo"];

/**
 * Validate and de-duplicate raw scope input. Returns [] for "all models".
 * @param {unknown} input
 * @returns {{ type: string, value: string }[]}
 */
export function normalizeApiKeyScopes(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const scopes = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const type = String(entry.type || "").trim();
    const value = String(entry.value || "").trim();
    if (!API_KEY_SCOPE_TYPES.includes(type) || !value) continue;
    const id = `${type}:${value}`;
    if (seen.has(id)) continue;
    seen.add(id);
    scopes.push({ type, value });
  }
  return scopes;
}

export function isApiKeyRestricted(scopes) {
  return Array.isArray(scopes) && scopes.length > 0;
}

/**
 * Decide whether a resolved request target is inside the key's scopes.
 *
 * Both sides are pre-resolved by the caller so this stays pure:
 * @param {{ type: string, value: string, providerIds?: string[], model?: string|null }[]} resolvedScopes
 *   providerIds — every id the entry's provider may be known by (raw alias, resolved id)
 *   model       — resolved model id for "model" entries
 * @param {{ comboName?: string|null, providerIds?: string[], model?: string|null }} target
 * @returns {boolean}
 */
export function isTargetAllowedByScopes(resolvedScopes, target) {
  if (!isApiKeyRestricted(resolvedScopes)) return true;
  if (!target) return false;

  const targetProviders = new Set((target.providerIds || []).filter(Boolean));
  const sharesProvider = (ids) => (ids || []).some((id) => targetProviders.has(id));

  for (const scope of resolvedScopes) {
    if (scope.type === "combo") {
      if (target.comboName && scope.value === target.comboName) return true;
      continue;
    }
    if (target.comboName) continue;
    if (scope.type === "provider" && sharesProvider(scope.providerIds)) return true;
    if (scope.type === "model" && sharesProvider(scope.providerIds)) {
      // A model entry on a provider-only target (web search/fetch) still grants that provider.
      if (!target.model || scope.model === target.model) return true;
    }
  }
  return false;
}

/** Short human label for a key's scope, e.g. "All models" or "2 providers · 1 combo". */
export function describeApiKeyScopes(scopes) {
  if (!isApiKeyRestricted(scopes)) return "All models";
  const counts = { provider: 0, model: 0, combo: 0 };
  for (const s of scopes) if (counts[s.type] !== undefined) counts[s.type]++;
  return API_KEY_SCOPE_TYPES
    .filter((t) => counts[t] > 0)
    .map((t) => `${counts[t]} ${t}${counts[t] === 1 ? "" : "s"}`)
    .join(" · ");
}
