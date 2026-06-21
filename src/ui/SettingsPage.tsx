import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, KeyRound, Sparkles } from "lucide-react";
import type { ProviderSettings } from "../shared/domain";
import type {
  AppConfigPreferences,
  AppConfigPublic,
  LlmRuntimeConfig,
} from "../shared/appConfig";
import { maxTokenOptions, thinkingBudgetOptions } from "../shared/appConfig";
import {
  modelFieldsForStack,
  presetList,
  PROVIDER_PRESETS,
  resolveModels,
  type ProviderPresetId,
} from "../shared/providerPresets";
import { apiKeyGuideForEndpoint } from "../shared/apiKeyGuides";
import { ApiKeyGuideCard } from "./ApiKeyGuideCard";
import { StealthPanel } from "./StealthPanel";

type SettingsPayload = {
  config: AppConfigPublic;
  providers: ProviderSettings;
};

async function apiErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: string | { message?: string } };
    if (typeof payload.error === "string") return payload.error;
    if (payload.error?.message) return payload.error.message;
  } catch {
    // Use fallback below.
  }
  return fallback;
}

function PanelHeader({
  eyebrow,
  icon,
  title,
}: {
  eyebrow: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <header className="panel-header">
      <div className="panel-header-icon">{icon}</div>
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h3>{title}</h3>
      </div>
    </header>
  );
}

