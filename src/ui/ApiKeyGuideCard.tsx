import type { ApiKeyGuide } from "../shared/apiKeyGuides";

export function ApiKeyGuideCard({ guide, compact = false }: { guide: ApiKeyGuide; compact?: boolean }) {
  return (
    <aside className={`api-key-guide ${compact ? "compact" : ""}`}>
      <p className="api-key-guide-title">How to get your {guide.label} API key</p>
      <ol className="api-key-guide-steps">
        {guide.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <a className="api-key-guide-link" href={guide.url} rel="noreferrer" target="_blank">
        Open {guide.urlLabel}
      </a>
    </aside>
  );
}
