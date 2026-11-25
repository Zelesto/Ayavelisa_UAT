import { useEffect, useState } from "react";
import {
  ArrowRight, Bell, CalendarDays, ChevronDown, ClipboardCheck, ClipboardList, Database, FileText,
  LayoutDashboard, Map, Menu, MoreHorizontal,
  SlidersHorizontal, Users, Wifi, WifiOff, X,
} from "lucide-react";
import { navigate, useRoute } from "@/lib/router";
import { StoreProvider, useStore, USERS } from "@/lib/store";
import { supabase } from "@/lib/supabase";
import { ToastProvider, cx } from "@/components/ui";
import AuthGate, { useAuth } from "@/components/AuthGate";
import { ROLE_LABELS, rolePersona, userInitials, type AccountRole } from "@/lib/auth";
import Overview from "@/pages/Overview";
import Cases from "@/pages/Cases";
import CaseDetail from "@/pages/CaseDetail";
import Sites from "@/pages/Sites";
import Reports from "@/pages/Reports";
import Configuration from "@/pages/Configuration";
import LeadManagement from "@/pages/LeadManagement";
import FieldHome from "@/pages/FieldHome";
import MyVisits from "@/pages/MyVisits";
import VisitCapture from "@/pages/VisitCapture";
import ReviewQueue from "@/pages/ReviewQueue";
import IntakeReview from "@/pages/IntakeReview";
import FieldIntake from "@/pages/FieldIntake";
import UserManagement from "@/pages/UserManagement";
import Profile from "@/pages/Profile";
import type { Persona } from "@/lib/types";

type NavItem = { label: string; icon: typeof LayoutDashboard; path: string; count?: string; forPersona?: Persona[] };

const HOME: Record<Persona, string> = {
  fieldworker: "/field",
  supervisor: "/",
  reviewer: "/review",
};

function canAccessPath(role: AccountRole | null, path: string) {
  if (!role) return true;
  const pathname = path.split("?")[0];
  if (pathname === "/profile") return true;
  if (role === "admin" || role === "supervisor") return pathname !== "/users" || role === "admin";
  if (role === "reviewer") {
    return pathname === "/" || ["/review", "/review/intake", "/cases", "/leads", "/sites", "/reports", "/configuration"].some((allowed) =>
      pathname === allowed || pathname.startsWith(`${allowed}/`),
    );
  }
  return pathname === "/" || pathname === "/field" || pathname === "/field/visits" || pathname.startsWith("/field/visits/")
    || pathname === "/leads" || pathname === "/intake" || pathname.startsWith("/intake/");
}

