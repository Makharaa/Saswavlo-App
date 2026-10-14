"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, CircleAlert, Clock3, KeyRound, LockKeyhole,
  Mail, Pencil, Plus, RefreshCw, Route, Search, Shield, ShieldCheck,
  SlidersHorizontal, UserRound, UsersRound, UserRoundCheck, UserRoundX, X,
} from "lucide-react";
import { Surface } from "@/components/ui";
import { AppSelect } from "@/components/app-select";
import { filterAndSortAdminUsers, type AdminRoleFilter, type AdminStatusFilter, type AdminSortMode } from "@/utils/admin-user-list";
import type { AdminUser, UserRole } from "@/types/domain";

type Notice = { tone: "success" | "error"; text: string } | null;

async function readJson(response: Response) {
  return response.json().catch(() => ({}));
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  // Fixed timezone prevents server/client hydration mismatches.
  return new Intl.DateTimeFormat("ka-GE", { timeZone: "Asia/Tbilisi", day: "numeric", month: "short", year: "numeric" }).format(date);
}

export function UserManager() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice>(null);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<AdminRoleFilter>("all");
  const [statusFilter, setStatusFilter] = useState<AdminStatusFilter>("all");
  const [sort, setSort] = useState<AdminSortMode>("newest");
  const [visibleCount, setVisibleCount] = useState(12);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const createDialog = useRef<HTMLDialogElement | null>(null);
  const createButton = useRef<HTMLButtonElement | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editNotice, setEditNotice] = useState<Notice>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("driver");

  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editRole, setEditRole] = useState<UserRole>("driver");
  const [editIsActive, setEditIsActive] = useState(true);
  const [editCanUseRoutes, setEditCanUseRoutes] = useState(true);

  useEffect(() => {
    const dialog = createDialog.current;
    if (!dialog) return;
    if (createOpen && !dialog.open) dialog.showModal();
    if (!createOpen && dialog.open) dialog.close();
  }, [createOpen]);

  useEffect(() => {
    setVisibleCount(12);
  }, [query, roleFilter, statusFilter, sort]);

  const counts = useMemo(() => ({
    total: users.length,
    drivers: users.filter((user) => user.role === "driver").length,
    admins: users.filter((user) => user.role === "admin").length,
    inactive: users.filter((user) => !user.isActive).length,
    restricted: users.filter((user) => user.isActive && user.role === "driver" && !user.canUseRoutes).length,
  }), [users]);

  const filteredUsers = useMemo(() => filterAndSortAdminUsers(users, {
    query, role: roleFilter, status: statusFilter, sort,
  }), [users, query, roleFilter, statusFilter, sort]);

  async function reload() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const body = await readJson(response);
      if (!response.ok || !Array.isArray(body)) throw new Error(body.error || "მომხმარებლები ვერ ჩაიტვირთა.");
      setUsers(body);
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "ჩატვირთვა ვერ მოხერხდა." });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  function closeCreate() {
    if (creating) return;
    setCreateOpen(false);
    requestAnimationFrame(() => createButton.current?.focus());
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    if (role === "admin" && !window.confirm("ახალ მომხმარებელს ადმინისტრატორის სრული უფლებები მიენიჭება. ნამდვილად გსურს გაგრძელება?")) return;
    setCreating(true);
    setNotice(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, role }),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "მომხმარებლის შექმნა ვერ მოხერხდა.");
      setName(""); setEmail(""); setPassword(""); setRole("driver");
      setCreateOpen(false);
      requestAnimationFrame(() => createButton.current?.focus());
      setNotice({ tone: "success", text: "ახალი მომხმარებელი წარმატებით შეიქმნა." });
      await reload();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "შექმნა ვერ მოხერხდა." });
    } finally {
      setCreating(false);
    }
  }

  function beginEdit(user: AdminUser) {
    setEditingId(user.id);
    setEditName(user.name);
    setEditEmail(user.email);
    setEditRole(user.role);
    setEditIsActive(user.isActive);
    setEditCanUseRoutes(user.canUseRoutes);
    setEditPassword("");
    setEditNotice(null);
  }

  function cancelEdit() {
    if (busyId != null) return;
    setEditingId(null);
    setEditPassword("");
    setEditNotice(null);
  }

  async function saveEdit(user: AdminUser) {
    if (busyId !== null) return;
    const normalizedName = editName.trim();
    const normalizedEmail = editEmail.trim().toLowerCase();
    if (normalizedName.length < 2) return setEditNotice({ tone: "error", text: "სახელი მინიმუმ 2 სიმბოლო უნდა იყოს." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return setEditNotice({ tone: "error", text: "შეიყვანე სწორი ელფოსტა." });
    if (editPassword && (editPassword.length < 10 || editPassword.length > 200)) return setEditNotice({ tone: "error", text: "ახალი პაროლი 10–200 სიმბოლო უნდა იყოს." });

    const nextCanUseRoutes = editRole === "admin" ? true : editCanUseRoutes;
    const payload: Record<string, unknown> = {
      name: normalizedName, email: normalizedEmail, role: editRole,
      isActive: editIsActive, canUseRoutes: nextCanUseRoutes,
    };
    if (editPassword) payload.password = editPassword;

    const securityChange = user.role !== editRole || user.isActive !== editIsActive || user.canUseRoutes !== nextCanUseRoutes || !!editPassword;
    if (securityChange && !window.confirm(
      `ნამდვილად შეინახოთ ${user.name}-ის ანგარიშის ცვლილებები?\n\nროლის, წვდომის ან პაროლის ცვლილებამ შეიძლება გავლენა მოახდინოს მის აქტიურ სესიებზე.${editPassword ? "\nპაროლის შეცვლა ასევე გააუქმებს PIN-ს და სანდო მოწყობილობებს." : ""}`
    )) return;

    setBusyId(user.id);
    setEditNotice(null);
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(body.error || "ცვლილების შენახვა ვერ მოხერხდა.");
      setUsers((items) => items.map((item) => item.id === user.id ? body as AdminUser : item));
      setEditPassword("");
      setEditingId(null);
      setNotice({ tone: "success", text: `${body.name}-ის მონაცემები განახლდა.` });

      // If the current administrator changes their own role, let the server
      // enforce permissions and then navigate out of the admin workspace.
      let myId: number | null = null;
      try {
        const raw = window.localStorage.getItem("driveexam-current-user-id");
        const value = Number(raw);
        if (raw && Number.isInteger(value)) myId = value;
      } catch { /* Storage is optional. */ }
      if (myId === user.id && (body.role !== "admin" || !body.isActive)) window.location.replace("/");
    } catch (error) {
      setEditNotice({ tone: "error", text: error instanceof Error ? error.message : "ცვლილება ვერ შეინახა." });
    } finally { setBusyId(null); }
  }

  return (
    <section className="users-workspace users-v25">
      <div className="users-v25-heading">
        <div>
          <div className="side-kicker"><UsersRound size={16} /> ადმინისტრაცია / ანგარიშები</div>
          <h1>მომხმარებლების მართვა</h1>
          <p>ერთ სივრცეში მართე ანგარიშები, როლები, სტატუსი და მარშრუტებზე წვდომა.</p>
        </div>
        <div className="users-v25-heading-actions">
          <button type="button" className="users-v25-refresh" onClick={() => void reload()} disabled={loading || busyId !== null} title="განახლება"><RefreshCw size={16} /> განახლება</button>
          <button type="button" className="users-v25-primary" ref={createButton} onClick={() => { setNotice(null); setCreateOpen(true); }}><Plus size={17} /> ახალი მომხმარებელი</button>
        </div>
      </div>

      <div className="users-v25-stats" aria-label="მომხმარებლების სტატისტიკა">
        <Surface className="users-v25-stat"><span className="users-v25-stat-icon blue"><UsersRound size={18}/></span><small>სულ მომხმარებლები</small><strong>{counts.total}</strong><span>ყველა ანგარიში</span></Surface>
        <Surface className="users-v25-stat"><span className="users-v25-stat-icon violet"><UserRound size={18}/></span><small>მძღოლები</small><strong>{counts.drivers}</strong><span>მძღოლის როლით</span></Surface>
        <Surface className="users-v25-stat"><span className="users-v25-stat-icon mint"><ShieldCheck size={18}/></span><small>ადმინისტრატორები</small><strong>{counts.admins}</strong><span>მართვის სრული უფლებები</span></Surface>
        <Surface className="users-v25-stat"><span className="users-v25-stat-icon orange"><UserRoundX size={18}/></span><small>შეზღუდული</small><strong>{counts.inactive + counts.restricted}</strong><span>{counts.inactive} გათიშული · {counts.restricted} უმარშრუტოდ</span></Surface>
      </div>

      <Surface className="users-v25-panel">
        <div className="users-v25-panel-top">
          <div>
            <h2>ანგარიშების სია</h2>
            <p>მოძებნე მომხმარებელი და გახსენი მისი ანგარიში ცვლილებისთვის.</p>
          </div>
          <span className="users-v25-results">{filteredUsers.length} / {users.length}</span>
        </div>
        <div className="users-v25-toolbar">
          <div className="users-v25-search" role="search">
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="მომხმარებლის ძებნა სახელით ან ელფოსტით"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="სახელი ან ელფოსტა..."
              type="search"
              autoComplete="off"
            />
            {query && <button type="button" aria-label="ძებნის გასუფთავება" onClick={() => setQuery("")}><X size={16}/></button>}
          </div>
          <AppSelect<AdminStatusFilter>
            className="users-v25-app-select"
            ariaLabel="ანგარიშის სტატუსის ფილტრი"
            value={statusFilter}
            onChange={setStatusFilter}
            startIcon={<SlidersHorizontal size={16}/>}
            compact
            options={[
              { value: "all", label: `ყველა სტატუსი (${counts.total})` },
              { value: "active", label: `აქტიური (${users.filter((user) => user.isActive).length})` },
              { value: "inactive", label: `გათიშული (${counts.inactive})` },
              { value: "no-routes", label: `მარშრუტებზე წვდომის გარეშე (${counts.restricted})` },
            ]}
          />
          <AppSelect<AdminSortMode>
            className="users-v25-app-select"
            ariaLabel="მომხმარებლების დალაგება"
            value={sort}
            onChange={setSort}
            startIcon={<Clock3 size={16}/>}
            compact
            options={[
              { value: "newest", label: "თარიღი: ახალიდან ძველისკენ" },
              { value: "oldest", label: "თარიღი: ძველიდან ახლისკენ" },
              { value: "name", label: "სახელი: ანბანის მიხედვით" },
            ]}
          />
        </div>
        {(query || statusFilter !== "all" || roleFilter !== "all" || sort !== "newest") && (
          <div className="users-v25-active-filters">
            <span>ნაპოვნია {filteredUsers.length} მომხმარებელი</span>
            <button type="button" onClick={() => { setQuery(""); setRoleFilter("all"); setStatusFilter("all"); setSort("newest"); }}>ფილტრების გასუფთავება <X size={13}/></button>
          </div>
        )}
        <div className="users-v25-tabs" role="group" aria-label="როლის ფილტრი">
          <button type="button" aria-pressed={roleFilter === "all"} className={roleFilter === "all" ? "active" : ""} onClick={() => setRoleFilter("all")}>ყველა <span>{counts.total}</span></button>
          <button type="button" aria-pressed={roleFilter === "driver"} className={roleFilter === "driver" ? "active" : ""} onClick={() => setRoleFilter("driver")}>მძღოლები <span>{counts.drivers}</span></button>
          <button type="button" aria-pressed={roleFilter === "admin"} className={roleFilter === "admin" ? "active" : ""} onClick={() => setRoleFilter("admin")}>ადმინისტრატორები <span>{counts.admins}</span></button>
        </div>
        {notice && <div className={`users-v25-notice ${notice.tone}`} role="status">{notice.tone === "error" ? <CircleAlert size={16}/> : <Check size={16}/>}<span>{notice.text}</span><button type="button" aria-label="შეტყობინების დახურვა" onClick={() => setNotice(null)}><X size={14}/></button></div>}
        <div className="users-v25-table-heading" aria-hidden="true"><span>მომხმარებელი</span><span>როლი</span><span>მარშრუტები</span><span>სტატუსი</span><span>დამატების თარიღი</span><span>მართვა</span></div>
        <div className="users-v25-list">
          {loading && <div className="users-v25-empty">მომხმარებლები იტვირთება...</div>}
          {!loading && filteredUsers.length === 0 && <div className="users-v25-empty"><Search size={24}/><b>მომხმარებელი ვერ მოიძებნა</b><span>შეცვალე ძებნა ან ფილტრები.</span><button type="button" onClick={() => { setQuery(""); setRoleFilter("all"); setStatusFilter("all"); setSort("newest"); }}>ფილტრების გასუფთავება</button></div>}
          {!loading && filteredUsers.slice(0, visibleCount).map((user) => {
            const editing = editingId === user.id;
            const busy = busyId === user.id;
            return <div key={user.id} className={`users-v25-item ${editing ? "editing" : ""}`}>
              <div className="users-v25-item-main">
                <div className="users-v25-person"><span className={`users-v25-avatar ${user.role}`}>{user.role === "admin" ? <Shield size={19}/> : <UserRound size={19}/>}</span><div className="users-v25-person-text"><strong>{user.name}</strong><span title={user.email}><Mail size={12}/>{user.email}</span><small>ID #{user.id}</small></div></div>
                <span className={`users-v25-chip ${user.role === "admin" ? "admin" : "driver"}`}>{user.role === "admin" ? <ShieldCheck size={13}/> : <UserRound size={13}/>} {user.role === "admin" ? "ადმინისტრატორი" : "მძღოლი"}</span>
                <span className={`users-v25-chip ${user.canUseRoutes ? "allowed" : "blocked"}`}><Route size={13}/>{user.canUseRoutes ? "დაშვებულია" : "შეზღუდულია"}</span>
                <span className={`users-v25-chip ${user.isActive ? "active" : "inactive"}`}><i/>{user.isActive ? "აქტიური" : "გათიშული"}</span>
                <span className="users-v25-date">{formatDate(user.createdAt)}</span>
                <button type="button" className="users-v25-edit-button" disabled={busy || (busyId !== null && !editing)} aria-expanded={editing} aria-label={`${user.name}: ანგარიშის რედაქტირება`} onClick={() => editing ? cancelEdit() : beginEdit(user)}>{editing ? <X size={17}/> : <Pencil size={16}/>}<span>{editing ? "დახურვა" : "მართვა"}</span></button>
              </div>
              {editing && <form className="users-v25-edit-panel" onSubmit={(e) => { e.preventDefault(); void saveEdit(user); }}>
                <div className="users-v25-edit-title"><div><strong>{user.name} — ანგარიშის რედაქტირება</strong><p>ცვლილებები მხოლოდ შენახვის შემდეგ ამოქმედდება.</p></div><button type="button" onClick={cancelEdit} aria-label="რედაქტირების დახურვა" disabled={busy}><X size={17}/></button></div>
                <div className="users-v25-edit-grid">
                  <label><span>სახელი</span><input required minLength={2} maxLength={160} value={editName} onChange={(e) => setEditName(e.target.value)} disabled={busy}/></label>
                  <label><span>ელფოსტა</span><input required type="email" maxLength={220} value={editEmail} onChange={(e) => setEditEmail(e.target.value)} disabled={busy}/></label>
                  <div className="users-v25-edit-field"><span>როლი</span><AppSelect<UserRole> value={editRole} onChange={(next) => { setEditRole(next); if (next === "admin") setEditCanUseRoutes(true); }} options={[{ value: "driver", label: "მძღოლი" }, { value: "admin", label: "ადმინისტრატორი" }]} ariaLabel="მომხმარებლის როლი" disabled={busy}/></div>
                  <div className="users-v25-edit-field"><span>ანგარიშის სტატუსი</span><AppSelect<"active" | "inactive"> value={editIsActive ? "active" : "inactive"} onChange={(next) => setEditIsActive(next === "active")} options={[{ value: "active", label: "აქტიური" }, { value: "inactive", label: "გათიშული" }]} ariaLabel="ანგარიშის სტატუსი" disabled={busy}/></div>
                  <div className="users-v25-edit-field"><span>მარშრუტებზე წვდომა</span><AppSelect<"yes" | "no"> value={editRole === "admin" || editCanUseRoutes ? "yes" : "no"} onChange={(next) => setEditCanUseRoutes(next === "yes")} options={[{ value: "yes", label: "დაშვებულია" }, { value: "no", label: "შეზღუდულია" }]} ariaLabel="მარშრუტებზე წვდომა" disabled={busy || editRole === "admin"}/></div>
                  <label><span>ახალი პაროლი <em>(არასავალდებულო)</em></span><div className="users-v25-input-icon"><KeyRound size={16}/><input type="password" autoComplete="new-password" minLength={10} maxLength={200} value={editPassword} onChange={(e) => setEditPassword(e.target.value)} placeholder="ცარიელი — უცვლელი" disabled={busy}/></div></label>
                </div>
                {editPassword && <div className="users-v25-warning"><LockKeyhole size={15}/> პაროლის შეცვლა გააუქმებს მომხმარებლის PIN-ს, სანდო მოწყობილობებსა და ძველ სესიებს.</div>}
                {editNotice && <div className={`users-v25-notice ${editNotice.tone}`} role="status">{editNotice.text}</div>}
                <div className="users-v25-edit-actions"><button type="button" className="users-v25-secondary" disabled={busy} onClick={cancelEdit}>გაუქმება</button><button type="submit" className="users-v25-primary" disabled={busy}>{busy ? "ინახება..." : <><Check size={16}/> ცვლილებების შენახვა</>}</button></div>
              </form>}
            </div>;
          })}
        </div>
        {!loading && visibleCount < filteredUsers.length && <div className="users-v25-more"><button type="button" onClick={() => setVisibleCount((count) => count + 12)}>მეტის ჩვენება ({filteredUsers.length - visibleCount})</button></div>}
      </Surface>

      <dialog ref={createDialog} className="users-v25-dialog" onCancel={(event) => { if (creating) event.preventDefault(); else setCreateOpen(false); }} onClose={() => { setCreateOpen(false); requestAnimationFrame(() => createButton.current?.focus()); }} aria-labelledby="users-v25-create-title">
        <div className="users-v25-dialog-heading"><span className="users-v25-dialog-icon"><Plus size={20}/></span><div><h2 id="users-v25-create-title">ახალი მომხმარებელი</h2><p>შექმენი ახალი მძღოლის ან ადმინისტრატორის ანგარიში.</p></div><button type="button" aria-label="დახურვა" disabled={creating} onClick={closeCreate}><X size={19}/></button></div>
        <form onSubmit={create} className="users-v25-create-form">
          <label><span>სახელი და გვარი</span><input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={160} placeholder="მაგ. გიორგი მახარაძე" disabled={creating}/></label>
          <label><span>ელფოსტა</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={220} placeholder="example@gmail.com" disabled={creating}/></label>
          <label><span>საწყისი პაროლი</span><input type="password" autoComplete="new-password" minLength={10} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="მინიმუმ 10 სიმბოლო" disabled={creating}/></label>
          <fieldset className="users-v25-role-choice"><legend>როლი</legend><label className={role === "driver" ? "selected" : ""}><input type="radio" checked={role === "driver"} onChange={() => setRole("driver")} disabled={creating}/><UserRound size={18}/><span><b>მძღოლი</b><small>მარშრუტების გამოყენება და საკუთარი ისტორია</small></span></label><label className={role === "admin" ? "selected" : ""}><input type="radio" checked={role === "admin"} onChange={() => setRole("admin")} disabled={creating}/><ShieldCheck size={18}/><span><b>ადმინისტრატორი</b><small>მომხმარებლებისა და მარშრუტების მართვა</small></span></label></fieldset>
          {notice?.tone === "error" && <div className="users-v25-notice error" role="alert">{notice.text}</div>}
          <div className="users-v25-dialog-actions"><button type="button" className="users-v25-secondary" onClick={closeCreate} disabled={creating}>გაუქმება</button><button type="submit" className="users-v25-primary" disabled={creating}>{creating ? "იქმნება..." : <><UserRoundCheck size={17}/> შექმნა</>}</button></div>
        </form>
      </dialog>
    </section>
  );
}
