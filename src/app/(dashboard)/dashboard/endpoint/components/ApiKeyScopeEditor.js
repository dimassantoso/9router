"use client";

import { useState, useEffect, useMemo } from "react";
import PropTypes from "prop-types";
import { Select, ModelSelectModal } from "@/shared/components";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import { normalizeApiKeyScopes } from "@/shared/utils/apiKeyScopes";

const TYPE_LABELS = { provider: "Provider", model: "Model", combo: "Combo" };

// Scope chip — model and combo values can be edited inline (click the value)
function ScopeChip({ scope, onEdit, onRemove }) {
  const editable = scope.type !== "provider";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(scope.value);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== scope.value) onEdit(trimmed);
    else setDraft(scope.value);
    setEditing(false);
  };
  const handleKeyDown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.stopPropagation(); setDraft(scope.value); setEditing(false); }
  };
  return (
    <span className="inline-flex items-center gap-1 max-w-full pl-2 pr-1 py-0.5 rounded-md bg-primary/10 text-xs">
      <span className="text-text-muted shrink-0">{TYPE_LABELS[scope.type]}</span>
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="min-w-[10rem] rounded border border-primary/40 bg-white px-1 py-0 font-mono text-xs text-text-main outline-none dark:bg-black/20"
        />
      ) : (
        <code
          className={`font-mono truncate ${editable ? "cursor-text rounded px-0.5 hover:bg-black/5 dark:hover:bg-white/10" : ""}`}
          onClick={editable ? () => setEditing(true) : undefined}
          title={editable ? "Click to edit" : undefined}
        >
          {scope.value}
        </code>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/10 text-text-muted hover:text-red-500"
        title={`Remove ${scope.value}`}
      >
        <span className="material-symbols-outlined text-[14px]">close</span>
      </button>
    </span>
  );
}

ScopeChip.propTypes = {
  scope: PropTypes.shape({ type: PropTypes.string.isRequired, value: PropTypes.string.isRequired }).isRequired,
  onEdit: PropTypes.func.isRequired,
  onRemove: PropTypes.func.isRequired,
};

/**
 * Edit which providers / models / combos an API key may call.
 * `scopes` empty = all models. Controlled: parent owns the value.
 */
