import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MailPlus, RefreshCw, ShieldCheck, Trash2, UserRound, UserRoundX } from "lucide-react";
import { SectionEyebrow, StatusPill } from "@/components/ui";
import { authorizedFetch } from "@/lib/supabase";
import { ROLE_LABELS, type AccountRole } from "@/lib/auth";
import { useStore } from "@/lib/store";
import type { Branch } from "@/lib/branches";

type ManagedUser = {
  id: string;
  email: string;
  name: string;
  role: AccountRole;
  active: boolean;
  createdAt: string;
  branchIds: string[];
  defaultBranchId: string | null;
  branches: Branch[];
};

const roles: AccountRole[] = ["fieldworker", "reviewer", "supervisor", "admin"];

function readableError(code: string | undefined, fallback: string) {
  if (code === "branch_name_already_exists") return "A branch with that name already exists.";
  if (code === "invalid_branch_assignment") return "Select active branches for this user.";
  if (code === "default_branch_must_be_assigned") return "The default branch must be included in the assigned branches.";
  if (code === "branch_assignment_required") return "Every user must have at least one branch.";
  if (code === "account_already_managed") return "This email is already in the Ayavelisa user list. Change its role there.";
  if (code === "auth_user_already_exists_unresolved") return "Supabase says this email already has an account, but Ayavelisa could not locate it. Verify the email in Supabase Auth and confirm the Render service-role key belongs to the same project.";
  if (code === "existing_auth_account_link_failed") return "The Supabase account exists, but Ayavelisa could not link it. Check the Render database and server logs.";
  if (code === "existing_auth_account_lookup_failed") return "Ayavelisa could not check for an existing Supabase account. Verify the server-only service-role key in Render.";
  if (code === "user_email_unavailable") return "Email delivery is not configured. Add the Supabase service-role key to Render.";
  if (code === "email_rate_limited") return "Supabase is temporarily limiting emails. Wait a few minutes or configure custom SMTP in Supabase Auth.";
  if (code === "email_delivery_not_configured") return "Supabase email delivery is unavailable. Configure a custom SMTP provider in Supabase Auth.";
  if (code === "access_email_failed") return "Supabase could not send the access email. Check the Supabase Auth email/SMTP settings and allowed redirect URLs.";
  if (code === "auth_account_not_found") return "The account is listed in Ayavelisa but was not found in Supabase Auth. Check that the Render service-role key points to the same project.";
  if (code === "account_inactive") return "Reactivate this account before sending an access email.";
  if (code === "email_sent_audit_failed") return "The email was sent, but Ayavelisa could not record the action. Check the recipient’s inbox before trying again, then inspect the server logs.";
  if (code === "cannot_remove_last_active_admin") return "At least one active administrator must remain.";
  if (code === "cannot_remove_own_admin_access") return "You cannot deactivate or demote your own administrator account.";
  if (code === "cannot_delete_own_account") return "You cannot delete your own administrator account.";
  if (code === "account_activation_unavailable") return "Could not activate this account. Check that the server-side Supabase service-role key is configured in Render.";
  if (code === "account_confirmation_failed") return "Supabase could not confirm this account. Check the server logs and confirm that the service-role key belongs to the correct project.";
  if (code === "account_email_mismatch") return "The account email in Supabase does not match the Ayavelisa user record. Contact an administrator before enabling login.";
  if (code === "account_update_failed") return "Supabase may have confirmed the email, but Ayavelisa could not finish updating the account. Refresh the user list and check the Render server logs.";
  if (code === "account_lookup_failed") return "Ayavelisa could not load this account from the database. Check the Render database connection and server logs.";
  if (code === "account_deletion_unavailable") return "Account deletion requires the server-side Supabase service-role key in Render.";
  if (code === "supabase_account_deletion_failed") return "Supabase could not delete this account. No Ayavelisa account changes were saved; check the server logs and try again.";
  if (code === "invite_sent_account_setup_failed") return "The invitation email was sent, but the account record could not be created. Contact support before inviting this email again.";
  return fallback;
}

