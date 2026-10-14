import type { AdminUser, UserRole } from "@/types/domain";

export type AdminRoleFilter = "all" | UserRole;
export type AdminStatusFilter = "all" | "active" | "inactive" | "no-routes";
export type AdminSortMode = "newest" | "oldest" | "name";

type UserListOptions = {
  query: string;
  role: AdminRoleFilter;
  status: AdminStatusFilter;
  sort: AdminSortMode;
};

function timestamp(value: string): number {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

export function filterAndSortAdminUsers(users: AdminUser[], options: UserListOptions): AdminUser[] {
  const needle = options.query.trim().toLocaleLowerCase("ka-GE");
  return users
    .filter((user) => {
      if (options.role !== "all" && user.role !== options.role) return false;
      if (options.status === "active" && !user.isActive) return false;
      if (options.status === "inactive" && user.isActive) return false;
      if (options.status === "no-routes" && (user.role !== "driver" || !user.isActive || user.canUseRoutes)) return false;
      return !needle || `${user.name} ${user.email}`.toLocaleLowerCase("ka-GE").includes(needle);
    })
    .sort((a, b) => {
      if (options.sort === "name") {
        return a.name.localeCompare(b.name, "ka") || a.id - b.id;
      }
      const dateDifference = timestamp(b.createdAt) - timestamp(a.createdAt);
      return (options.sort === "newest" ? dateDifference : -dateDifference) || a.id - b.id;
    });
}
