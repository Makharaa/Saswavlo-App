import Link from "next/link";
import {
  ArrowUpRight,
  Map,
  Navigation,
  Route,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { AppHeader } from "@/components/app-header";
import { Badge, Surface } from "@/components/ui";
import { requireUser } from "@/lib/auth";

export default async function HomePage() {
  const user = await requireUser();
  const canUseRoutes = user.role === "admin" || user.canUseRoutes;

  return (
    <main className="site-shell">
      <AppHeader />

      <section className="hero-wrap">
        <div className="hero-copy">
          <Badge tone={canUseRoutes ? "success" : "warning"}>
            {canUseRoutes
              ? "რეალური GPS რეჟიმი"
              : "მარშრუტებზე წვდომა შეზღუდულია"}
          </Badge>

          <h1>
            მართვის გამოცდისთვის
            <br />
            <span>უფრო ჭკვიანი მომზადება.</span>
          </h1>

          <p>
            გაიარე საგამოცდო მარშრუტი რეალურ მანქანაში. სისტემა
            მიჰყვება შენს მდებარეობას, გაძლევს ხმოვან მითითებებს, გაჩვენებს
            სიჩქარის ლიმიტს და ინახავს გავლილი სესიის შედეგებს. ქალაქი,
            რომელიც ბოლოს გქონდა გახსნილი, შემდეგ შესვლაზეც იგივე რჩება.
          </p>

          <div className="hero-actions">
            <Link
              className="button button-primary button-large"
              href={canUseRoutes ? "/drive" : "/access-restricted"}
            >
              {canUseRoutes ? "მართვის რეჟიმის დაწყება" : "წვდომის ინფორმაცია"}
              <ArrowUpRight size={18} />
            </Link>

            {canUseRoutes && (
              <Link
                className="button button-secondary button-large"
                href="/routes"
              >
                მარშრუტების ნახვა
              </Link>
            )}
          </div>
        </div>

        <Surface className="hero-map-card">
          <div className="mini-map-grid" />
          <div className="mock-route-line" />

          <div className="hero-floating hero-floating-top">
            <Navigation size={18} />
            180 მეტრში მოუხვიეთ მარჯვნივ
          </div>

          <div className="hero-speed">
            <small>ლიმიტი</small>
            <strong>40</strong>
          </div>

          <div className="hero-location-dot" />
        </Surface>
      </section>

      <section className="feature-grid">
        <Surface>
          <Navigation size={24} />
          <h3>რეალური GPS</h3>
          <p>რუკა მოძრაობისას რეალურად მიჰყვება მანქანის მდებარეობას.</p>
        </Surface>

        <Surface>
          <Route size={24} />
          <h3>რამდენიმე მარშრუტი</h3>
          <p>ქალაქის მარშრუტები ცალკე შეგიძლია აირჩიო, დაამატო და მართო.</p>
        </Surface>

        <Surface>
          <Map size={24} />
          <h3>გზის ჩაწერა</h3>
          <p>
            მანქანით გავლისას ჩაიწერე გზა და მიმდინარე ადგილას დაამატე
            საკონტროლო წერტილები.
          </p>
        </Surface>

        <Surface>
          <Smartphone size={24} />
          <h3>მობილურზე მორგებული</h3>
          <p>მართვის რეჟიმი გათვლილია რეალურ მანქანაში ტელეფონით გამოყენებაზე.</p>
        </Surface>

        <Surface>
          <ShieldCheck size={24} />
          <h3>ვარჯიში და გამოცდა</h3>
          <p>
            ვარჯიშის რეჟიმში მიიღებ მეტ დახმარებას, გამოცდის რეჟიმში კი
            ინტერფეისი მინიმალურია.
          </p>
        </Surface>
      </section>
    </main>
  );
}
