/**
 * API key scopes — restrict a key to specific providers / models / combos.
 *
 * Covers:
 *  - normalizeApiKeyScopes: validation + de-duplication
 *  - isTargetAllowedByScopes: provider / model / combo matching rules
 *  - checkApiKeyModelAccess: end-to-end with real model resolution (aliases, combos)
 *  - filterModelsForApiKey: /v1/models list filtering
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const dbMocks = vi.hoisted(() => ({
  keys: {},
  combos: {},
  getApiKeyByKey: vi.fn(async (key) => dbMocks.keys[key] || null),
  getComboByName: vi.fn(async (name) => dbMocks.combos[name] || null),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import {
  normalizeApiKeyScopes,
  isTargetAllowedByScopes,
  isApiKeyRestricted,
  describeApiKeyScopes,
} from "@/shared/utils/apiKeyScopes.js";
import { checkApiKeyModelAccess, filterModelsForApiKey } from "@/sse/services/apiKeyScope.js";

const scopedKey = (scopes) => ({ id: "k1", name: "scoped", key: "sk-scoped", isActive: true, scopes });

beforeEach(() => {
  dbMocks.keys = {};
  dbMocks.combos = {};
});

describe("normalizeApiKeyScopes", () => {
  it("returns [] for non-arrays (all models)", () => {
    expect(normalizeApiKeyScopes(null)).toEqual([]);
    expect(normalizeApiKeyScopes("openai")).toEqual([]);
  });

  it("drops unknown types, blank values and duplicates", () => {
    expect(normalizeApiKeyScopes([
      { type: "provider", value: " openai " },
      { type: "provider", value: "openai" },
      { type: "bogus", value: "x" },
      { type: "model", value: "" },
      { type: "combo", value: "fast" },
      null,
    ])).toEqual([
      { type: "provider", value: "openai" },
      { type: "combo", value: "fast" },
    ]);
  });

  it("describes scopes for the dashboard", () => {
    expect(describeApiKeyScopes([])).toBe("All models");
    expect(describeApiKeyScopes([
      { type: "provider", value: "a" },
      { type: "provider", value: "b" },
      { type: "combo", value: "c" },
    ])).toBe("2 providers · 1 combo");
    expect(isApiKeyRestricted([])).toBe(false);
  });
});

describe("isTargetAllowedByScopes", () => {
  const scopes = [
    { type: "provider", value: "openai", providerIds: ["openai"] },
    { type: "model", value: "cc/claude-x", providerIds: ["cc", "claude"], model: "claude-x" },
    { type: "combo", value: "fast" },
  ];

  it("allows everything when unrestricted", () => {
    expect(isTargetAllowedByScopes([], { providerIds: ["anything"], model: "m" })).toBe(true);
  });

  it("matches a whole provider", () => {
    expect(isTargetAllowedByScopes(scopes, { providerIds: ["openai"], model: "gpt-4o" })).toBe(true);
  });

  it("matches an exact model only", () => {
    expect(isTargetAllowedByScopes(scopes, { providerIds: ["claude"], model: "claude-x" })).toBe(true);
    expect(isTargetAllowedByScopes(scopes, { providerIds: ["claude"], model: "claude-y" })).toBe(false);
  });

  it("matches combos by name and never via provider entries", () => {
    expect(isTargetAllowedByScopes(scopes, { comboName: "fast" })).toBe(true);
    expect(isTargetAllowedByScopes(scopes, { comboName: "slow" })).toBe(false);
    expect(isTargetAllowedByScopes([{ type: "provider", value: "openai", providerIds: ["openai"] }], { comboName: "openai" })).toBe(false);
  });

  it("lets a model entry grant its provider for provider-only targets (web search/fetch)", () => {
    expect(isTargetAllowedByScopes(scopes, { providerIds: ["claude"], model: null })).toBe(true);
  });
});

describe("checkApiKeyModelAccess", () => {
  it("is a no-op without a key, for unknown keys and for unrestricted keys", async () => {
    dbMocks.keys["sk-open"] = scopedKey([]);
    expect(await checkApiKeyModelAccess(null, "openai/gpt-4o")).toBeNull();
    expect(await checkApiKeyModelAccess("sk-unknown", "openai/gpt-4o")).toBeNull();
    expect(await checkApiKeyModelAccess("sk-open", "openai/gpt-4o")).toBeNull();
  });

  it("allows models of a scoped provider and rejects others with 403", async () => {
    dbMocks.keys["sk-scoped"] = scopedKey([{ type: "provider", value: "openai" }]);
    expect(await checkApiKeyModelAccess("sk-scoped", "openai/gpt-4o")).toBeNull();

    const denied = await checkApiKeyModelAccess("sk-scoped", "gemini/gemini-2.5-pro");
    expect(denied.status).toBe(403);
    const body = await denied.json();
    expect(JSON.stringify(body)).toContain("gemini/gemini-2.5-pro");
  });

  it("matches a provider scope given by alias against requests using the provider id", async () => {
    dbMocks.keys["sk-scoped"] = scopedKey([{ type: "provider", value: "cc" }]);
    expect(await checkApiKeyModelAccess("sk-scoped", "claude/claude-sonnet-4")).toBeNull();
    expect(await checkApiKeyModelAccess("sk-scoped", "cc/claude-sonnet-4")).toBeNull();
  });

  it("allows only the listed model", async () => {
    dbMocks.keys["sk-scoped"] = scopedKey([{ type: "model", value: "openai/gpt-4o" }]);
    expect(await checkApiKeyModelAccess("sk-scoped", "openai/gpt-4o")).toBeNull();
    expect((await checkApiKeyModelAccess("sk-scoped", "openai/gpt-4o-mini")).status).toBe(403);
  });

  it("allows a scoped combo by name and rejects other combos", async () => {
    dbMocks.combos.fast = { name: "fast", models: ["openai/gpt-4o"] };
    dbMocks.combos.slow = { name: "slow", models: ["openai/gpt-4o"] };
    dbMocks.keys["sk-scoped"] = scopedKey([{ type: "combo", value: "fast" }]);
    expect(await checkApiKeyModelAccess("sk-scoped", "fast")).toBeNull();
    expect((await checkApiKeyModelAccess("sk-scoped", "slow")).status).toBe(403);
    // Combo access does not grant direct access to its inner models
    expect((await checkApiKeyModelAccess("sk-scoped", "openai/gpt-4o")).status).toBe(403);
  });

  it("checks web search/fetch providers by provider id", async () => {
    dbMocks.keys["sk-scoped"] = scopedKey([{ type: "provider", value: "brave" }]);
    expect(await checkApiKeyModelAccess("sk-scoped", "brave", { providerOnly: true })).toBeNull();
    expect((await checkApiKeyModelAccess("sk-scoped", "exa", { providerOnly: true })).status).toBe(403);
  });
});

describe("filterModelsForApiKey", () => {
  const models = [
    { id: "fast", owned_by: "combo" },
    { id: "openai/gpt-4o", owned_by: "openai" },
    { id: "gemini/gemini-2.5-pro", owned_by: "gemini" },
  ];

  it("returns the list unchanged for unrestricted or missing keys", async () => {
    expect(await filterModelsForApiKey(null, models)).toBe(models);
  });

  it("keeps only allowed entries for a scoped key", async () => {
    dbMocks.combos.fast = { name: "fast", models: ["openai/gpt-4o"] };
    dbMocks.keys["sk-scoped"] = scopedKey([
      { type: "provider", value: "openai" },
      { type: "combo", value: "fast" },
    ]);
    const ids = (await filterModelsForApiKey("sk-scoped", models)).map((m) => m.id);
    expect(ids).toEqual(["fast", "openai/gpt-4o"]);
  });
});
