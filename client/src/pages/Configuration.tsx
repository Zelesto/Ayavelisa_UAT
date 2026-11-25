import { useEffect, useState, type FormEvent } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { api, ApiError } from "@/lib/api";
import { SectionEyebrow, StatusPill, useToast } from "@/components/ui";
import { useAuth } from "@/components/AuthGate";

type EligibilityRule = {
  id: string;
  label: string;
  description: string;
  required: boolean;
  evidenceTypes: string[];
};

type BranchConfigurationData = {
  title: string;
  version: string;
  effectiveOn: string;
  owner: string;
  eligibilityRules: EligibilityRule[];
};

const blankConfiguration = (owner: string): BranchConfigurationData => ({
  title: "",
  version: "1.0",
  effectiveOn: "",
  owner,
  eligibilityRules: [],
});

export default function Configuration() {
  const { activeBranch, activeBranchId } = useStore();
  const { user } = useAuth();
  const { notify } = useToast();
  const [data, setData] = useState<BranchConfigurationData>(() => blankConfiguration(user?.name ?? ""));
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const canEdit = user?.role === "admin" || user?.role === "supervisor";

  useEffect(() => {
    if (!activeBranchId) return;
    let active = true;
    setLoading(true);
    setLoadError("");
    api.get<{ data: BranchConfigurationData | null; version: number }>("/api/configuration")
      .then((result) => {
        if (!active) return;
        setData(result.data ?? blankConfiguration(user?.name ?? ""));
        setVersion(result.version);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Could not load configuration.";
        setLoadError(message);
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [activeBranchId, user?.name]);

  const update = <K extends keyof BranchConfigurationData>(key: K, value: BranchConfigurationData[K]) => {
    setData((current) => ({ ...current, [key]: value }));
  };

  const updateRule = (id: string, patch: Partial<EligibilityRule>) => {
    setData((current) => ({
      ...current,
      eligibilityRules: current.eligibilityRules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule),
    }));
  };

  const addRule = () => {
    setData((current) => ({
      ...current,
      eligibilityRules: [...current.eligibilityRules, {
        id: crypto.randomUUID(),
        label: "",
        description: "",
        required: true,
        evidenceTypes: [],
      }],
    }));
  };

  const removeRule = (id: string) => {
    setData((current) => ({ ...current, eligibilityRules: current.eligibilityRules.filter((rule) => rule.id !== id) }));
  };

  const saveConfiguration = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeBranchId) return;
    setSaving(true);
    try {
      const saved = await api.put<{ data: BranchConfigurationData; version: number }>("/api/configuration", { version, data });
      setData(saved.data);
      setVersion(saved.version);
      notify("Branch checklist and eligibility rules saved");
    } catch (error) {
      const message = error instanceof ApiError && error.code === "configuration_conflict"
        ? "Configuration changed elsewhere. Reload the page before saving."
        : error instanceof Error ? error.message : "Could not save configuration.";
      notify(message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <SectionEyebrow>Governance / Configuration</SectionEyebrow>
          <h1>Checklist and eligibility</h1>
          <p>Manage the active programme checklist for {activeBranch?.name ?? "this branch"}.</p>
        </div>
        <div className="heading-actions">
          <StatusPill label={canEdit ? "Editable" : "View only"} tone={canEdit ? "success" : "neutral"} />
        </div>
      </div>

      {loading ? (
        <section className="panel config-loading" role="status">Loading branch configuration…</section>
      ) : loadError ? (
        <section className="panel config-loading" role="alert">
          <p>{loadError}</p>
          <button type="button" className="button button-quiet" onClick={() => window.location.reload()}>Reload configuration</button>
        </section>
      ) : (
        <form className="panel configuration-editor" onSubmit={(event) => void saveConfiguration(event)}>
          <div className="panel-header">
            <div>
              <SectionEyebrow>Branch-specific · version {data.version || "1.0"}</SectionEyebrow>
              <h2>Programme checklist</h2>
            </div>
            {canEdit && (
              <button type="submit" className="button button-primary" disabled={saving || !data.title.trim() || !data.effectiveOn}>
                <Save size={16} />{saving ? "Saving…" : "Save configuration"}
              </button>
            )}
          </div>

          <div className="configuration-fields">
            <label>
              <span>Programme / checklist name</span>
              <input value={data.title} onChange={(event) => update("title", event.target.value)} required minLength={2} maxLength={160} disabled={!canEdit} />
            </label>
            <label>
              <span>Version</span>
              <input value={data.version} onChange={(event) => update("version", event.target.value)} required maxLength={40} disabled={!canEdit} />
            </label>
            <label>
              <span>Effective date</span>
              <input type="date" value={data.effectiveOn} onChange={(event) => update("effectiveOn", event.target.value)} required disabled={!canEdit} />
            </label>
            <label>
              <span>Owner</span>
              <input value={data.owner} onChange={(event) => update("owner", event.target.value)} required minLength={2} maxLength={120} disabled={!canEdit} />
            </label>
          </div>

          <div className="configuration-rules-heading">
            <div>
              <h3>Eligibility and checklist requirements</h3>
              <p>{data.eligibilityRules.length} requirement{data.eligibilityRules.length === 1 ? "" : "s"} configured</p>
            </div>
            {canEdit && (
              <button type="button" className="button button-quiet" onClick={addRule}>
                <Plus size={16} />Add requirement
              </button>
            )}
          </div>

          {data.eligibilityRules.length === 0 ? (
            <div className="configuration-empty">
              <strong>No eligibility requirements configured</strong>
              <span>{canEdit ? "Add the rules and evidence required for this branch’s programme." : "An administrator or supervisor has not configured this branch’s checklist yet."}</span>
            </div>
          ) : (
            <div className="configuration-rules">
              {data.eligibilityRules.map((rule, index) => (
                <section className="configuration-rule" key={rule.id}>
                  <div className="configuration-rule-heading">
                    <strong>Requirement {index + 1}</strong>
                    {canEdit && (
                      <button type="button" className="icon-button small" aria-label={`Remove requirement ${index + 1}`} onClick={() => removeRule(rule.id)}>
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                  <div className="configuration-rule-fields">
                    <label>
                      <span>Requirement</span>
                      <input value={rule.label} onChange={(event) => updateRule(rule.id, { label: event.target.value })} required minLength={2} maxLength={160} disabled={!canEdit} />
                    </label>
                    <label>
                      <span>Evidence types <small>(comma separated)</small></span>
                      <input
                        value={rule.evidenceTypes.join(", ")}
                        onChange={(event) => updateRule(rule.id, { evidenceTypes: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })}
                        disabled={!canEdit}
                      />
                    </label>
                    <label className="configuration-rule-description">
                      <span>Eligibility guidance</span>
                      <textarea value={rule.description} onChange={(event) => updateRule(rule.id, { description: event.target.value })} rows={2} maxLength={1000} disabled={!canEdit} />
                    </label>
                    <label className="configuration-required">
                      <input type="checkbox" checked={rule.required} onChange={(event) => updateRule(rule.id, { required: event.target.checked })} disabled={!canEdit} />
                      <span>Required for eligibility</span>
                    </label>
                  </div>
                </section>
              ))}
            </div>
          )}

          {canEdit && (
            <div className="configuration-bottom-actions">
              <button type="submit" className="button button-primary" disabled={saving || !data.title.trim() || !data.effectiveOn}>
                <Save size={16} />{saving ? "Saving…" : "Save configuration"}
              </button>
            </div>
          )}
        </form>
      )}
    </>
  );
}
