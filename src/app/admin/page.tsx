import Link from "next/link";
import {
  Activity,
  ArrowRight,
  BarChart3,
  CarFront,
  CircleAlert,
  Gauge,
  Route,
  ScrollText,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Badge, Surface } from "@/components/ui";
import { getAdminAnalytics } from "@/lib/analytics";
import { listAuditLogs } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";

function formatPercent(value: number) {
  return `${Math.round(value)}%`;
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ka-GE", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function AdminDashboardPage() {
  await requireAdmin();
  const [analytics, audit] = await Promise.all([
    getAdminAnalytics(),
    listAuditLogs({ limit: 6 }),
  ]);

  const maxTimeline = Math.max(
    1,
    ...analytics.timeline.map((point) => point.sessions)
  );

  return (
    <main className="page-shell">
      <AppHeader admin />

      <section className="admin-dashboard-v18">
        <div className="admin-dashboard-head">
          <div>
            <div className="side-kicker">
              <BarChart3 size={16} /> ადმინისტრაცია
            </div>
            <h1>სისტემის მიმოხილვა</h1>
            <p>
              მძღოლები, მარშრუტები, სესიები და ბოლო ადმინისტრაციული ცვლილებები.
            </p>
          </div>
          <div className="admin-dashboard-actions">
            <Link className="button button-secondary" href="/history">
              სესიების ისტორია
            </Link>
            <Link className="button button-primary" href="/admin/audit">
              აუდიტის ჟურნალი <ArrowRight size={16} />
            </Link>
          </div>
        </div>

        <div className="admin-kpi-grid-v18">
          <Surface>
            <span className="admin-kpi-icon"><UsersRound size={18} /></span>
            <small>აქტიური მძღოლები</small>
            <strong>{analytics.totals.activeDrivers}</strong>
            <p>{analytics.totals.users} მომხმარებელი სულ</p>
          </Surface>
          <Surface>
            <span className="admin-kpi-icon"><Route size={18} /></span>
            <small>მარშრუტები</small>
            <strong>{analytics.totals.routes}</strong>
            <p>{analytics.totals.publishedRoutes} გამოქვეყნებული</p>
          </Surface>
          <Surface>
            <span className="admin-kpi-icon"><CarFront size={18} /></span>
            <small>სესიები</small>
            <strong>{analytics.totals.sessions}</strong>
            <p>{analytics.totals.sessionsLast7Days} ბოლო 7 დღეში</p>
          </Surface>
          <Surface>
            <span className="admin-kpi-icon"><ShieldCheck size={18} /></span>
            <small>საშ. დასრულება</small>
            <strong>{formatPercent(analytics.totals.averageCompletion)}</strong>
            <p>checkpoint completion</p>
          </Surface>
          <Surface>
            <span className="admin-kpi-icon warning"><Gauge size={18} /></span>
            <small>Speeding</small>
            <strong>{analytics.totals.speedingEvents}</strong>
            <p>დაფიქსირებული შემთხვევა</p>
          </Surface>
          <Surface>
            <span className="admin-kpi-icon danger"><CircleAlert size={18} /></span>
            <small>Off route</small>
            <strong>{analytics.totals.offRouteEvents}</strong>
            <p>მარშრუტიდან გადახვევა</p>
          </Surface>
        </div>

        <div className="admin-dashboard-grid-v18">
          <Surface className="admin-chart-card-v18">
            <div className="admin-card-head-v18">
              <div>
                <small>ბოლო 14 დღე</small>
                <h2>სესიების აქტივობა</h2>
              </div>
              <div className="admin-chart-legend-v18">
                <span><i className="real" /> Real</span>
                <span><i className="sim" /> Simulation</span>
              </div>
            </div>

            <div className="admin-timeline-v18">
              {analytics.timeline.map((point) => (
                <div className="admin-timeline-day-v18" key={point.date}>
                  <div className="admin-timeline-bars-v18" title={`${point.sessions} სესია`}>
                    <span
                      className="real"
                      style={{ height: `${Math.max(3, (point.realSessions / maxTimeline) * 100)}%` }}
                    />
                    <span
                      className="sim"
                      style={{ height: `${Math.max(3, (point.simulationSessions / maxTimeline) * 100)}%` }}
                    />
                  </div>
                  <small>{new Date(`${point.date}T00:00:00`).toLocaleDateString("ka-GE", { day: "numeric" })}</small>
                </div>
              ))}
            </div>
          </Surface>

          <Surface className="admin-recent-card-v18">
            <div className="admin-card-head-v18">
              <div>
                <small>LIVE DATA</small>
                <h2>ბოლო სესიები</h2>
              </div>
              <Badge tone="neutral">{analytics.totals.realSessions} Real GPS</Badge>
            </div>

            <div className="admin-recent-list-v18">
              {analytics.recentSessions.map((session) => (
                <Link href={`/results/${session.id}`} key={session.id}>
                  <div>
                    <strong>{session.routeName || "მარშრუტი"}</strong>
                    <small>{session.userName || "მომხმარებელი"} • {new Date(session.createdAt).toLocaleString("ka-GE")}</small>
                  </div>
                  <span>{session.checkpointsCompleted}/{session.checkpointsTotal}</span>
                </Link>
              ))}
              {!analytics.recentSessions.length && <p className="admin-empty-inline-v18">სესიები ჯერ არ არის.</p>}
            </div>
          </Surface>
        </div>

        <div className="admin-dashboard-grid-v18 bottom">
          <Surface className="admin-table-card-v18">
            <div className="admin-card-head-v18">
              <div>
                <small>ROUTES</small>
                <h2>მარშრუტების სტატისტიკა</h2>
              </div>
            </div>
            <div className="admin-simple-table-v18">
              <div className="head"><span>მარშრუტი</span><span>ცდები</span><span>დასრულება</span><span>შეცდომები</span></div>
              {analytics.routes.map((route) => (
                <div key={`${route.routeId}-${route.routeName}`}>
                  <span><b>{route.routeName}</b><small>{formatDate(route.lastSessionAt)}</small></span>
                  <span>{route.sessions}</span>
                  <span>{formatPercent(route.averageCompletion)}</span>
                  <span>{route.speedingEvents + route.offRouteEvents}</span>
                </div>
              ))}
              {!analytics.routes.length && <p className="admin-empty-inline-v18">სტატისტიკა ჯერ არ არის.</p>}
            </div>
          </Surface>

          <Surface className="admin-table-card-v18">
            <div className="admin-card-head-v18">
              <div>
                <small>DRIVERS</small>
                <h2>მძღოლების პროგრესი</h2>
              </div>
            </div>
            <div className="admin-simple-table-v18 drivers">
              <div className="head"><span>მძღოლი</span><span>ცდები</span><span>Real</span><span>დასრულება</span></div>
              {analytics.drivers.map((driver) => (
                <div key={driver.userId}>
                  <span><b>{driver.userName}</b><small>{formatDate(driver.lastSessionAt)}</small></span>
                  <span>{driver.sessions}</span>
                  <span>{driver.realSessions}</span>
                  <span>{formatPercent(driver.averageCompletion)}</span>
                </div>
              ))}
              {!analytics.drivers.length && <p className="admin-empty-inline-v18">მძღოლის მონაცემები ჯერ არ არის.</p>}
            </div>
          </Surface>
        </div>

        <Surface className="admin-audit-preview-v18">
          <div className="admin-card-head-v18">
            <div>
              <small>AUDIT</small>
              <h2>ბოლო ადმინისტრაციული ცვლილებები</h2>
            </div>
            <Link href="/admin/audit">ყველას ნახვა <ArrowRight size={14} /></Link>
          </div>
          <div className="admin-audit-preview-list-v18">
            {audit.map((entry) => (
              <div key={entry.id}>
                <span className="audit-preview-icon-v18"><ScrollText size={15} /></span>
                <div><b>{entry.summary}</b><small>{entry.actorName || "System"} • {new Date(entry.createdAt).toLocaleString("ka-GE")}</small></div>
                <code>{entry.action}</code>
              </div>
            ))}
            {!audit.length && <p className="admin-empty-inline-v18">აუდიტის ჩანაწერები ჯერ არ არის.</p>}
          </div>
        </Surface>
      </section>
    </main>
  );
}
