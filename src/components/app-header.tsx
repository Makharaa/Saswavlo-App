"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import {
  CarFront,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  UserRound,
  Route,
  Settings,
  UsersRound,
  X,
} from "lucide-react";
import type { AuthUser } from "@/types/domain";
import { APP_VERSION } from "@/lib/app-info";
import { CITY_CHANGED_EVENT, readCurrentUserId, readSelectedCity } from "@/utils/selected-city";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  adminOnly?: boolean;
  routeAccessOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "მთავარი", icon: Home },
  { href: "/routes", label: "მარშრუტები", icon: Route, routeAccessOnly: true },
  { href: "/drive", label: "მართვის რეჟიმი", icon: Map, routeAccessOnly: true },
  { href: "/admin", label: "მიმოხილვა", icon: LayoutDashboard, adminOnly: true },
  { href: "/admin/routes", label: "რედაქტორი", icon: Settings, adminOnly: true },
  { href: "/admin/users", label: "მომხმარებლები", icon: UsersRound, adminOnly: true },
  { href: "/history", label: "ისტორია", icon: History },
  { href: "/profile", label: "პროფილი", icon: UserRound },
];

function isActivePath(pathname: string, href: string) {
  if (href === "/" || href === "/admin") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader({ admin = false }: { admin?: boolean }) {
  const pathname = usePathname();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [cityLabel, setCityLabel] = useState("სასწავლო მარშრუტები");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuToggleRef = useRef<HTMLButtonElement>(null);

  function closeMobileMenu() {
    // Move focus out of the drawer before React applies aria-hidden/inert.
    // Otherwise Chrome warns that the hidden drawer still contains focus.
    menuToggleRef.current?.focus({ preventScroll: true });
    setMenuOpen(false);
  }

  const visibleItems = useMemo(
    () =>
      NAV_ITEMS.filter((item) => {
        if (item.adminOnly && user?.role !== "admin") return false;
        if (
          item.routeAccessOnly &&
          user?.role === "driver" &&
          user.canUseRoutes === false
        ) {
          return false;
        }
        return true;
      }),
    [user?.role, user?.canUseRoutes]
  );

  useEffect(() => {
    function syncCity() {
      setCityLabel(readSelectedCity(user?.id ?? readCurrentUserId()) || "სასწავლო მარშრუტები");
    }
    syncCity();
    window.addEventListener(CITY_CHANGED_EVENT, syncCity);
    window.addEventListener("storage", syncCity);
    return () => {
      window.removeEventListener(CITY_CHANGED_EVENT, syncCity);
      window.removeEventListener("storage", syncCity);
    };
  }, [user?.id]);

  useEffect(() => {
    let cancelled = false;

    async function syncSession() {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        const body = await response.json().catch(() => null);

        if (cancelled) return;

        if (!response.ok) {
          setUser(null);
          try {
            window.localStorage.removeItem("driveexam-current-user-id");
          } catch {
            // local storage is optional
          }

          if (body?.code === "SESSION_REPLACED") {
            window.location.replace("/login?reason=session-replaced");
            return;
          }

          if (body?.code === "ACCOUNT_DISABLED") {
            window.location.replace("/login?reason=account-disabled");
            return;
          }

          if (response.status === 401) {
            window.location.replace("/login");
          }
          return;
        }

        const nextUser = body?.user ?? null;
        setUser(nextUser);
        try {
          if (nextUser?.id) {
            window.localStorage.setItem(
              "driveexam-current-user-id",
              String(nextUser.id)
            );
          } else {
            window.localStorage.removeItem("driveexam-current-user-id");
          }
        } catch {
          // local storage is optional
        }

        const routeRestricted =
          nextUser?.role === "driver" && nextUser.canUseRoutes === false;
        if (
          routeRestricted &&
          (pathname === "/routes" ||
            pathname.startsWith("/routes/") ||
            pathname === "/drive" ||
            pathname.startsWith("/drive/"))
        ) {
          window.location.replace("/access-restricted");
          return;
        }

        if (!routeRestricted && pathname === "/access-restricted") {
          window.location.replace("/routes");
        }
      } catch {
        // A transient network failure must not sign the user out. The next
        // heartbeat will retry.
      }
    }

    void syncSession();
    const timer = window.setInterval(syncSession, 8000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pathname]);

  useEffect(() => {
    // Also handle client-side navigation that did not originate in this menu.
    if (menuOpen) closeMobileMenu();
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobileMenu();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    try {
      window.localStorage.removeItem("driveexam-current-user-id");
    } catch {
      // ignore
    }
    window.location.href = "/login";
  }

  return (
    <>
      <header className={`app-header app-header-v13 ${admin ? "admin-header" : ""}`}>
        <Link href="/" className="brand-lockup">
          <div className="brand-mark">
            <CarFront size={20} />
          </div>
          <div>
            <b>DriveExam</b>
            <small>{cityLabel}</small>
          </div>
        </Link>

        <nav className="app-nav app-nav-desktop" aria-label="მთავარი მენიუ">
          {visibleItems.filter((item) => item.href !== "/profile").map((item) => {
            const Icon = item.icon;
            const targetHref = item.href === "/history" && user?.role === "driver" ? "/my-history" : item.href;
            return (
              <Link
                key={item.href}
                href={targetHref}
                className={isActivePath(pathname, targetHref) ? "active" : ""}
              >
                <Icon size={16} />
                <span>{item.href === "/history" && user?.role === "driver" ? "ჩემი ისტორია" : item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="header-user header-user-desktop">
          {user && (
            <div className="header-user-copy">
              <b>{user.name}</b>
              <small>{user.role === "admin" ? "ადმინისტრატორი" : "მძღოლი"} • v{APP_VERSION}</small>
            </div>
          )}

          {user && (
            <Link
              href="/profile"
              className={`header-profile-action ${isActivePath(pathname, "/profile") ? "active" : ""}`}
              title="ჩემი პროფილი"
              aria-label="პროფილი"
              aria-current={isActivePath(pathname, "/profile") ? "page" : undefined}
            >
              <UserRound size={16} />
              <span>პროფილი</span>
            </Link>
          )}
          <button className="header-logout" onClick={logout} title="გასვლა" aria-label="გასვლა">
            <LogOut size={16} />
          </button>
        </div>

        <button
          type="button"
          ref={menuToggleRef}
          className={`header-burger ${menuOpen ? "active" : ""}`}
          onClick={() => (menuOpen ? closeMobileMenu() : setMenuOpen(true))}
          aria-expanded={menuOpen}
          aria-controls="mobile-main-menu"
          aria-label={menuOpen ? "მენიუს დახურვა" : "მენიუს გახსნა"}
        >
          {menuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
      </header>

      <button
        type="button"
        className={`mobile-menu-backdrop ${menuOpen ? "open" : ""}`}
        onClick={closeMobileMenu}
        tabIndex={menuOpen ? 0 : -1}
        aria-label="მენიუს დახურვა"
      />

      <aside
        id="mobile-main-menu"
        className={`mobile-main-menu ${menuOpen ? "open" : ""}`}
        aria-hidden={!menuOpen}
        inert={!menuOpen}
      >
        <div className="mobile-menu-head">
          <div className="mobile-menu-profile">
            <div className="mobile-menu-avatar">
              <CarFront size={19} />
            </div>
            <div>
              <strong>{user?.name || "DriveExam"}</strong>
              <small>
                {user?.role === "admin"
                  ? "ადმინისტრატორი"
                  : user?.role === "driver"
                    ? "მძღოლი"
                    : cityLabel}
              </small>
            </div>
          </div>

          <button type="button" onClick={closeMobileMenu} aria-label="მენიუს დახურვა">
            <X size={18} />
          </button>
        </div>

        <nav className="mobile-menu-nav" aria-label="მობილური მენიუ">
          {visibleItems.map((item) => {
            const Icon = item.icon;
            const targetHref = item.href === "/history" && user?.role === "driver" ? "/my-history" : item.href;
            return (
              <Link
                key={item.href}
                href={targetHref}
                onClick={closeMobileMenu}
                className={isActivePath(pathname, targetHref) ? "active" : ""}
              >
                <span className="mobile-menu-icon">
                  <Icon size={18} />
                </span>
                <span>{item.href === "/history" && user?.role === "driver" ? "ჩემი ისტორია" : item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="mobile-menu-foot">
          <small className="mobile-menu-version">DriveExam v{APP_VERSION}</small>
          <button type="button" onClick={logout}>
            <LogOut size={17} />
            სისტემიდან გასვლა
          </button>
        </div>
      </aside>
    </>
  );
}
