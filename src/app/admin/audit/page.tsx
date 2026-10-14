import { ScrollText } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { AuditLogViewer } from "@/features/admin/audit-log-viewer";

export default function AuditPage() {
  return (
    <main className="page-shell">
      <AppHeader admin />
      <section className="audit-page-v18">
        <div className="page-heading-row">
          <div>
            <div className="side-kicker"><ScrollText size={16} /> აუდიტის ჟურნალი</div>
            <h1>სისტემის ცვლილებების ისტორია</h1>
            <p>მარშრუტების და მომხმარებლების ადმინისტრაციული ცვლილებები ერთ სივრცეში.</p>
          </div>
        </div>
        <AuditLogViewer />
      </section>
    </main>
  );
}
