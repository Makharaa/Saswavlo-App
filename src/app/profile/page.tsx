import { AppHeader } from "@/components/app-header";
import { ProfileSettings } from "@/features/profile/profile-settings";
import { requireUser } from "@/lib/auth";
import { listDrivingSessions } from "@/lib/repository";
import { logOperationError } from "@/lib/logger";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await requireUser();
  let recentSessions: Awaited<ReturnType<typeof listDrivingSessions>> = [];
  let historyUnavailable = false;
  try {
    recentSessions = await listDrivingSessions(5, user.id);
  } catch (error) {
    logOperationError("profile.recent-sessions", error);
    historyUnavailable = true;
  }
  return (
    <main className="site-shell">
      <AppHeader admin={user.role === "admin"} />
      <ProfileSettings initialUser={user} recentSessions={recentSessions} historyUnavailable={historyUnavailable} />
    </main>
  );
}
