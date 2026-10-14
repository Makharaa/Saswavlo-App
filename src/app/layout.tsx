import type { Metadata } from "next";
import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "DriveExam",
  description: "მართვის გამოცდის მარშრუტების GPS სავარჯიშო სისტემა"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ka">
      <body>{children}</body>
    </html>
  );
}