export default function UserManagement() {
  const { activeBranch, refreshBranches } = useStore();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [draftRoles, setDraftRoles] = useState<Record<string, AccountRole>>({});
  const [draftBranchIds, setDraftBranchIds] = useState<Record<string, string[]>>({});
  const [draftDefaultBranches, setDraftDefaultBranches] = useState<Record<string, string>>({});
  const [draftBranchNames, setDraftBranchNames] = useState<Record<string, string>>({});
  const [branches, setBranches] = useState<Branch[]>([]);
  const [newBranchName, setNewBranchName] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AccountRole>("fieldworker");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authorizedFetch("/api/admin/users");
      const result = await response.json() as { users?: ManagedUser[]; error?: string };
      if (!response.ok || !result.users) throw new Error(readableError(result.error, "Could not load user accounts."));
      setUsers(result.users);
      setDraftRoles(Object.fromEntries(result.users.map((account) => [account.id, account.role])));
      setDraftBranchIds(Object.fromEntries(result.users.map((account) => [account.id, account.branchIds ?? []])));
      setDraftDefaultBranches(Object.fromEntries(result.users.map((account) => [
        account.id,
        account.defaultBranchId ?? account.branchIds?.[0] ?? "",
      ])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load user accounts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  const loadBranches = useCallback(async () => {
    try {
      const response = await authorizedFetch("/api/admin/branches");
      const result = await response.json() as { branches?: Branch[]; error?: string };
      if (!response.ok || !result.branches) throw new Error(readableError(result.error, "Could not load branches."));
      setBranches(result.branches);
      setDraftBranchNames(Object.fromEntries(result.branches.map((branch) => [branch.id, branch.name])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load branches.");
    }
  }, []);

  useEffect(() => { void loadBranches(); }, [loadBranches]);

  const updateBranchName = async (branch: Branch) => {
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch(`/api/admin/branches/${encodeURIComponent(branch.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: draftBranchNames[branch.id]?.trim() }),
      });
      const result = await response.json() as { branch?: Branch; error?: string };
      if (!response.ok || !result.branch) throw new Error(readableError(result.error, "Could not update branch name."));
      setNotice("Branch name updated.");
      await Promise.all([loadBranches(), refreshBranches({ keepActive: true })]);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update branch name.");
    }
  };

  const createBranch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreatingBranch(true);
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch("/api/admin/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newBranchName.trim() }),
      });
      const result = await response.json() as { branch?: Branch; error?: string };
      if (!response.ok || !result.branch) throw new Error(readableError(result.error, "Could not create branch."));
      setNewBranchName("");
      setNotice(`${result.branch.name} created and assigned to your account.`);
      await Promise.all([loadBranches(), loadUsers(), refreshBranches({ keepActive: true })]);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create branch.");
    } finally {
      setCreatingBranch(false);
    }
  };

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviting(true);
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          name: name.trim() || undefined,
          role,
          branchIds: activeBranch ? [activeBranch.id] : undefined,
          defaultBranchId: activeBranch?.id,
        }),
      });
      const result = await response.json() as { error?: string; linkedExisting?: boolean };
      if (!response.ok) throw new Error(readableError(result.error, "Could not invite this user."));
      setEmail("");
      setName("");
      setRole("fieldworker");
      setNotice(result.linkedExisting
        ? "Existing Supabase account added to Ayavelisa with the selected role. The user can sign in with their existing Supabase password."
        : "Invitation sent. The user must accept the email invitation and set their password.");
      await loadUsers();
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "Could not invite this user.");
    } finally {
      setInviting(false);
    }
  };

  const updateUser = async (account: ManagedUser, update: {
    role?: AccountRole;
    active?: boolean;
    branchIds?: string[];
    defaultBranchId?: string;
  }) => {
    setBusyId(account.id);
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch(`/api/admin/users/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      const result = await response.json() as { user?: ManagedUser; error?: string; loginAllowed?: boolean };
      if (!response.ok || !result.user) throw new Error(readableError(result.error, "Could not update this account."));
      setNotice(result.loginAllowed
        ? `Email confirmed and login enabled for ${result.user.email}.`
        : `${result.user.email} updated.`);
      await loadUsers();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Could not update this account.");
    } finally {
      setBusyId(null);
    }
  };

  const deleteUser = async (account: ManagedUser) => {
    const confirmed = window.confirm(
      `Permanently delete ${account.email} from Ayavelisa and Supabase Auth? This removes the login account, but does not delete shared workspace records.`,
    );
    if (!confirmed) return;

    setBusyId(account.id);
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch(`/api/admin/users/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
      });
      const result = await response.json() as { deleted?: boolean; user?: { email: string }; error?: string };
      if (!response.ok || !result.deleted) throw new Error(readableError(result.error, "Could not delete this account."));
      setNotice(`${result.user?.email ?? account.email} deleted from Ayavelisa and Supabase Auth. Shared workspace records were not deleted.`);
      await loadUsers();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this account.");
    } finally {
      setBusyId(null);
    }
  };

  const resendAccess = async (account: ManagedUser) => {
    setBusyId(account.id);
    setError("");
    setNotice("");
    try {
      const response = await authorizedFetch(`/api/admin/users/${encodeURIComponent(account.id)}/resend-access`, {
        method: "POST",
      });
      const result = await response.json() as { sent?: boolean; type?: "confirmation" | "password_recovery"; error?: string };
      if (!response.ok || !result.sent) throw new Error(readableError(result.error, "Could not send an account access email."));
      setNotice(result.type === "confirmation"
        ? `Confirmation email sent to ${account.email}.`
        : `Password reset email sent to ${account.email}.`);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Could not send an account access email.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <SectionEyebrow>Administration / Access</SectionEyebrow>
          <h1>Users &amp; roles</h1>
          <p>Create branches, assign each user one or more branches and a default, then manage roles and access.</p>
        </div>
        <button type="button" className="button button-quiet" onClick={() => void loadUsers()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      <section className="panel user-invite-panel">
        <div className="panel-header">
          <div>
            <SectionEyebrow>New account</SectionEyebrow>
            <h2>Invite a team member</h2>
          </div>
          <MailPlus size={19} />
        </div>
        <form className="user-invite-form" onSubmit={invite}>
          <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Name <span className="optional-label">Optional</span><input type="text" autoComplete="name" maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Role<select value={role} onChange={(event) => setRole(event.target.value as AccountRole)}>{roles.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}</select></label>
          <label>Assigned branch<input type="text" readOnly value={activeBranch?.name ?? "Select a branch first"} /></label>
          <button type="submit" className="button button-primary" disabled={inviting}>
            <MailPlus size={15} />{inviting ? "Sending invite…" : "Send invite"}
          </button>
        </form>
        <p className="user-admin-note">New invitations are sent by Supabase. Existing Supabase accounts are linked to Ayavelisa; use “Confirm &amp; allow login” to approve an unconfirmed email without sending mail (verify the person’s identity first). They still need their Supabase password. Use “Resend access” for email confirmation or password recovery when delivery is available. Public sign-ups stay disabled.</p>
      </section>

      <section className="panel user-invite-panel branch-admin-panel">
        <div className="panel-header">
          <div>
            <SectionEyebrow>Workspace structure</SectionEyebrow>
            <h2>Branches</h2>
          </div>
          <StatusPill label={`${branches.length} active`} tone="success" />
        </div>
        <form className="branch-create-form" onSubmit={(event) => void createBranch(event)}>
          <label>New branch name
            <input type="text" required minLength={2} maxLength={120} value={newBranchName} onChange={(event) => setNewBranchName(event.target.value)} />
          </label>
          <button type="submit" className="button button-primary" disabled={creatingBranch}>
            {creatingBranch ? "Creating…" : "Add branch"}
          </button>
        </form>
        <div className="branch-admin-list">
          {branches.map((branch) => (
            <div className="branch-admin-chip" key={branch.id}>
              <input
                type="text"
                minLength={2}
                maxLength={120}
                value={draftBranchNames[branch.id] ?? branch.name}
                onChange={(event) => setDraftBranchNames((draft) => ({ ...draft, [branch.id]: event.target.value }))}
                aria-label={`Branch name for ${branch.name}`}
              />
              {branch.id === "eastern-cape-delivery" && <small>Existing workspace</small>}
              {draftBranchNames[branch.id]?.trim() !== branch.name && (
                <button type="button" className="text-button" onClick={() => void updateBranchName(branch)}>Save</button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="user-role-guidance" aria-label="Role permissions">
        <p><strong>Fieldworker</strong><span>Visits, intakes and beneficiary leads</span></p>
        <p><strong>Reviewer</strong><span>Review queues, cases, blockers and reports</span></p>
        <p><strong>Supervisor</strong><span>All workspace sections</span></p>
        <p><strong>Administrator</strong><span>All workspace sections plus user and role management</span></p>
      </section>

      {error && <p className="user-admin-message user-admin-error" role="alert">{error}</p>}
      {notice && <p className="user-admin-message user-admin-success" role="status">{notice}</p>}

      <section className="panel user-list-panel">
        <div className="panel-header">
          <div>
            <SectionEyebrow>Managed accounts</SectionEyebrow>
            <h2>Workspace users</h2>
          </div>
          <StatusPill label={`${users.filter((account) => account.active).length} active`} tone="success" />
        </div>
        {loading ? (
          <p className="user-list-empty" role="status">Loading accounts…</p>
        ) : users.length === 0 ? (
          <p className="user-list-empty">No invited users found.</p>
        ) : (
          <div className="user-list">
            {users.map((account) => (
              <div className="user-row" key={account.id}>
                <div className="user-identity">
                  <span className="user-avatar"><UserRound size={17} /></span>
                  <span><strong>{account.name}</strong><small>{account.email}</small></span>
                </div>
                <label className="user-role-select">Role
                  <select
                    value={draftRoles[account.id] ?? account.role}
                    onChange={(event) => setDraftRoles((draft) => ({ ...draft, [account.id]: event.target.value as AccountRole }))}
                    disabled={busyId === account.id}
                    aria-label={`Role for ${account.email}`}
                  >
                    {roles.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}
                  </select>
                </label>
                <label className="user-branches-select">Branches
                  <select
                    multiple
                    value={draftBranchIds[account.id] ?? []}
                    onChange={(event) => {
                      const selected = [...event.currentTarget.selectedOptions].map((option) => option.value);
                      setDraftBranchIds((draft) => ({ ...draft, [account.id]: selected }));
                      if (selected.length > 0 && !selected.includes(draftDefaultBranches[account.id])) {
                        setDraftDefaultBranches((draft) => ({ ...draft, [account.id]: selected[0] }));
                      }
                    }}
                    disabled={busyId === account.id}
                    aria-label={`Branches for ${account.email}`}
                  >
                    {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
                  </select>
                </label>
                <label className="user-role-select">Default branch
                  <select
                    value={draftDefaultBranches[account.id] ?? ""}
                    onChange={(event) => setDraftDefaultBranches((draft) => ({ ...draft, [account.id]: event.target.value }))}
                    disabled={busyId === account.id || !(draftBranchIds[account.id]?.length)}
                    aria-label={`Default branch for ${account.email}`}
                  >
                    {(draftBranchIds[account.id] ?? []).map((branchId) => {
                      const branch = branches.find((item) => item.id === branchId);
                      return branch ? <option key={branch.id} value={branch.id}>{branch.name}</option> : null;
                    })}
                  </select>
                </label>
                <StatusPill label={account.active ? "Active" : "Inactive"} tone={account.active ? "success" : "neutral"} />
                <div className="user-row-actions">
                  {draftRoles[account.id] !== account.role && (
                    <button type="button" className="button button-primary button-small" disabled={busyId === account.id} onClick={() => void updateUser(account, { role: draftRoles[account.id] })}>Save role</button>
                  )}
                  {JSON.stringify(draftBranchIds[account.id] ?? []) !== JSON.stringify(account.branchIds ?? [])
                    || draftDefaultBranches[account.id] !== account.defaultBranchId ? (
                    <button
                      type="button"
                      className="button button-primary button-small"
                      disabled={busyId === account.id || !(draftBranchIds[account.id]?.length)}
                      onClick={() => void updateUser(account, {
                        branchIds: draftBranchIds[account.id],
                        defaultBranchId: draftDefaultBranches[account.id],
                      })}
                    >Save branches</button>
                  ) : null}
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={busyId === account.id}
                    onClick={() => void updateUser(account, { active: true })}
                  >
                    <ShieldCheck size={14} />{account.active ? "Confirm & allow login" : "Confirm & activate"}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={busyId === account.id || !account.active}
                    onClick={() => void resendAccess(account)}
                  >
                    <MailPlus size={14} />{busyId === account.id ? "Sending…" : "Resend access"}
                  </button>
                  {account.active && (
                    <button
                      type="button"
                      className="button button-quiet button-small"
                      disabled={busyId === account.id}
                      onClick={() => void updateUser(account, { active: false })}
                    >
                      <UserRoundX size={14} />Deactivate
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    disabled={busyId === account.id}
                    onClick={() => void deleteUser(account)}
                  >
                    <Trash2 size={14} />Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
