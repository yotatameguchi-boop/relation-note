// 利用規約・プライバシーポリシー・特定商取引法に基づく表記で使う事業者情報と版。
// 【要記入】の箇所は運営者が埋める。公開前に専門家（弁護士等）の確認を受けること。
// 規約の内容を変えたら TERMS_VERSION を上げる（ログイン中のスタッフに再同意を求める）。

export const TERMS_VERSION = "2026-10-25";
export const TERMS_EFFECTIVE = "2026年10月25日";

export const OPERATOR = {
  name: "【要記入：事業者の氏名または名称】",
  representative: "【要記入：代表者または運営統括責任者】",
  address: "【要記入：所在地】",
  // 個人事業主で住所・電話番号を省略する場合は「請求があれば遅滞なく開示します」と書く（特商法 第11条ただし書）
  phone: "【要記入：電話番号（受付時間）】",
  email: "【要記入：お問い合わせ用メールアドレス】",
  privacyContact: "【要記入：個人情報の取り扱いに関する窓口】",
};

export const PRICING = {
  monthly: 4980,
  yearly: 49800,
  taxRate: 0.1,
  trialDays: 30,
};

export const withTax = (yen: number) => Math.floor(yen * (1 + PRICING.taxRate));
export const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;

/** 外部の委託先（プライバシーポリシーに列挙） */
export const SUBPROCESSORS = [
  { name: "Supabase, Inc.", purpose: "データベース・ファイル保存・認証（保存先：日本（東京）リージョン）" },
  { name: "Vercel Inc.", purpose: "アプリケーションの配信（処理拠点：日本（東京）ほか）" },
  { name: "Stripe, Inc.／Stripe Japan株式会社", purpose: "利用料金の決済（カード情報は当サービスでは保持しません）" },
  { name: "Google LLC", purpose: "メール送信（Gmail）、Google フォーム・スプレッドシートの連携（利用者が連携した場合のみ）" },
  { name: "Amazon Web Services, Inc.", purpose: "写真の人数推定（人物検出）。有効にした組織の写真のみ" },
];
