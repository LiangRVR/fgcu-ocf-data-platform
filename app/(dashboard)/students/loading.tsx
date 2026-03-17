import { ListPageLoading } from "@/components/ui/list-page-loading";

export default function StudentsLoading() {
  return <ListPageLoading stats={4} headerBadges={2} pills={4} showBanner rows={6} />;
}
