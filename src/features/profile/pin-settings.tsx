"use client";

import { useEffect, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";

export function PinSettings() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [password, setPassword] = useState("");
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    fetch("/api/profile/pin", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((result) => setEnabled(Boolean(result.enabled)))
      .catch(() => setMessage({ ok: false, text: "PIN-ის მდგომარეობა ვერ ჩაიტვირთა." }));
  }, []);

  async function change(remove: boolean) {
    setMessage(null);
    if (!remove && pin !== confirmPin) {
      setMessage({ ok: false, text: "PIN კოდები ერთმანეთს არ ემთხვევა." });
      return;
    }
    setWorking(true);
    try {
      const response = await fetch("/api/profile/pin", {
        method: remove ? "DELETE" : "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: password, ...(!remove ? { pin } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "PIN-ის ცვლილება ვერ შესრულდა.");
      setEnabled(Boolean(body.enabled));
      setPin("");
      setConfirmPin("");
      setPassword("");
      setMessage({ ok: true, text: remove ? "PIN გათიშულია." : "PIN დაყენებულია. ეს მოწყობილობა დამტკიცდა PIN-ით სწრაფი შესვლისთვის." });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "შეცდომა მოხდა." });
    } finally { setWorking(false); }
  }

  return (
    <form className="profile-card" onSubmit={(e) => { e.preventDefault(); void change(false); }}>
      <h2><KeyRound size={20} /> 4-ნიშნა PIN</h2>
      <p><ShieldCheck size={15} /> {enabled === null ? "მოწმდება..." : enabled ? "PIN ჩართულია. შეგიძლია შეცვალო ან გათიშო." : "დააყენე PIN ამ ტელეფონზე სწრაფი შესვლისთვის."}</p>
      <p>PIN მხოლოდ დამტკიცებულ მოწყობილობაზე მუშაობს. ახალ მოწყობილობაზე აუცილებელია პაროლი და PIN. IP-ის ცვლილება თავისთავად არ ნიშნავს ახალ მოწყობილობას.</p>
      <label className="profile-field">მოქმედი პაროლი
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required disabled={working} />
      </label>
      <label className="profile-field">ახალი ოთხნიშნა PIN
        <input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))} required disabled={working} />
      </label>
      <label className="profile-field">გაიმეორე PIN
        <input type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" value={confirmPin} onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))} required disabled={working} />
      </label>
      {message && <div className={`profile-notice ${message.ok ? "ok" : "error"}`} role="status">{message.text}</div>}
      <button className="button button-primary" type="submit" disabled={working || pin.length !== 4 || confirmPin.length !== 4 || !password}>{working ? "მოწმდება..." : enabled ? "PIN-ის შეცვლა" : "PIN-ის დაყენება"}</button>
      {enabled && <button type="button" className="button button-secondary" disabled={working || !password} onClick={() => void change(true)}>PIN-ის გათიშვა</button>}
    </form>
  );
}
