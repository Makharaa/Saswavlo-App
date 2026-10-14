"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CarFront, LockKeyhole, Mail, ShieldCheck, KeyRound } from "lucide-react";

type LoginStep = "email" | "password" | "pin" | "password-pin";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [step, setStep] = useState<LoginStep>("email");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    try {
      const lastEmail = window.localStorage.getItem("driveexam-last-login-email");
      if (lastEmail) setEmail(lastEmail);
    } catch { /* Storage is optional in private browsing. */ }
    const reason = new URLSearchParams(window.location.search).get("reason");
    if (reason === "session-replaced") {
      setNotice("თქვენს ანგარიშზე დაფიქსირდა ახალი შესვლა. უსაფრთხოების მიზნით წინა სესია დასრულდა.");
    } else if (reason === "account-disabled") {
      setNotice("თქვენი ანგარიში ადმინისტრატორის მიერ გათიშულია. წვდომისთვის მიმართეთ ადმინისტრატორს.");
    } else if (reason === "password-changed") {
      setNotice("პაროლი შეიცვალა. ხელახლა შედით ანგარიშში.");
    }
  }, []);

  function backToEmail() {
    setStep("email");
    setPassword("");
    setPin("");
    setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      if (step === "email") {
        const response = await fetch("/api/auth/login/method", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim().toLowerCase() }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "შესვლის შემოწმება ვერ შესრულდა.");
        setStep(body.method === "pin" ? "pin" : "password");
        setPin("");
        setPassword("");
        return;
      }

      const isPinOnly = step === "pin";
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          method: isPinOnly ? "pin" : "password",
          ...(!isPinOnly ? { password } : {}),
          ...(step === "pin" || step === "password-pin" ? { pin } : {}),
        }),
      });
      const body = await response.json();
      if (body?.code === "PIN_REQUIRED" && step === "password") {
        setStep("password-pin");
        setPin("");
        setNotice("ახალ მოწყობილობაზე პაროლის შემდეგ PIN-ის დადასტურებაც საჭიროა.");
        return;
      }
      if (!response.ok) throw new Error(body.error || "ავტორიზაცია ვერ შესრულდა.");
      setPassword("");
      setPin("");
      try { window.localStorage.setItem("driveexam-last-login-email", email.trim().toLowerCase()); } catch { /* optional */ }
      if (body?.user?.id) {
        try { window.localStorage.setItem("driveexam-current-user-id", String(body.user.id)); } catch { /* optional */ }
      }
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ავტორიზაცია ვერ შესრულდა.");
    } finally {
      setLoading(false);
    }
  }

  const prompt = step === "email"
    ? "შეიყვანე ელფოსტა და სისტემა თავად შეარჩევს უსაფრთხო შესვლის მეთოდს."
    : step === "pin"
      ? "ეს მოწყობილობა დამტკიცებულია. შესასვლელად შეიყვანე 4-ნიშნა PIN."
      : step === "password-pin"
        ? "ახალი მოწყობილობის დასადასტურებლად შეიყვანე PIN."
        : "შესასვლელად შეიყვანე პაროლი. ახალ მოწყობილობაზე შესაძლოა PIN-იც დაგჭირდეს.";

  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="auth-brand">
          <div className="auth-brand-icon"><CarFront size={25} /></div>
          <div><small>მართვის გამოცდა</small><strong>სასწავლო მარშრუტები</strong></div>
        </div>
        <div className="auth-copy">
          <span><ShieldCheck size={15} /> ავტორიზებული წვდომა</span>
          <h1>შესვლა</h1>
          <p>{prompt}</p>
        </div>
        {notice && <div className="auth-session-notice" role="status">{notice}</div>}
        <form onSubmit={submit} className="auth-form">
          <label>
            <span>ელფოსტა</span>
            <div>
              <Mail size={17} />
              {step === "email" ? (
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
              ) : (
                <input type="email" value={email} readOnly autoComplete="email" aria-label="არჩეული ელფოსტა" />
              )}
            </div>
          </label>
          {step !== "email" && (
            <button type="button" className="button button-secondary" onClick={backToEmail} disabled={loading}>
              სხვა ელფოსტის არჩევა
            </button>
          )}
          {step === "password" && (
            <label>
              <span>პაროლი</span>
              <div><LockKeyhole size={17} /><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus /></div>
            </label>
          )}
          {(step === "pin" || step === "password-pin") && (
            <label>
              <span>4-ნიშნა PIN</span>
              <div><KeyRound size={17} /><input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} required placeholder="••••" autoFocus /></div>
            </label>
          )}
          {step === "pin" && (
            <button type="button" className="button button-secondary" onClick={() => { setStep("password"); setPin(""); setError(""); }} disabled={loading}>
              პაროლით შესვლა
            </button>
          )}
          {step === "password-pin" && (
            <button type="button" className="button button-secondary" onClick={() => { setStep("password"); setPin(""); setPassword(""); setError(""); }} disabled={loading}>
              პაროლის თავიდან შეყვანა
            </button>
          )}
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button type="submit" className="auth-submit" disabled={loading || ((step === "pin" || step === "password-pin") && pin.length !== 4)}>
            {loading ? "მოწმდება..." : step === "email" ? "გაგრძელება" : "შესვლა"}
          </button>
          {step === "pin" && <small>თუ PIN დაგავიწყდა, შეგიძლია პაროლით შესვლა სცადო ან აღდგენისთვის ადმინისტრატორს მიმართო.</small>}
        </form>
      </section>
    </main>
  );
}
