import HistoryPage from "@/app/history/page";
import { requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function MyHistoryPage() {
  await requireUser();
  return <HistoryPage mineOnly />;
}
