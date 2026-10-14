"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { ArrowRight, AtSign, CalendarDays, CheckCircle2, Eye, EyeOff, History, KeyRound, LockKeyhole, MapPinned, Navigation, ShieldCheck, UserRound } from "lucide-react";
import { LocalDateTime } from "@/components/local-date-time";
import type { AuthUser, DrivingSessionSummary } from "@/types/domain";
import { PinSettings } from "@/features/profile/pin-settings";

export function ProfileSettings({ initialUser, recentSessions, historyUnavailable = false }: {
  initialUser: AuthUser;
  recentSessions: DrivingSessionSummary[];
  historyUnavailable?: boolean;
}) {
  const [email, setEmail] = useState(initialUser.email);
  const [newEmail, setNewEmail] = useState(initialUser.email);
  const [emailPassword, setEmailPassword] = useState("");
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [working, setWorking] = useState<"email" | "password" | null>(null);
  const [emailNotice, setEmailNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [passwordNotice, setPasswordNotice] = useState<{ ok: boolean; text: string } | null>(null);

  async function updateEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEmailNotice(null);
    setWorking("email");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "email", email: newEmail, currentPassword: emailPassword }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "ელფოსტა ვერ შეიცვალა.");
      setEmail(body.email);
      setNewEmail(body.email);
      setEmailPassword("");
      setEmailNotice({ ok: true, text: body.message });
    } catch (error) {
      setEmailNotice({ ok: false, text: error instanceof Error ? error.message : "შეცდომა მოხდა." });
    } finally {
      setWorking(null);
    }
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordNotice(null);
    if (newPassword !== confirmPassword) {
      setPasswordNotice({ ok: false, text: "ახალი პაროლები ერთმანეთს არ ემთხვევა." });
      return;
    }
    setWorking("password");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "password", currentPassword: oldPassword, newPassword }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "პაროლი ვერ შეიცვალა.");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordNotice({ ok: true, text: body.message });
      window.location.replace("/login?reason=password-changed");
    } catch (error) {
      setPasswordNotice({ ok: false, text: error instanceof Error ? error.message : "შეცდომა მოხდა." });
    } finally {
      setWorking(null);
    }
  }

  const busy = working !== null;
  return (
    <div className="profile-page">
      <div className="profile-heading">
        <div className="profile-heading-icon"><UserRound size={26} /></div>
        <div><span className="profile-eyebrow">პირადი ანგარიში</span><h1>ჩემი პროფილი</h1><p>ნახე შენი ინფორმაცია და უსაფრთხოდ მართე ელფოსტა და პაროლი.</p></div>
      </div>

      <div className="profile-grid">
        <section className="profile-card profile-overview">
          <h2><UserRound size={20} /> ანგარიშის ინფორმაცია</h2>
          <div className="profile-avatar">{initialUser.name.trim().slice(0, 1).toUpperCase()}</div>
          <div className="profile-name">{initialUser.name}</div>
          <div className="profile-role"> <ShieldCheck size={15} /> {initialUser.role === "admin" ? "ადმინისტრატორი" : "მძღოლი"}</div>
          <dl className="profile-details">
            <div><dt>როლი</dt><dd>{initialUser.role === "admin" ? "ადმინისტრატორი" : "მძღოლი"}</dd></div>
            <div><dt>ელფოსტა</dt><dd className="profile-email-text">{email}</dd></div>
            <div><dt>პაროლი</dt><dd>•••••••• <span className="profile-muted">(დაცულია)</span></dd></div>
          </dl>
          <div className="profile-security-note"><LockKeyhole size={17} /><span>მოქმედი პაროლის ნახვა შეუძლებელია — იგი სერვერზე მხოლოდ დაცული ჰეშის სახით ინახება.</span></div>
        </section>

        <div className="profile-forms">
          <form className="profile-card" onSubmit={updateEmail}>
            <h2><AtSign size={20} /> ელფოსტის შეცვლა</h2>
            <p>ახალი მისამართის შესანახად დაადასტურე მოქმედი პაროლი.</p>
            <label className="profile-field">ახალი ელფოსტა<input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} required maxLength={220} autoComplete="email" disabled={busy} /></label>
            <label className="profile-field">მოქმედი პაროლი<input type="password" value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} required autoComplete="current-password" disabled={busy} /></label>
            {emailNotice && <div role="status" className={`profile-notice ${emailNotice.ok ? "ok" : "error"}`}>{emailNotice.ok && <CheckCircle2 size={16} />}{emailNotice.text}</div>}
            <button type="submit" className="button button-primary" disabled={busy || !newEmail.trim() || !emailPassword}>{working === "email" ? "ინახება..." : "ელფოსტის შენახვა"}</button>
          </form>

          <form className="profile-card" onSubmit={updatePassword}>
            <h2><KeyRound size={20} /> პაროლის შეცვლა</h2>
            <p>ახალი პაროლი უნდა შეიცავდეს მინიმუმ 10 სიმბოლოს. შეცვლის შემდეგ ხელახლა შესვლა მოგიწევს.</p>
            <label className="profile-field">მოქმედი პაროლი<input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" required disabled={busy} /></label>
            <label className="profile-field">ახალი პაროლი
              <span className="profile-input-wrap"><input type={showNew ? "text" : "password"} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={10} maxLength={200} autoComplete="new-password" required disabled={busy} /><button type="button" aria-label={showNew ? "პაროლის დამალვა" : "პაროლის ჩვენება"} onClick={() => setShowNew((value) => !value)}>{showNew ? <EyeOff size={19}/> : <Eye size={19}/>}</button></span>
            </label>
            <label className="profile-field">გაიმეორე ახალი პაროლი<input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} minLength={10} maxLength={200} autoComplete="new-password" required disabled={busy} /></label>
            {passwordNotice && <div role="status" className={`profile-notice ${passwordNotice.ok ? "ok" : "error"}`}>{passwordNotice.text}</div>}
            <button type="submit" className="button button-primary" disabled={busy || !oldPassword || !newPassword || !confirmPassword}>{working === "password" ? "ინახება..." : "პაროლის განახლება"}</button>
          </form>
          {initialUser.role === "driver" && <PinSettings />}
        </div>
      </div>

      <section className="profile-card profile-history" aria-labelledby="profile-history-title">
        <div className="profile-history-heading">
          <div>
            <h2 id="profile-history-title"><History size={20} /> ჩემი გავლილი მარშრუტები</h2>
            <p>აქ მხოლოდ შენი ანგარიშით შენახული ბოლო ცდები ჩანს — რეალური მართვაც და სიმულაციაც.</p>
          </div>
          <Link className="profile-history-all" href="/my-history">ყველა ჩემი ცდა <ArrowRight size={16} /></Link>
        </div>
        {historyUnavailable ? (
          <div className="profile-history-empty" role="status">ისტორიის ჩატვირთვა დროებით ვერ მოხერხდა. შეგიძლია მოგვიანებით სცადო.</div>
        ) : recentSessions.length === 0 ? (
          <div className="profile-history-empty">შენახული ცდები ჯერ არ გაქვს. პირველი მარშრუტის დასრულების შემდეგ შედეგი აქ გამოჩნდება.</div>
        ) : (
          <div className="profile-history-list">
            {recentSessions.map((session) => (
              <Link key={session.id} href={`/results/${session.id}`} className="profile-history-item">
                <div className="profile-history-route-icon"><MapPinned size={19} /></div>
                <div className="profile-history-item-main">
                  <strong>{session.routeName || "მარშრუტი"}</strong>
                  <span><CalendarDays size={13} /> <LocalDateTime value={session.createdAt} /> · {session.city || "—"}</span>
                  <small><Navigation size={13} /> {session.checkpointsCompleted}/{session.checkpointsTotal} მინიშნება · {session.mode === "real" ? "რეალური GPS" : "სიმულაცია"}</small>
                </div>
                <ArrowRight className="profile-history-item-arrow" size={18} />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
