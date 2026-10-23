import type { Metadata } from "next";
import { OPERATOR, PRICING, withTax, yen } from "@/lib/legal";

export const metadata: Metadata = { title: "特定商取引法に基づく表記" };

export default function Tokushoho() {
  const rows: [string, React.ReactNode][] = [
    ["販売事業者", OPERATOR.name],
    ["運営統括責任者", OPERATOR.representative],
    ["所在地", OPERATOR.address],
    ["電話番号", OPERATOR.phone],
    ["メールアドレス", OPERATOR.email],
    ["販売価格", <>標準プラン：月払い {yen(PRICING.monthly)}（税込 {yen(withTax(PRICING.monthly))}）／年払い {yen(PRICING.yearly)}（税込 {yen(withTax(PRICING.yearly))}）<br />上位プランは個別のお見積もりによります。</>],
    ["商品代金以外の必要料金", "インターネット接続に必要な通信料はお客様のご負担です。初期費用はかかりません。"],
    ["お支払い方法", "クレジットカード（Stripe による決済）"],
    ["お支払い時期", <>組織の作成から{PRICING.trialDays}日間は無料です。お申し込み後、無料期間の終了日に初回の料金を請求し、以降は月払いなら毎月、年払いなら毎年、同じ日に自動で請求します。</>],
    ["サービスの提供時期", "お申し込みの手続きが完了した時点から直ちにご利用いただけます。"],
    ["解約", "組織設定の「料金・契約」からいつでも解約の手続きができます。解約後も、支払い済みの期間の終わりまでご利用いただけます。日割りの返金は行いません。"],
    ["返品・返金", "サービスの性質上、お支払い後の返金には応じかねます。ただし当社の責めに帰すべき事由によりサービスを提供できなかった場合はこの限りではありません。"],
    ["動作環境", "最新版の Google Chrome、Microsoft Edge、Safari、Firefox"],
  ];
  return (
    <>
      <h1>特定商取引法に基づく表記</h1>
      <table className="legal-table"><tbody>
        {rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}
      </tbody></table>
    </>
  );
}
