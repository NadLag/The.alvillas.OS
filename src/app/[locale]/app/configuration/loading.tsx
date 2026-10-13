import { AdminShell, SkeletonBlock } from "@/design-system/shells";

export default function ConfigurationLoading() {
  return (
    <AdminShell className="resource-page">
      <SkeletonBlock rows={6} />
      <SkeletonBlock rows={8} />
    </AdminShell>
  );
}
