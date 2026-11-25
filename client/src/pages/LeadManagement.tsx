import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CheckCircle2, Clock3, FileSpreadsheet,
  MapPin, Search, Users,
} from "lucide-react";
import { useStore } from "@/lib/store";
import type { BeneficiaryLead, LeadStatus } from "@/lib/types";
import { SectionEyebrow, useToast } from "@/components/ui";
import { useAuth } from "@/components/AuthGate";
import { api } from "@/lib/api";

const LEAD_STATUSES: LeadStatus[] = [
  "New",
  "Assigned",
  "Visit pending",
  "Survey in progress",
  "Survey submitted",
  "Unreachable",
  "Visit unsuccessful",
  "Refused participation",
  "On hold",
  "Converted",
];

function leadTone(status: LeadStatus) {
  if (status === "Converted" || status === "Survey submitted") return "success";
  if (status === "Visit pending" || status === "Assigned" || status === "Survey in progress") return "active";
  if (status === "Unreachable" || status === "Visit unsuccessful" || status === "Refused participation") return "attention";
  if (status === "On hold") return "muted";
  return "new";
}

function sourceTone(status: BeneficiaryLead["sourceStatus"]) {
  if (status === "Approved") return "success";
  if (status === "Failed searches") return "attention";
  if (status === "Query pending") return "muted";
  return "active";
}

function displayName(lead: BeneficiaryLead) {
  const names = lead.fullNames.trim();
  const surname = lead.surname.trim();
  const lastName = names.split(/\s+/).at(-1)?.toLowerCase();
  return surname && lastName !== surname.toLowerCase() ? `${names} ${surname}` : names || surname;
}