export function SettingsPage() {
  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [primaryStack, setPrimaryStack] = useState<ProviderPresetId>("nvidia");
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [customModels, setCustomModels] = useState<NonNullable<AppConfigPreferences["customModels"]>>({});
  const [llmDraft, setLlmDraft] = useState<LlmRuntimeConfig | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const preset = PROVIDER_PRESETS[primaryStack];
  const resolvedModels = useMemo(
    () => resolveModels(preset, customModels),
    [preset, customModels],
  );

  const loadSettings = async () => {
    const response = await fetch("/api/settings/config");
    if (!response.ok) {
      setStatus(await apiErrorMessage(response, "Settings could not be loaded."));
      return;
    }
    const data = (await response.json()) as SettingsPayload;
    setPayload(data);
    setPrimaryStack(data.config.preferences.primaryStack);
    setCustomModels(data.config.preferences.customModels || {});
    setLlmDraft(data.config.llm);
    setKeyDrafts({});
    setStatus("");
  };

  useEffect(() => {
    void loadSettings();
  }, []);

  const endpointPreviews = useMemo(
    () => new Map((payload?.config.endpoints || []).map((endpoint) => [endpoint.id, endpoint.apiKey])),
    [payload?.config.endpoints],
  );

  const saveSettings = async () => {
    if (!llmDraft) return;

    const keys = Object.fromEntries(
      Object.entries(keyDrafts).filter(([, value]) => value.trim()),
    );

    setIsSaving(true);
    setStatus("Saving settings...");
    const response = await fetch("/api/settings/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        primaryStack,
        keys,
        customModels,
        llm: llmDraft,
      }),
    });
    setIsSaving(false);

    if (!response.ok) {
      setStatus(await apiErrorMessage(response, "Settings could not be saved."));
      return;
    }

    const data = (await response.json()) as SettingsPayload;
    setPayload(data);
    setPrimaryStack(data.config.preferences.primaryStack);
    setCustomModels(data.config.preferences.customModels || {});
    setLlmDraft(data.config.llm);
    setKeyDrafts({});
    setStatus("Settings saved.");
  };

  const selectStack = (stackId: ProviderPresetId) => {
    setPrimaryStack(stackId);
    setCustomModels({});
  };

  if (!payload || !llmDraft) {
    return (
      <section className="page-shell settings-page" id="page-settings" role="tabpanel" aria-label="Settings">
        <div className="page-heading">
          <div>
            <span className="eyebrow">Settings</span>
            <h2>Settings</h2>
          </div>
        </div>
        <p className="live-notice" role="status">{status || "Loading settings..."}</p>
      </section>
    );
  }

  const modelFields = modelFieldsForStack(primaryStack);

  return (
    <section className="page-shell settings-page" id="page-settings" role="tabpanel" aria-label="Settings">
      <div className="page-heading">
        <div>
          <span className="eyebrow">Settings</span>
          <h2>Settings</h2>
          <p className="page-lede">
            Pick a provider and paste your API key. Keys stay on your machine.
          </p>
        </div>
        <button className="primary-action" type="button" onClick={() => void saveSettings()} disabled={isSaving}>
          <Check size={17} />
          Save
        </button>
      </div>

      <div className="settings-grid settings-grid-simple">
        <section className="settings-section settings-section-wide">
          <PanelHeader eyebrow="Setup" icon={<Sparkles size={18} />} title="Choose your AI provider" />
          <div className="settings-stack-grid">
            {presetList().map((option) => (
              <button
                className={`settings-stack-card ${primaryStack === option.id ? "active" : ""}`}
                key={option.id}
                type="button"
                onClick={() => selectStack(option.id)}
              >
                <strong>
                  {option.label}
                  {option.id === "nvidia" && <span className="settings-default-badge">Default</span>}
                </strong>
                <span>{option.tagline}</span>
              </button>
            ))}
          </div>
          {preset.notes?.map((note) => (
            <p className="settings-note" key={note}>{note}</p>
          ))}
        </section>

        <section className="settings-section settings-section-wide">
          <PanelHeader eyebrow="Credentials" icon={<KeyRound size={18} />} title="API keys" />
          <p className="settings-note">Leave a field blank to keep the saved key.</p>
          <div className="api-keys-grid">
            {preset.keys.map((keyField) => {
              const preview = endpointPreviews.get(keyField.endpointId);
              const guide = apiKeyGuideForEndpoint(keyField.endpointId);
              return (
                <div className="settings-key-block" key={keyField.endpointId}>
                  <label className="field-control">
                    <span>
                      {keyField.label}
                      {keyField.optional ? " (optional)" : ""}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={preview?.configured ? preview.preview : keyField.optional ? "Not configured" : "Paste your API key"}
                      value={keyDrafts[keyField.endpointId] || ""}
                      onChange={(event) => setKeyDrafts((current) => ({
                        ...current,
                        [keyField.endpointId]: event.target.value,
                      }))}
                    />
                  </label>
                  {guide && <ApiKeyGuideCard guide={guide} compact />}
                </div>
              );
            })}
          </div>
        </section>

        <section className="settings-section settings-section-wide settings-summary-card">
          <h4>What will run</h4>
          <ul className="settings-summary-list">
            <li><span>Answers</span><strong>{resolvedModels.llm}</strong></li>
            <li><span>Live answers</span><strong>{resolvedModels.llmLive}</strong></li>
            <li><span>Live captions</span><strong>{resolvedModels.stt}</strong></li>
            <li><span>Document search</span><strong>{resolvedModels.embeddings}</strong></li>
          </ul>
        </section>

        <StealthPanel />

        <section className="settings-section settings-section-wide">
          <button
            className="settings-collapse-trigger"
            type="button"
            aria-expanded={showModels}
            onClick={() => setShowModels((current) => !current)}
          >
            <span>Customize models</span>
            <ChevronDown size={18} className={showModels ? "open" : ""} />
          </button>
          {showModels && (
            <div className="settings-fields-grid settings-fields-grid-compact">
              {modelFields.map((field) => (
                <label className="field-control" key={field.key}>
                  <span>{field.label}</span>
                  <input
                    value={customModels[field.key] || ""}
                    placeholder={field.hint}
                    onChange={(event) => setCustomModels((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }))}
                  />
                </label>
              ))}
            </div>
          )}
        </section>

        <section className="settings-section settings-section-wide">
          <button
            className="settings-collapse-trigger"
            type="button"
            aria-expanded={showQuality}
            onClick={() => setShowQuality((current) => !current)}
          >
            <span>Response quality</span>
            <ChevronDown size={18} className={showQuality ? "open" : ""} />
          </button>
          {showQuality && (
            <div className="settings-fields-grid settings-fields-grid-compact">
              <label className="field-control">
                <span>Max tokens (general)</span>
                <select
                  value={llmDraft.maxTokens}
                  onChange={(event) => setLlmDraft({ ...llmDraft, maxTokens: Number(event.target.value) })}
                >
                  {maxTokenOptions.map((value) => (
                    <option key={value} value={value}>{value.toLocaleString()}</option>
                  ))}
                </select>
              </label>
              <label className="field-control">
                <span>Max tokens (live answers)</span>
                <select
                  value={llmDraft.answerMaxTokens}
                  onChange={(event) => setLlmDraft({ ...llmDraft, answerMaxTokens: Number(event.target.value) })}
                >
                  {maxTokenOptions.map((value) => (
                    <option key={value} value={value}>{value.toLocaleString()}</option>
                  ))}
                </select>
              </label>
              <label className="field-control">
                <span>Thinking budget (general)</span>
                <select
                  value={llmDraft.thinkingBudget}
                  onChange={(event) => {
                    const thinkingBudget = Number(event.target.value);
                    setLlmDraft({ ...llmDraft, thinkingBudget, enableThinking: thinkingBudget > 0 });
                  }}
                >
                  {thinkingBudgetOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="field-control">
                <span>Thinking budget (live answers)</span>
                <select
                  value={llmDraft.answerThinkingBudget}
                  onChange={(event) => {
                    const answerThinkingBudget = Number(event.target.value);
                    setLlmDraft({ ...llmDraft, answerThinkingBudget, answerEnableThinking: answerThinkingBudget > 0 });
                  }}
                >
                  {thinkingBudgetOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </section>
      </div>

      {status && <p className="live-notice" role="status">{status}</p>}
    </section>
  );
}
