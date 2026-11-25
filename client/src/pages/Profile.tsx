import { useState, type FormEvent } from "react";
import { DoorOpen, LockKeyhole, Save, UserRound } from "lucide-react";
import { useToast } from "@/components/ui";
import { useAuth } from "@/components/AuthGate";
import { supabase } from "@/lib/supabase";

export default function Profile() {
  const { user, updateProfileName, changePassword } = useAuth();
  const { notify } = useToast();
  const [name, setName] = useState(user?.name ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSavingProfile(true);
    try {
      await updateProfileName(name.trim());
      notify("Profile updated");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update your profile", "error");
    } finally {
      setSavingProfile(false);
    }
  };

  const savePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      notify("Passwords do not match", "error");
      return;
    }
    setSavingPassword(true);
    try {
      await changePassword(newPassword);
      setNewPassword("");
      setConfirmPassword("");
      notify("Password updated");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Could not update your password", "error");
    } finally {
      setSavingPassword(false);
    }
  };

  const signOut = async () => {
    if (!supabase) return;
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      notify(error instanceof Error ? `Could not sign out: ${error.message}` : "Could not sign out", "error");
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="section-eyebrow">Account / Profile</span>
          <h1>Your profile</h1>
          <p>Update your account details and sign-in password.</p>
        </div>
      </div>

      <div className="profile-grid">
        <section className="panel profile-card">
          <div className="config-card-icon"><UserRound size={18} /></div>
          <h2>Personal details</h2>
          <form className="profile-form" onSubmit={(event) => void saveProfile(event)}>
            <label>
              <span>Display name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={120} required />
            </label>
            <label>
              <span>Email address</span>
              <input value={user?.email ?? ""} readOnly aria-readonly="true" />
              <small>Email changes require a verified account recovery process.</small>
            </label>
            <label>
              <span>Role</span>
              <input value={user?.role ?? ""} readOnly aria-readonly="true" />
            </label>
            <button type="submit" className="button button-primary" disabled={savingProfile || name.trim().length < 2}>
              <Save size={16} />{savingProfile ? "Saving…" : "Save profile"}
            </button>
          </form>
        </section>

        <section className="panel profile-card">
          <div className="config-card-icon"><LockKeyhole size={18} /></div>
          <h2>Change password</h2>
          <p>Your password is managed securely by the sign-in provider.</p>
          {supabase ? (
            <form className="profile-form" onSubmit={(event) => void savePassword(event)}>
              <label>
                <span>New password</span>
                <input type="password" autoComplete="new-password" minLength={8} required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
              </label>
              <label>
                <span>Confirm new password</span>
                <input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </label>
              <button type="submit" className="button button-primary" disabled={savingPassword || newPassword.length < 8}>
                <LockKeyhole size={16} />{savingPassword ? "Updating…" : "Update password"}
              </button>
            </form>
          ) : <p>Password management is not available in local demo mode.</p>}
        </section>
      </div>
      {supabase && (
        <div className="profile-signout">
          <button type="button" className="button button-outline" onClick={() => void signOut()}>
            <DoorOpen size={16} />Sign out
          </button>
        </div>
      )}
    </>
  );
}