export default function ApiKeyScopeEditor({ scopes, onChange, requireApiKey }) {
  const [restricted, setRestricted] = useState(scopes.length > 0);
  const [connections, setConnections] = useState([]);
  const [comboNames, setComboNames] = useState(new Set());
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [providerChoice, setProviderChoice] = useState("");
  const [manualModel, setManualModel] = useState("");

  useEffect(() => {
    if (!restricted) return;
    let cancelled = false;
    Promise.all([fetch("/api/providers"), fetch("/api/combos")])
      .then(async ([providersRes, combosRes]) => {
        const providersData = providersRes.ok ? await providersRes.json() : {};
        const combosData = combosRes.ok ? await combosRes.json() : {};
        if (cancelled) return;
        setConnections((providersData.connections || []).filter((c) => c.isActive !== false));
        setComboNames(new Set((combosData.combos || []).map((c) => c.name)));
      })
      .catch((error) => console.log("Error loading scope options:", error));
    return () => { cancelled = true; };
  }, [restricted]);

  const providerOptions = useMemo(() => {
    const taken = new Set(scopes.filter((s) => s.type === "provider").map((s) => s.value));
    const seen = new Set();
    const options = [];
    for (const conn of connections) {
      const alias = getProviderAlias(conn.provider) || conn.provider;
      if (seen.has(alias) || taken.has(alias)) continue;
      seen.add(alias);
      options.push({ value: alias, label: AI_PROVIDERS[conn.provider]?.name || conn.provider });
    }
    return options.sort((a, b) => a.label.localeCompare(b.label));
  }, [connections, scopes]);

  const setScopes = (next) => onChange(normalizeApiKeyScopes(next));

  const handleRestrictedChange = (checked) => {
    setRestricted(checked);
    if (!checked) onChange([]);
  };

  const addProvider = (alias) => {
    if (!alias) return;
    setScopes([...scopes, { type: "provider", value: alias }]);
    setProviderChoice("");
  };

  const handleModelSelect = (model) => {
    const value = model?.value || model?.name;
    if (!value) return;
    const type = comboNames.has(value) ? "combo" : "model";
    setScopes([...scopes, { type, value }]);
  };

  const handleModelDeselect = (model) => {
    const value = model?.value || model?.name;
    setScopes(scopes.filter((s) => s.type === "provider" || s.value !== value));
  };

  const removeScope = (index) => setScopes(scopes.filter((_, i) => i !== index));

  // Typed values: a known combo name becomes a combo entry, anything else a model id
  const scopeForValue = (value) => ({ type: comboNames.has(value) ? "combo" : "model", value });

  const editScope = (index, value) => {
    setScopes(scopes.map((s, i) => (i === index ? scopeForValue(value) : s)));
  };

  const addManualModel = () => {
    const value = manualModel.trim();
    if (!value) return;
    setScopes([...scopes, scopeForValue(value)]);
    setManualModel("");
  };

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={restricted}
          onChange={(e) => handleRestrictedChange(e.target.checked)}
          className="mt-0.5 accent-primary"
        />
        <span className="flex flex-col">
          <span className="text-sm font-medium text-text-main">Restrict to specific models</span>
          <span className="text-xs text-text-muted">
            {restricted ? "This key can only call what you add below." : "This key can call every model, provider and combo."}
          </span>
        </span>
      </label>

      {restricted && (
        <div className="flex flex-col gap-3 pl-6">
          {scopes.length === 0 ? (
            <p className="text-xs text-orange-500">Add at least one provider, model or combo. With nothing added the key can still call everything.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {scopes.map((scope, index) => (
                <ScopeChip
                  key={`${scope.type}:${scope.value}`}
                  scope={scope}
                  onEdit={(value) => editScope(index, value)}
                  onRemove={() => removeScope(index)}
                />
              ))}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2">
            <Select
              className="flex-1"
              options={providerOptions}
              value={providerChoice}
              onChange={(e) => addProvider(e.target.value)}
              placeholder={providerOptions.length ? "Allow a whole provider…" : "No more connected providers"}
              disabled={providerOptions.length === 0}
            />
            <button
              type="button"
              onClick={() => setShowModelSelect(true)}
              className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-[10px] bg-surface-2 text-sm hover:text-primary"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              Model or combo
            </button>
          </div>

          <div className="flex gap-2">
            <input
              id="api-key-scope-manual-model"
              value={manualModel}
              onChange={(e) => setManualModel(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addManualModel(); } }}
              placeholder="Or type a model id, e.g. openai/gpt-4o"
              className="flex-1 min-w-0 py-2 px-3 rounded-[10px] bg-surface-2 font-mono text-[16px] sm:text-sm text-text-main outline-none focus:ring-2 focus:ring-brand-500/30"
            />
            <button
              type="button"
              onClick={addManualModel}
              disabled={!manualModel.trim()}
              className="px-3 py-2 rounded-[10px] bg-surface-2 text-sm hover:text-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>

          {!requireApiKey && (
            <p className="text-xs text-text-muted">
              Scopes apply whenever this key is sent. Turn on <span className="font-medium">Require API key</span> so clients can&apos;t skip the key.
            </p>
          )}
        </div>
      )}

      {showModelSelect && (
        <ModelSelectModal
          isOpen={showModelSelect}
          onClose={() => setShowModelSelect(false)}
          onSelect={handleModelSelect}
          onDeselect={handleModelDeselect}
          activeProviders={connections}
          title="Allow Model or Combo"
          addedModelValues={scopes.filter((s) => s.type !== "provider").map((s) => s.value)}
          closeOnSelect={false}
        />
      )}
    </div>
  );
}

ApiKeyScopeEditor.propTypes = {
  scopes: PropTypes.arrayOf(PropTypes.shape({
    type: PropTypes.oneOf(["provider", "model", "combo"]).isRequired,
    value: PropTypes.string.isRequired,
  })).isRequired,
  onChange: PropTypes.func.isRequired,
  requireApiKey: PropTypes.bool,
};
