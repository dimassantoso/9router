// Enforce per-API-key model scopes on /v1 endpoints.
// A key with no scopes may use everything; a scoped key is checked whenever it is presented,
// independent of the `requireApiKey` setting.
import { getApiKeyByKey, getComboByName } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { isApiKeyRestricted, isTargetAllowedByScopes } from "@/shared/utils/apiKeyScopes.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { getModelInfo } from "./model.js";
import * as log from "../utils/logger.js";

function providerIdsFor(...candidates) {
  const ids = new Set();
  for (const c of candidates) {
    if (!c) continue;
    ids.add(c);
    ids.add(resolveProviderId(c));
  }
  return [...ids];
}

async function resolveScopes(scopes) {
  return Promise.all(scopes.map(async (scope) => {
    if (scope.type === "provider") {
      const info = await getModelInfo(`${scope.value}/_`);
      return { ...scope, providerIds: providerIdsFor(scope.value, info.provider) };
    }
    if (scope.type === "model") {
      const info = await getModelInfo(scope.value);
      const alias = scope.value.includes("/") ? scope.value.slice(0, scope.value.indexOf("/")) : null;
      return { ...scope, providerIds: providerIdsFor(alias, info.provider), model: info.model };
    }
    return scope;
  }));
}

/**
 * Resolve a requested model string into a scope target.
 * @param {string} modelStr
 * @param {{ providerOnly?: boolean }} [options] providerOnly — the value names a provider (web search/fetch)
 */
async function resolveTarget(modelStr, { providerOnly = false } = {}) {
  if (!modelStr.includes("/") && await getComboByName(modelStr)) {
    return { comboName: modelStr };
  }
  if (providerOnly) {
    return { providerIds: providerIdsFor(modelStr), model: null };
  }
  const info = await getModelInfo(modelStr);
  if (!info.provider) return { comboName: info.model || modelStr };
  const alias = modelStr.includes("/") ? modelStr.slice(0, modelStr.indexOf("/")) : null;
  return { providerIds: providerIdsFor(alias, info.provider), model: info.model };
}

/** Load the scopes for a presented key; null when the key is unknown or unrestricted. */
async function getRestrictedScopes(apiKey) {
  if (!apiKey) return null;
  const record = await getApiKeyByKey(apiKey);
  if (!record || !isApiKeyRestricted(record.scopes)) return null;
  return { name: record.name, scopes: await resolveScopes(record.scopes) };
}

/**
 * @returns {Promise<Response|null>} a 403 response when the key may not use this model, else null
 */
export async function checkApiKeyModelAccess(apiKey, modelStr, options = {}) {
  if (!modelStr) return null;
  const restricted = await getRestrictedScopes(apiKey);
  if (!restricted) return null;

  const target = await resolveTarget(String(modelStr), options);
  if (isTargetAllowedByScopes(restricted.scopes, target)) return null;

  log.warn("AUTH", `API key "${restricted.name}" is not allowed to use model "${modelStr}"`);
  return errorResponse(HTTP_STATUS.FORBIDDEN, `This API key is not allowed to use model "${modelStr}"`);
}

/**
 * Filter an OpenAI-style models list down to what the presented key may use.
 * @param {string|null} apiKey
 * @param {{ id: string, kind?: string }[]} models
 */
export async function filterModelsForApiKey(apiKey, models) {
  const restricted = await getRestrictedScopes(apiKey);
  if (!restricted) return models;

  const allowed = [];
  for (const model of models) {
    const providerOnly = model.kind === "webSearch" || model.kind === "webFetch";
    const target = await resolveTarget(model.id, { providerOnly: providerOnly && !model.id.includes("/") });
    if (isTargetAllowedByScopes(restricted.scopes, target)) allowed.push(model);
  }
  return allowed;
}
