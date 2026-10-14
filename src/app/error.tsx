"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="fatal-state-v18">
      <div>
        <span><AlertTriangle size={22} /></span>
        <small>DriveExam</small>
        <h1>გვერდის ჩატვირთვისას შეცდომა მოხდა</h1>
        <p>მონაცემები არ წაშლილა. სცადე გვერდის ხელახლა ჩატვირთვა.</p>
        <button className="button button-primary" onClick={reset}><RotateCcw size={16} /> თავიდან ცდა</button>
      </div>
    </main>
  );
}
