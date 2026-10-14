import Link from "next/link";
import { MapPinOff } from "lucide-react";

export default function NotFound() {
  return (
    <main className="fatal-state-v18">
      <div>
        <span><MapPinOff size={22} /></span>
        <small>404</small>
        <h1>გვერდი ვერ მოიძებნა</h1>
        <p>მისამართი შეიძლება შეიცვალა ან გვერდი აღარ არსებობს.</p>
        <Link className="button button-primary" href="/">მთავარ გვერდზე დაბრუნება</Link>
      </div>
    </main>
  );
}
