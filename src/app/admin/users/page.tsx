import { AppHeader } from "@/components/app-header";
import { UserManager } from "@/features/admin/user-manager";

export default function AdminUsersPage() {
  return (
    <main className="admin-shell">
      <AppHeader admin />
      <UserManager />
    </main>
  );
}
