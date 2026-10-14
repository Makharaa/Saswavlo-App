import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, LockKeyhole, ShieldAlert } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Surface } from "@/components/ui";
import { requireUser } from "@/lib/auth";

export default async function AccessRestrictedPage() {
  const user = await requireUser();

  if (user.role === "admin" || user.canUseRoutes) {
    redirect("/routes");
  }

  return (
    <main className="site-shell access-restricted-page">
      <AppHeader />
      <section className="access-restricted-wrap">
        <Surface className="access-restricted-card">
          <div className="access-restricted-icon">
            <LockKeyhole size={28} />
          </div>
          <span className="access-restricted-kicker">
            <ShieldAlert size={14} /> ანგარიშის პარამეტრი
          </span>
          <h1>მარშრუტებზე წვდომა შეზღუდულია</h1>
          <p>
            ამ ანგარიშისთვის მარშრუტების ნახვა და მართვის რეჟიმის გამოყენება
            ადმინისტრატორის მიერ გამორთულია. წვდომის აღსადგენად მიმართე ადმინისტრატორს.
          </p>
          <Link href="/" className="button button-secondary">
            <ArrowLeft size={16} /> მთავარ გვერდზე დაბრუნება
          </Link>
        </Surface>
      </section>
    </main>
  );
}
