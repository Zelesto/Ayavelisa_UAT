import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, ArrowRight, ArrowUpRight, BriefcaseBusiness, CheckCircle2,
  ClipboardList, CloudOff, MapPin, Plus, RefreshCw, ShieldCheck, Users,
} from "lucide-react";
import { navigate } from "@/lib/router";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import {
  ActivityItem, MetricCard, SectionEyebrow, StatusPill, useToast,
} from "@/components/ui";
import type { Activity } from "@/lib/types";

type OverviewData = {
  branch: { id: string; name: string } | null;
  counts: {
    households: number;
    inFlight: number;
    completedVisits: number;
    exceptions: number;
    totalVisits: number;
    verified: number;
    subsidyApproved: number;
    ready: number;
    needsAttention: number;
  };
  projects: Array<{
    name: string;
    cases: number;
    location: string;
    verified: number;
    subsidyApproved: number;
    ready: number;
  }>;
  actions: Array<{
    id: string;
    name: string;
    nextAction: string;
    readiness: string;
    updated: string;
  }>;
  activities: Activity[];
  sync: { pendingUploads: number; lastSync: string | null };
};

const number = (value: number) => value.toLocaleString("en-ZA");

function fmtTime(iso: string | null) {
  if (!iso) return "Not yet";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Not yet"
    : date.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
}

