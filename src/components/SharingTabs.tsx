import Link from "next/link";

export function SharingTabs({ orgId, current, manage, view }: { orgId: string; current: string; manage: boolean; view: boolean }) {
  const base = `/orgs/${orgId}/sharing`;
  const tabs = [
    { key: "partners", href: base, label: "組織連携", show: manage || view },
    { key: "authorizations", href: `${base}/authorizations`, label: "共有根拠", show: manage },
    { key: "new", href: `${base}/new`, label: "共有を設定", show: manage },
    { key: "outgoing", href: `${base}/outgoing`, label: "自組織から共有中", show: manage },
    { key: "received", href: `${base}/received`, label: "他組織から共有された活動者", show: view },
    { key: "audit", href: `${base}/audit`, label: "共有履歴", show: manage },
  ];
  return (
    <div className="row" style={{ marginBottom: 14 }}>
      {tabs.filter((t) => t.show).map((t) => (
        <Link key={t.key} href={t.href} className={t.key === current ? "btn btn-small" : "btn btn-secondary btn-small"}>{t.label}</Link>
      ))}
    </div>
  );
}

export function SharingDisabled() {
  return (
    <div className="card">
      <h1>組織間共有</h1>
      <p className="muted">組織間の連携・活動者データ共有は、この組織ではまだ有効になっていません（機能フラグ partner_sharing）。</p>
      <p className="small muted">有効化は運営側で行います。実データで使う前に、検証用の組織で動作を確認してください。</p>
    </div>
  );
}
