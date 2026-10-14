import { AppHeader } from "@/components/app-header";
import { RouteStudio } from "@/features/admin/route-studio";

export default function AdminRoutesPage() {
  return <main className="admin-shell"><AppHeader admin /><RouteStudio /></main>;
}