function Shell() {
  const { path } = useRoute();
  const { user, protectedMode } = useAuth();
  const {
    sync, isSyncing, isOnline, persona: localPersona, setPersona, currentUser, databaseStatus,
    databaseError, retryDatabase, branches, activeBranch, activeBranchId, branchesLoading,
    branchError, selectBranch,
  } = useStore();
  const persona = user ? rolePersona(user.role) : localPersona;
  const displayUser = user
    ? { name: user.name, role: ROLE_LABELS[user.role], initials: userInitials(user.name, user.email) }
    : currentUser;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (path === "/" && (persona === "fieldworker" || persona === "reviewer")) navigate(HOME[persona]);
  }, [path, persona]);

  if (branchesLoading) {
    return (
      <main className="database-loading" role="status">
        <Database size={22} />
        <strong>Loading your branches</strong>
        <span>Checking your branch access…</span>
      </main>
    );
  }
  if (branchError) {
    return (
      <main className="database-loading" role="alert">
        <Database size={22} />
        <strong>Could not load your branches</strong>
        <span>{branchError}</span>
        <button className="button button-primary" type="button" onClick={() => void retryDatabase()}>Try again</button>
      </main>
    );
  }
  if (branches.length > 1 && !activeBranch) {
    return (
      <main className="branch-landing">
        <div className="branch-landing-card">
          <div className="brand-mark"><span>A</span><span>V</span></div>
          <span className="section-eyebrow">Ayavelisa workspace</span>
          <h1>Select a branch</h1>
          <p>Choose the branch workspace you want to open. You can switch branches later from the sidebar.</p>
          <div className="branch-landing-list">
            {branches.map((branch) => (
              <button key={branch.id} type="button" className="branch-landing-option" onClick={() => selectBranch(branch.id)}>
                <span className="workspace-dot" />
                <span><strong>{branch.name}</strong>{branch.isDefault && <small>Default branch</small>}</span>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </div>
      </main>
    );
  }
  if (databaseStatus === "loading") {
    return (
      <main className="database-loading" role="status">
        <Database size={22} />
        <strong>Opening {activeBranch?.name ?? "your workspace"}</strong>
        <span>Connecting to the database…</span>
      </main>
    );
  }

  const nav: NavItem[] = persona === "fieldworker"
    ? [
        { label: "Today", icon: LayoutDashboard, path: "/field" },
        { label: "My visits", icon: ClipboardList, path: "/field/visits" },
        { label: "Assigned leads", icon: FileText, path: "/leads" },
      ]
    : persona === "reviewer"
      ? [
          { label: "Review queue", icon: ClipboardCheck, path: "/review" },
          { label: "Intake review", icon: ClipboardList, path: "/review/intake" },
          { label: "Cases", icon: Users, path: "/cases" },
          { label: "Beneficiary leads", icon: FileText, path: "/leads" },
          { label: "Sites", icon: Map, path: "/sites" },
          { label: "Reports", icon: FileText, path: "/reports" },
        ]
      : [
          { label: "Overview", icon: LayoutDashboard, path: "/" },
          { label: "Cases", icon: Users, path: "/cases" },
          { label: "Beneficiary leads", icon: FileText, path: "/leads" },
          { label: "Review queue", icon: ClipboardCheck, path: "/review" },
          { label: "Intake review", icon: ClipboardList, path: "/review/intake" },
          { label: "Sites & readiness", icon: Map, path: "/sites" },
          { label: "Reports", icon: FileText, path: "/reports" },
          { label: "Configuration", icon: SlidersHorizontal, path: "/configuration" },
          ...(user?.role === "admin" ? [{ label: "Users & roles", icon: Users, path: "/users" }] : []),
        ];

  const activePath = path;
  const caseMatch = path.match(/^\/cases\/([^/]+)$/);
  const visitMatch = path.match(/^\/field\/visits\/([^/]+)$/);
  const intakeMatch = path.match(/^\/intake\/([^/]+)$/);

  const content = (() => {
    if (!canAccessPath(user?.role ?? null, path)) {
      return (
        <div className="missing-state">
          <h2>Access restricted</h2>
          <p>Your {user ? ROLE_LABELS[user.role].toLowerCase() : "current"} account does not have permission to open this screen.</p>
          <button className="button button-primary" type="button" onClick={() => navigate(HOME[persona])}>Go to my home</button>
        </div>
      );
    }
    if (path === "/field") return <FieldHome />;
    if (path === "/field/visits") return <MyVisits />;
    if (visitMatch) return <VisitCapture visitId={decodeURIComponent(visitMatch[1])} />;
    if (path === "/review") return <ReviewQueue />;
    if (path === "/review/intake") return <IntakeReview />;
    if (path === "/intake") return <FieldIntake />;
    if (intakeMatch) return <FieldIntake intakeId={decodeURIComponent(intakeMatch[1])} />;
    if (path === "/leads") return <LeadManagement />;
    if (path === "/") return persona === "fieldworker" ? <FieldHome /> : <Overview onNewIntake={() => navigate("/intake")} />;
    if (path === "/cases") return <Cases onNewIntake={() => navigate("/intake")} />;
    if (caseMatch) return <CaseDetail caseId={decodeURIComponent(caseMatch[1])} />;
    if (path === "/sites") return <Sites />;
    if (path === "/reports") return <Reports />;
    if (path === "/configuration") return <Configuration />;
    if (path === "/users") return <UserManagement />;
    if (path === "/profile") return <Profile />;
    return (
      <div className="missing-state">
        <h2>Page not found</h2>
        <p>The route {path} is not registered.</p>
        <button className="button button-primary" type="button" onClick={() => navigate(HOME[persona])}>Go home</button>
      </div>
    );
  })();

  const switchTo = (p: Persona) => {
    setPersona(p);
    navigate(HOME[p]);
    setMobileNavOpen(false);
  };

  const breadcrumbLabel = (() => {
    if (path === "/profile") return "Profile";
    if (caseMatch) return "Case file";
    if (visitMatch) return "Visit capture";
    if (path === "/intake" || intakeMatch) return "New intake";
    if (path === "/review/intake") return "Intake review";
    return nav.find((n) => path === n.path)?.label
      ?? (path === "/review" ? "Review queue" : "Field");
  })();

  return (
    <div className="app-shell">
      <aside id="main-sidebar" className={cx("sidebar", mobileNavOpen && "sidebar-open", sidebarCollapsed && "sidebar-collapsed")}>
        <div className="brand">
          <div className="brand-mark"><span>A</span><span>V</span></div>
          <div><strong>ayavelisa</strong><span>human settlements</span></div>
          <button className="mobile-close icon-button" type="button" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X size={17} /></button>
        </div>
        <div className="sidebar-context">
          <span className="context-label">WORKSPACE</span>
          <label className="workspace-select-label">
            <span className="workspace-dot" />
            <select
              className="workspace-switch"
              value={activeBranchId ?? ""}
              onChange={(event) => selectBranch(event.target.value)}
              disabled={databaseStatus === "saving"}
              aria-label="Select workspace branch"
              title={activeBranch?.name}
            >
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}{branch.isDefault ? " · Default" : ""}</option>)}
            </select>
            <ChevronDown size={14} />
          </label>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          {nav.map(({ label, icon: Icon, count, path: p }) => (
            <button
              type="button" key={label}
              className={cx("nav-item", (activePath === p || (p !== "/" && activePath.startsWith(`${p}/`))) && "nav-active")}
              onClick={() => { setMobileNavOpen(false); navigate(p); }}
              title={sidebarCollapsed ? label : undefined}
              aria-label={label}
            >
              <Icon size={17} strokeWidth={1.8} /><span>{label}</span>{count && <em>{count}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-rule" />
        <div className="sidebar-section-label">QUICK ACCESS</div>
        <button type="button" className="nav-item" title={sidebarCollapsed ? "My assignments" : undefined} aria-label="My assignments" onClick={() => { setMobileNavOpen(false); navigate(persona === "fieldworker" ? "/field/visits?filter=To do" : "/cases?filter=Needs%20action"); }}>
          <ClipboardCheck size={17} strokeWidth={1.8} /><span>My assignments</span><em className="nav-alert">8</em>
        </button>
        <button type="button" className="nav-item" title={sidebarCollapsed ? "Notifications" : undefined} aria-label="Notifications"><Bell size={17} strokeWidth={1.8} /><span>Notifications</span><em className="nav-alert">3</em></button>
        <div className="sidebar-bottom">
          <button type="button" className="role-card role-card-button" onClick={() => navigate("/profile")} aria-label="Open profile" title={sidebarCollapsed ? `${displayUser.name} · ${displayUser.role}` : "Open profile"}>
            <div className="avatar">{displayUser.initials}</div>
            <div><strong>{displayUser.name}</strong><span>{displayUser.role}</span></div>
            <MoreHorizontal className="role-menu-icon" size={16} />
          </button>
          <div className="sidebar-footer">
            <span title={isOnline ? "Connected" : "Offline"}>{isOnline ? <><Wifi size={13} />Connected</> : <><WifiOff size={13} />Offline</>}</span>
            <span className="sidebar-version">v0.3 demo</span>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-leading">
            <button
              className="sidebar-toggle icon-button"
              type="button"
              onClick={() => {
                if (window.matchMedia("(max-width: 680px)").matches) {
                  setMobileNavOpen((open) => !open);
                } else {
                  setSidebarCollapsed((collapsed) => !collapsed);
                }
              }}
              aria-label={window.matchMedia("(max-width: 680px)").matches
                ? (mobileNavOpen ? "Close navigation" : "Open navigation")
                : (sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar")}
              aria-expanded={window.matchMedia("(max-width: 680px)").matches ? mobileNavOpen : !sidebarCollapsed}
              aria-controls="main-sidebar"
              title={window.matchMedia("(max-width: 680px)").matches
                ? (mobileNavOpen ? "Close navigation" : "Open navigation")
                : (sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar")}
            >
              <Menu size={19} />
            </button>
            <div className="breadcrumbs">
              <span>Ayavelisa</span><ArrowRight size={13} />
              <strong>{breadcrumbLabel}</strong>
            </div>
          </div>
          <div className="topbar-actions">
            {!protectedMode && <div className="persona-switcher">
              {(Object.keys(USERS) as Persona[]).map((p) => (
                <button
                  key={p} type="button" onClick={() => switchTo(p)}
                  className={cx("persona-chip", persona === p && "is-active")}
                  title={USERS[p].role}
                >
                  {USERS[p].initials}
                </button>
              ))}
            </div>}
            <span className="topbar-date"><CalendarDays size={14} />{new Date().toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" })}</span>
            <span className={cx("sync-state", isSyncing && "is-syncing", !isOnline && "is-offline")}>
              <span className="sync-dot" />
              {isSyncing ? "Syncing" : !isOnline ? "Offline" : sync.pendingUploads > 0 ? `${sync.pendingUploads} pending` : "All synced"}
            </span>
            <button
              type="button"
              className={cx("database-state", databaseStatus === "error" && "database-state-error", databaseStatus === "saving" && "database-state-saving")}
              onClick={() => { if (databaseStatus === "error") void retryDatabase(); }}
              disabled={databaseStatus !== "error"}
              title={databaseError ?? (databaseStatus === "saving" ? "Saving changes to PostgreSQL" : "All screen data is saved in PostgreSQL")}
              aria-live="polite"
            >
              <Database size={13} />
              {databaseStatus === "connected" ? "Database saved" : databaseStatus === "saving" ? "Saving to database" : "Database issue · Retry"}
            </button>
            {supabase && (
              <button type="button" className="topbar-user" aria-label="Open profile" title="Open profile"
                onClick={() => navigate("/profile")}>
                <span className="avatar avatar-small">{displayUser.initials}</span>
                <ChevronDown size={14} />
              </button>
            )}
          </div>
        </header>
        <main className="main-content">{content}</main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthGate>
      <StoreProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </StoreProvider>
    </AuthGate>
  );
}