export default function Overview({ onNewIntake }: { onNewIntake: () => void }) {
  const { isSyncing, runSync, activeBranch } = useStore();
  const { notify } = useToast();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.get<OverviewData>("/api/overview"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load branch overview.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, activeBranch?.id]);

  const handleSync = async () => {
    try {
      await runSync();
      notify("Sync complete");
      await refresh();
    } catch (syncError) {
      notify(syncError instanceof Error ? syncError.message : "Sync failed", "error");
    }
  };

  const counts = data?.counts;
  const project = data?.projects[0];

  return (
    <>
      <div className="page-heading">
        <div>
          <SectionEyebrow>{activeBranch?.name ?? "Branch"} / Overview</SectionEyebrow>
          <h1>Delivery control room</h1>
          <p>Current cases, visits, and actions recorded for this branch.</p>
        </div>
        <div className="heading-actions">
          <button className="button button-quiet" type="button" onClick={handleSync} disabled={isSyncing || loading}>
            <RefreshCw size={16} />
            {isSyncing ? "Syncing…" : "Sync now"}
          </button>
          <button className="button button-primary" type="button" onClick={onNewIntake}>
            <Plus size={17} />
            New intake
          </button>
        </div>
      </div>

      <div className="notice-banner">
        <div className="notice-symbol"><ShieldCheck size={16} /></div>
        <div>
          <strong>Live branch data</strong>
          <span>Overview metrics are read from this branch’s saved workspace and visit records.</span>
        </div>
        <button type="button" className="notice-link" onClick={() => navigate("/configuration")}>
          Operating principles <ArrowRight size={14} />
        </button>
      </div>

      {error && (
        <div className="user-admin-message user-admin-error" role="alert">
          {error}
          <button type="button" className="text-button" onClick={() => void refresh()}>Retry</button>
        </div>
      )}

      {loading && !data ? (
        <div className="panel user-list-empty" role="status">Loading branch overview…</div>
      ) : (
        <>
          <div className="metric-grid">
            <MetricCard label="Active households" value={number(counts?.households ?? 0)} detail="in this branch" tone="ink" icon={Users} />
            <MetricCard label="Cases in flight" value={number(counts?.inFlight ?? 0)} detail="not yet ready for works" tone="sand" icon={ClipboardList} />
            <MetricCard label="Approved visits" value={number(counts?.completedVisits ?? 0)} detail={`of ${number(counts?.totalVisits ?? 0)} recorded`} tone="sage" icon={CheckCircle2} />
            <MetricCard label="Open exceptions" value={number(counts?.exceptions ?? 0)} detail="blockers and attention cases" tone="coral" icon={AlertTriangle} />
          </div>

          <div className="content-grid content-grid-main">
            <section className="panel feature-project">
              <div className="panel-header">
                <div>
                  <SectionEyebrow>Largest active project</SectionEyebrow>
                  <h2>{project?.name ?? "No project records yet"}</h2>
                </div>
              </div>
              {project ? (
                <>
                  <div className="project-meta">
                    <span><MapPin size={14} />{project.location || "Location not recorded"}</span>
                    <span><BriefcaseBusiness size={14} />{number(project.cases)} households</span>
                    <StatusPill label="Branch records" tone="success" />
                  </div>
                  <div className="project-stats">
                    <div><span>Internally verified</span><strong>{number(project.verified)}</strong><small>of {number(project.cases)} cases</small></div>
                    <div><span>Subsidy approved</span><strong>{number(project.subsidyApproved)}</strong><small>recorded in this branch</small></div>
                    <div><span>Ready for works</span><strong>{number(project.ready)}</strong><small>recorded in this branch</small></div>
                  </div>
                  <div className="project-footer">
                    <span><ShieldCheck size={15} />Values reflect saved case records</span>
                    <button className="text-button" type="button" onClick={() => navigate("/cases")}>
                      View branch cases <ArrowUpRight size={14} />
                    </button>
                  </div>
                </>
              ) : (
                <p className="user-list-empty">Cases added to this branch will appear here.</p>
              )}
            </section>

            <section className="panel action-panel">
              <div className="panel-header">
                <div>
                  <SectionEyebrow>Action queue</SectionEyebrow>
                  <h2>Needs a decision</h2>
                </div>
                <span className="queue-count">{number(data?.actions.length ?? 0)} shown</span>
              </div>
              {data?.actions.length ? data.actions.map((item) => (
                <button className="queue-item queue-item-button" type="button" key={item.id} onClick={() => navigate(`/cases/${encodeURIComponent(item.id)}`)}>
                  <div className={/Blocked|Exception/i.test(item.readiness) ? "queue-marker marker-coral" : "queue-marker marker-sand"} />
                  <div><strong>{item.nextAction}</strong><span>{item.id} · {item.name}</span></div>
                  <time>{item.updated}</time>
                </button>
              )) : (
                <div className="queue-item">
                  <div className="queue-marker marker-sage" />
                  <div><strong>No open actions</strong><span>No branch cases currently need a decision.</span></div>
                  <time>—</time>
                </div>
              )}
              <button type="button" className="panel-link" onClick={() => navigate("/cases?filter=Needs%20action")}>
                View branch cases <ArrowRight size={14} />
              </button>
            </section>
          </div>

          <section className="panel lifecycle-panel">
            <div className="panel-header lifecycle-header">
              <div><SectionEyebrow>Case status</SectionEyebrow><h2>Branch pipeline</h2></div>
            </div>
            <div className="lifecycle-row">
              {[
                { label: "Households", count: counts?.households ?? 0, tone: "ink", detail: "active case records" },
                { label: "Verified", count: counts?.verified ?? 0, tone: "sage", detail: "internally verified" },
                { label: "Subsidy approved", count: counts?.subsidyApproved ?? 0, tone: "sand", detail: "approved records" },
                { label: "Ready for works", count: counts?.ready ?? 0, tone: "blue", detail: "readiness recorded" },
                { label: "Needs attention", count: counts?.needsAttention ?? 0, tone: "coral", detail: "blocked or exception" },
              ].map((stage, index, stages) => (
                <div className="lifecycle-stage" key={stage.label}>
                  <div className={`lifecycle-circle circle-${stage.tone}`}><span>{number(stage.count)}</span></div>
                  <div className="lifecycle-stage-copy"><strong>{stage.label}</strong><span>{stage.detail}</span></div>
                  {index < stages.length - 1 && <ArrowRight className="lifecycle-arrow" size={16} />}
                </div>
              ))}
            </div>
          </section>

          <div className="content-grid content-grid-bottom">
            <section className="panel activity-panel">
              <div className="panel-header">
                <div><SectionEyebrow>Traceable activity</SectionEyebrow><h2>Recent movement</h2></div>
              </div>
              <div className="activity-list">
                {data?.activities.length ? data.activities.map((item) => <ActivityItem key={item.id} item={item} />) : (
                  <p className="user-list-empty">No activity has been recorded for this branch yet.</p>
                )}
              </div>
            </section>

            <section className="panel offline-panel">
              <div className="offline-top">
                <div className="offline-icon"><CloudOff size={20} /></div>
                <div><SectionEyebrow>Field operations</SectionEyebrow><h2>Visit sync status</h2></div>
                <StatusPill label={(data?.sync.pendingUploads ?? 0) === 0 ? "Synced" : "Ready to sync"} tone={(data?.sync.pendingUploads ?? 0) === 0 ? "success" : "warning"} />
              </div>
              <div className="offline-stats">
                <div><strong>{number(counts?.totalVisits ?? 0)}</strong><span>branch visits</span></div>
                <div><strong>{number(data?.sync.pendingUploads ?? 0)}</strong><span>pending uploads</span></div>
                <div><strong>{fmtTime(data?.sync.lastSync ?? null)}</strong><span>last sync</span></div>
              </div>
              <p>Visits and uploads shown here are limited to the selected branch.</p>
              <button className="button button-outline full-width" type="button" onClick={handleSync} disabled={isSyncing || loading}>
                <RefreshCw size={15} />
                {isSyncing ? "Syncing…" : "Refresh branch sync"}
              </button>
            </section>
          </div>
        </>
      )}
    </>
  );
}