export default function LeadManagement() {
  const { leadImportBatches, beneficiaryLeads, assignLeads, importLeads, activeBranchId, currentUser } = useStore();
  const { user } = useAuth();
  const { notify } = useToast();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<LeadStatus | "All">("All");
  const [workers, setWorkers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [workersError, setWorkersError] = useState("");
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const canAssign = user?.role === "admin" || user?.role === "supervisor";
  const isFieldworker = user?.role === "fieldworker";

  useEffect(() => {
    if (!canAssign) return;
    let active = true;
    api.get<{ workers: Array<{ id: string; name: string; email: string }> }>("/api/branches/workers")
      .then(({ workers: available }) => { if (active) setWorkers(available); })
      .catch((error: unknown) => {
        if (active) setWorkersError(error instanceof Error ? error.message : "Could not load branch fieldworkers.");
      });
    return () => { active = false; };
  }, [activeBranchId, canAssign]);

  const filteredLeads = useMemo(() => {
    const search = query.trim().toLowerCase();
    return beneficiaryLeads.filter((lead) => {
      if (isFieldworker && lead.assignedTo !== user?.id && lead.assignedTo !== user?.name) return false;
      if (duplicatesOnly && !lead.duplicateFlag) return false;
      const matchesSearch = !search || [
        lead.fullNames,
        lead.surname,
        lead.leadRef,
        lead.project,
        lead.siteNo,
        lead.township,
        lead.assignedTo ?? "",
      ].some((value) => value.toLowerCase().includes(search));
      return matchesSearch && (statusFilter === "All" || lead.leadStatus === statusFilter);
    });
  }, [beneficiaryLeads, query, statusFilter, duplicatesOnly, isFieldworker, user?.id, user?.name]);

  const visibleLeads = isFieldworker
    ? beneficiaryLeads.filter((lead) => lead.assignedTo === user?.id || lead.assignedTo === user?.name)
    : beneficiaryLeads;
  const assignedCount = visibleLeads.filter((lead) => lead.assignedTo).length;
  const awaitingCount = visibleLeads.filter(
    (lead) => lead.leadStatus === "Visit pending" || lead.leadStatus === "Assigned",
  ).length;
  const duplicateCount = visibleLeads.filter((lead) => lead.duplicateFlag).length;

  const importLeadFile = async (file: File) => {
    setImporting(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: false });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error("The selected workbook has no sheets.");
      const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
      const get = (row: Record<string, unknown>, aliases: string[]) => {
        const values = new Map(Object.entries(row).map(([key, value]) => [
          key.toLowerCase().replace(/[^a-z0-9]/g, ""),
          String(value ?? "").trim(),
        ]));
        for (const alias of aliases) {
          const value = values.get(alias.toLowerCase().replace(/[^a-z0-9]/g, ""));
          if (value) return value;
        }
        return "";
      };
      const rows = sourceRows.flatMap((row) => {
        const fullNames = get(row, ["full names", "first name", "given names", "names", "applicant name", "beneficiary name"]);
        const surname = get(row, ["surname", "last name", "family name"]);
        const project = get(row, ["project", "project name"]);
        if ((!fullNames && !surname) || !project) return [];
        return [{
          project,
          programme: get(row, ["programme", "program", "subsidy"]) || "Not specified",
          surname,
          fullNames,
          idNo: get(row, ["id number", "id no", "identity number"]),
          siteNo: get(row, ["site number", "site no", "plot", "plot number"]),
          township: get(row, ["township", "ward", "area", "location"]),
          sourceData: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value ?? "")])),
        }];
      });
      if (!rows.length) throw new Error("No usable beneficiaries found. Include name/surname and project columns.");
      const rejected = sourceRows.length - rows.length;
      const result = importLeads(file.name, rows, rejected);
      notify(`Imported ${result.accepted} beneficiary lead(s); ${result.duplicates} possible duplicate(s) flagged${rejected ? `; skipped ${rejected} invalid row(s)` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not import beneficiary list", "error");
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="page-stack lead-workspace">
      <header className="lead-hero">
        <div className="lead-hero-copy">
          <SectionEyebrow>Beneficiary leads · Departmental intake</SectionEyebrow>
          <h1>Lead management</h1>
          <p>Track incoming beneficiary records and field follow-up in one place.</p>
        </div>
        <div className="lead-hero-actions">
          <input
            ref={fileInput}
            className="sr-only"
            type="file"
            accept=".csv,.xlsx,.xls"
            aria-label="Import beneficiary file"
            disabled={!canAssign || importing}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importLeadFile(file);
            }}
          />
          <button
            type="button"
            className="button button-quiet"
            onClick={() => setDuplicatesOnly((value) => !value)}
          >
            <CheckCircle2 size={15} />{duplicatesOnly ? "Show all leads" : "Review duplicates"}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={!canAssign || importing}
            onClick={() => fileInput.current?.click()}
          >
            <FileSpreadsheet size={15} />{importing ? "Importing…" : "Import lead list"}
          </button>
        </div>
      </header>

      <section className="lead-metrics" aria-label="Lead summary">
        <article className="lead-metric">
          <span className="lead-metric-icon lead-icon-ink"><Users size={17} /></span>
          <div><span>Total leads</span><strong>{visibleLeads.length}</strong></div>
          <small>in the register</small>
        </article>
        <article className="lead-metric">
          <span className="lead-metric-icon lead-icon-sage"><CheckCircle2 size={17} /></span>
          <div><span>Assigned</span><strong>{assignedCount}</strong></div>
          <small>with a fieldworker</small>
        </article>
        <article className="lead-metric">
          <span className="lead-metric-icon lead-icon-sand"><Clock3 size={17} /></span>
          <div><span>Awaiting visit</span><strong>{awaitingCount}</strong></div>
          <small>ready for follow-up</small>
        </article>
        <article className="lead-metric">
          <span className="lead-metric-icon lead-icon-coral"><AlertTriangle size={17} /></span>
          <div><span>Duplicate flags</span><strong>{duplicateCount}</strong></div>
          <small>need a review</small>
        </article>
      </section>

      <section className="panel lead-panel">
        <div className="lead-section-heading">
          <div>
            <SectionEyebrow>Field allocation</SectionEyebrow>
            <h2>Beneficiary leads</h2>
            <p>{canAssign ? "Search the register, review duplicates, assign fieldworkers, or import a source file." : "Your assigned beneficiary follow-up records."}</p>
          </div>
          <span className="lead-result-count">{filteredLeads.length} of {visibleLeads.length}</span>
        </div>

        <div className="lead-toolbar">
          <label className="lead-search">
            <Search size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, lead, project or site"
              aria-label="Search beneficiary leads"
            />
          </label>
          <label className="lead-filter">
            <span>Status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as LeadStatus | "All")}
              aria-label="Filter leads by status"
            >
              <option value="All">All statuses</option>
              {LEAD_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </label>
        </div>
        {canAssign && workersError && <p className="auth-error" role="alert">{workersError}</p>}

        {filteredLeads.length > 0 ? (
          <div className="lead-card-grid">
            {filteredLeads.map((lead) => (
              <article className="lead-card" key={lead.id}>
                <div className="lead-card-top">
                  <div className="lead-avatar" aria-hidden="true">
                    {lead.fullNames.trim().charAt(0)}{lead.surname.trim().charAt(0)}
                  </div>
                  <div className="lead-card-person">
                    <h3>{displayName(lead)}</h3>
                    <span>{lead.leadRef}</span>
                  </div>
                  <span className={`lead-status lead-status-${leadTone(lead.leadStatus)}`}>{lead.leadStatus}</span>
                </div>

                <div className="lead-card-details">
                  <div>
                    <span>Project</span>
                    <strong>{lead.project}</strong>
                  </div>
                  <div>
                    <span>Site / area</span>
                    <strong><MapPin size={13} />{lead.siteNo || lead.township || "Not recorded"}</strong>
                  </div>
                </div>

                <div className="lead-card-footer">
                  <div className="lead-assignee">
                    <span>Assigned to</span>
                    {canAssign ? (
                      <select
                        value={lead.assignedTo ?? ""}
                        aria-label={`Assign ${displayName(lead)}`}
                        disabled={!workers.length}
                        onChange={(event) => assignLeads([lead.id], event.target.value || null)}
                      >
                        <option value="">Unassigned</option>
                        {workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}
                      </select>
                    ) : (
                      <strong>{workers.find((worker) => worker.id === lead.assignedTo)?.name ?? (lead.assignedTo === user?.id ? currentUser.name : lead.assignedTo ?? "Unassigned")}</strong>
                    )}
                  </div>
                  <div className="lead-card-flags">
                    <span className={`lead-status lead-status-${sourceTone(lead.sourceStatus)}`}>{lead.sourceStatus}</span>
                    {lead.duplicateFlag && <span className="lead-duplicate"><AlertTriangle size={12} /> Duplicate</span>}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="lead-empty">
            <span><Search size={19} /></span>
            <h3>{visibleLeads.length ? "No leads match your search" : "No beneficiary leads yet"}</h3>
            <p>{visibleLeads.length ? (workersError || "Try a different name or status filter.") : canAssign ? "Import a CSV or Excel file to add beneficiary leads." : "No beneficiary leads are assigned to your account yet."}</p>
            {(query || statusFilter !== "All") && (
              <button type="button" className="button button-quiet" onClick={() => { setQuery(""); setStatusFilter("All"); }}>
                Clear filters
              </button>
            )}
          </div>
        )}
      </section>

      <section className="panel lead-panel lead-batches">
        <div className="lead-section-heading">
          <div>
            <SectionEyebrow>Import history</SectionEyebrow>
            <h2>Source batches</h2>
            <p>Every lead stays linked to its original departmental list.</p>
          </div>
          <span className="lead-result-count">{leadImportBatches.length} {leadImportBatches.length === 1 ? "batch" : "batches"}</span>
        </div>

        {leadImportBatches.length > 0 ? (
          <div className="batch-card-grid">
            {leadImportBatches.map((batch) => (
              <article className="batch-card" key={batch.id}>
                <div className="batch-card-top">
                  <span className="batch-icon"><FileSpreadsheet size={16} /></span>
                  <span className="lead-status lead-status-success">Accepted</span>
                </div>
                <span className="batch-reference">{batch.batchRef}</span>
                <h3>{batch.project}</h3>
                <p className="batch-file" title={batch.sourceFileName}>{batch.sourceFileName}</p>
                <div className="batch-card-stats">
                  <div><strong>{batch.rowCount}</strong><span>Rows</span></div>
                  <div><strong>{batch.acceptedCount}</strong><span>Accepted</span></div>
                  <div><strong>{batch.rejectedCount + batch.duplicateCount}</strong><span>Needs review</span></div>
                </div>
                <div className="batch-card-footer">
                  <span>{batch.importingUser}</span>
                  <time dateTime={batch.importedAt}>
                    {new Date(batch.importedAt).toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric" })}
                  </time>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="lead-empty lead-empty-compact">
            <span><FileSpreadsheet size={19} /></span>
            <h3>No import batches yet</h3>
            <p>Departmental lead batches will appear here once imported.</p>
          </div>
        )}
      </section>
    </div>
  );
}
