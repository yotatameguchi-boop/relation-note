# RelationNote

顧客・関係者のつながりをまとめて管理。顧客や関係者のデータを組織ごとに管理する汎用のSaaS

基本設計書 v0.1（2026-10-21）に沿った実装です。最初の想定利用者はNPO（基本設計書の前提）。複数の組織が共通基盤を使うマルチテナント型で、
応募フォームの回答を人物単位に整理し、イベント参加履歴と、写真からの人数推定を管理します。

## 構成

| 設計書 | 実装 |
| --- | --- |
| 画面・業務API | Next.js 16（App Router / Server Actions / Route Handlers）・TypeScript |
| DB・組織分離 | Supabase PostgreSQL。全主要テーブルに `organization_id`、外部キーにも組織IDを含め、RLS で参照・追加・更新・削除を制御 |
| 認証・権限 | Supabase Auth ＋ `memberships`（オーナー／管理者／編集者／閲覧者 ＋ 一括出力・一括削除・人物統合・権限変更の個別権限） |
| 写真保存 | Supabase Storage の非公開バケット。アップロードは期限付きURL、閲覧は所属メンバーのみ期限付きURL |
| 非同期処理 | Supabase Queues（pgmq）＋ Edge Function `process-jobs` ＋ Supabase Cron（毎分起動） |
| 人物検出 | Amazon Rekognition DetectLabels（Person）。開発用にダミー検出器（`DETECTOR=mock`） |

ディレクトリ:

- `supabase/migrations/` … スキーマ・RLS・業務ロジック（名寄せ、統合、利用枠、ジョブ、集計）
- `supabase/functions/process-jobs/` … ワーカー（写真解析・回答の取り込み・一括出力・期限切れ整理）
- `src/app/orgs/[orgId]/` … 管理画面
- `src/app/api/` … アップロード・取り込み・外部フォーム受信・出力ダウンロード
- `tests/` … 単体テストと、ローカルSupabaseに対する受け入れテスト

## ローカルで動かす

```bash
npm install
supabase start -x studio,postgres-meta,imgproxy,vector,logflare,realtime,supavisor
supabase status -o env   # 値を .env.local に転記（.env.example 参照）
cp supabase/functions/.env.example supabase/functions/.env   # WORKER_SECRET を設定
supabase functions serve --env-file supabase/functions/.env --no-verify-jwt   # ワーカー
./scripts/setup-local-cron.sh   # Cron から毎分ワーカーを呼ぶための Vault 登録
node scripts/seed-dev.mjs       # デモ組織とサンプルデータ（任意）
npm run dev                     # http://localhost:3080
```

ポートは他プロジェクトと衝突しないよう API 55621 / DB 55622 にしています。
CSV取り込みの試験用ファイル: `scripts/sample-volunteer-form.csv`

## テスト

```bash
npm test
```

ローカルの Supabase が起動している必要があります。設計書 §16 の受け入れ条件のうち、自動で確かめられるものを網羅しています。

- 別組織のデータを API・DB・ストレージから取得・変更できない（他組織IDでの登録、外部キーでの越境、organization_id の付け替え、他組織の写真・出力ファイル、ワーカー専用関数）
- 退会・権限変更が即座に反映される／最後のオーナーは削除・脱退できない
- 同じ回答・ジョブを再送しても二重登録されない（回答ID・原文ハッシュ、Webhook 再送、解析結果の保存の繰り返し、同じ写真のジョブ）
- 名寄せが曖昧な人物（連絡先だけ一致、氏名だけ一致）を自動統合しない
- 推定人数と確定人数を別に保存し、写真人数を参加人数・実参加者数に合算しない
- 利用上限到達時は新規処理を止め（CSV は保留）、既存データは閲覧できる／停止中の組織は閲覧のみ
- 失敗ジョブの再試行・隔離・再実行、隔離分は利用枠に計上しない

## 名寄せのルール（§4.2）

| 状況 | 結果 |
| --- | --- |
| メールまたは電話が一致し、氏名も一致する人物が1人 | 既存人物に紐づけ（空欄の補完と連絡先・タグの追加のみ。上書きしない） |
| メール・電話は一致するが氏名が違う | 確認待ち（家族で共有している可能性） |
| 氏名だけ一致 | 確認待ち（同姓同名の可能性） |
| 一致なし | 新規作成 |

確認待ちは「確認待ちの回答」画面でスタッフが判断します。登録済み人物どうしの重複は「重複候補」画面で統合でき、統合前の状態は履歴に残ります。

## 集計の扱い（§5）

- イベント参加人数 = スタッフ確定値があればそれ、なければ「参加確認済みの記録＋匿名参加者」
- 延べ参加人数 = 期間内のイベント参加人数の合計
- 実参加者数 = 参加確認済みの人物の重複除外（匿名参加者は含められない）
- 継続参加者数・関係人口 = 組織設定の回数・期間で判定
- 写真の人数はイベントごとの最大値を参考表示するだけで、合算も自動転記もしない

## 顧客管理の機能

- **項目の追加**：組織ごとに人物・企業の項目を定義（文字・数値・日付・選択肢・チェックなど10種類）。値は型を検証して保存し、CSV出力・フォームの取り込み（対応先「追加項目」）にも対応
- **企業（法人）**：企業の台帳と、担当者（人物）の紐づけ（部署・役職・主担当）
- **やりとりの記録**：電話・面談・メール・訪問・オンラインを時系列で記録。人物の画面では、やりとり・メモ・イベント参加・フォーム回答をまとめたタイムラインを表示。記録と同時に次の予定をタスクにできる
- **タスク**：担当・期限・優先度・対象（人物/企業）。期限切れ・今日のタスクはメニューに件数を表示し、毎朝8時に担当者へメールで通知（メール送信の設定後）
- **メールの一斉配信**：タグ（いずれか／すべて／除外）で宛先を決め、プレビュー・自分あてのテスト送信のあと送信。1人1通・同じアドレスは1通・配信停止は除外。
  送信は非同期で「多くて1回」（送信中に止まった宛先は再送せず「送信不明」にする。接続できない障害は未送信なので再試行）。
  開封は画像の読み込みで推定。末尾に送信者情報と配信停止リンクを付け、送信時に宛先の同意を確認する（特定電子メール法への配慮）。
  送った記録は人物のタイムラインに残る（削除不可）。一斉配信は「一斉メール配信」の権限が必要。今月の送信数はプランの枠（標準 1,000通）で管理

### メール送信の設定

ワーカー（Edge Function）の環境変数 `MAIL_TRANSPORT=smtp`・`SMTP_*`・`MAIL_FROM`・`APP_URL`（`supabase/functions/.env.example` 参照）を設定し、
Vercel の環境変数 `MAIL_SENDING_CONFIGURED=1` を入れると画面の送信ボタンが有効になる。Edge Functions は 25・587 番ポートに接続できないため、Gmail は 465 を使う。
ローカルでは Supabase 付属のテスト用メールサーバー（Mailpit、http://127.0.0.1:55624）に送られ、外部には届かない。

## 外部データとのコネクト（自動取り込み）

「取り込み・連携」でフォーム（取り込み元）を作るときに方式を選ぶ。取り込んだ回答は CSV と同じ流れ（二重取り込み防止 → 名寄せ → 確認待ち）に乗る。

| 方式 | 仕組み | 利用者の操作 |
|---|---|---|
| Google フォーム | OAuth（読み取り専用）で連携し、Forms API から前回以降の回答を定期取得（既定15分ごと） | 「Google と連携」→ フォームの URL を貼る → 提案された項目の対応を確認 →「自動取り込みを始める」 |
| Google スプレッドシート | 同上。Sheets API で1行目を見出しとして読み、内容が同じ行は二重に取り込まない | 同上（シート名は任意） |
| Typeform / Tally | 相手のサービスから Webhook。署名（HMAC-SHA256）で送信元を確認 | 「署名用の秘密を発行」→ 相手の Webhook 設定に URL と秘密を入れる |
| 汎用 Webhook | `Authorization: Bearer <秘密>` 付きの JSON | Apps Script などから送る |

- 連携の鍵（Google のリフレッシュトークン・署名用の秘密）は Supabase Vault に暗号化して保存し、利用者向け API からは読めない。連携を削除すると鍵も消える
- 「氏名」の対応が決まるまで届いた回答は保留にし、対応を保存すると自動で処理する
- Google の連携が取り消されたら「連携し直してください」にして自動取得を止める
- Google を使うには Google Cloud で OAuth クライアント（ウェブアプリ）を作り、`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を Vercel と Edge Function の両方に設定する。
  承認済みのリダイレクト URI は `https://relationnote.vercel.app/api/connectors/google/callback`。
  フォームの回答・スプレッドシートの読み取りは Google の「機密性の高いスコープ」のため、一般公開には Google の審査が必要（審査前はテストユーザーに登録した100人まで）
- ローカルでは `node scripts/mock-google.mjs`（Google を模した疑似サーバー）で、連携から取り込みまで確認できる。本物の Google での検証ではない

## デモ環境（公開中）

- URL：https://relationnote.vercel.app （Vercel・東京リージョン、チーム yotatameguchi-boops-projects / プロジェクト relation-note）
- Supabase：`relation-note`（ref `sufuttgmkfmpsscuqdld`、東京、無料プラン、組織 yotatameguchi-boop's Org）
- ワーカー：Edge Function `process-jobs`（`DETECTOR=mock`）を Supabase Cron が毎分起動
- デモ用ログインは手元の `.env.remote`（Git 管理外）の `DEV_LOGIN_EMAIL` / `DEV_LOGIN_PASSWORD`
- デモデータの入れ直し：`ENV_FILE=.env.remote ALLOW_NON_LOCAL=1 node scripts/seed-dev.mjs`、続けて同じ指定で `seed-demo-features.mjs`・`seed-demo-crm.mjs`
- GitHub 連携：`main` に push すると本番へ自動デプロイ（他のブランチはプレビュー。プレビューも同じデモ用 Supabase につながる。プレビューは Vercel の保護で関係者のみ閲覧可）
- 注意：デモのため、メールアドレスの確認なしで新規登録できる設定（`mailer_autoconfirm`）。人物検出はダミー。実在の個人情報は入れないこと

## 本番に向けて人が行う作業

1. Supabase プロジェクト（東京リージョン想定）を作成し `supabase db push`、`supabase functions deploy process-jobs`
2. Edge Function のシークレット: `WORKER_SECRET`、`DETECTOR=rekognition`、`AWS_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`
3. Vault に `project_url`（`https://<ref>.supabase.co`）と `worker_secret` を登録（`scripts/setup-local-cron.sh` と同じ内容）
4. Vercel に Next.js をデプロイし、`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_APP_URL` を設定
5. Supabase Auth のメール送信（SMTP）とリダイレクトURLを本番ドメインに設定

## ログインのセキュリティ（パスワード・二段階認証）

- パスワードは10文字以上で、英字と数字の両方を含むもの（Supabase Auth の設定でサーバー側でも拒否。画面でも事前に確認）。メールアドレスの一部を含むものは画面で拒否。パスワードの変更は「アカウント設定」から（今のパスワードを確認してから変更）
- 二段階認証（TOTP：Google Authenticator・Microsoft Authenticator などの6桁のコード）。「アカウント設定」で QR を読み取って登録。予備の端末も登録できる（最大10）
- 二段階認証を設定した人は、パスワードの後にコードを入力するまでどの画面にも入れない（`src/proxy.ts`）
- 組織のオーナーは「組織設定 → セキュリティ」で**二段階認証を必須**にできる。必須の組織のデータは、コード入力まで済ませたログイン（aal2）でしか読めない。画面だけでなく RLS が使う権限判定（`my_org_ids`・`has_role`・`has_perm`）で強制するので、API を直接呼んでも回避できない。締め出し防止のため、必須にできるのは自分が二段階認証済みのオーナーだけ。管理者はスタッフの設定状況を確認できる
- 端末をすべて失った人：組織の管理者からの依頼と本人確認のうえ、運営者が `ENV_FILE=.env.remote node scripts/reset-mfa.mjs <メールアドレス>` で解除する
- ログインの試行が続くと Supabase Auth が一時的に受け付けを止める（回数の上限は Supabase の設定）
- 未対応：漏えい済みパスワードの照合（Supabase Pro の機能）、一定時間操作がないときの自動ログアウト（同じく Pro の機能）、SSO

## グラフ分析

- 「グラフ分析」（`/orgs/:id/insights`）で、知りたいことを文章で入力すると、指標・切り口・内訳・期間に読み取ってグラフにする（例：「今年の新規登録数を月別に」「地域別の人数」「直近6か月の参加数をタグ別の内訳で」）
- 読み取りは決まった言い回しによる判定（`src/lib/insights.ts` の `parseQuestion`）。生成AIは使わず、入力した文章を外部に送らない。読み取った条件は画面で確認・修正できる
- 指標：人数（総数・推移）、新規登録数、参加数（延べ）、参加者数（実人数）、イベント数、やりとり、フォーム回答、完了タスク、メール送信数
- 切り口：月・週・日・曜日、地域、タグ、関心分野、参加回数、所属企業の業種、選択式の追加項目、種類、イベント
- グラフ：折れ線・縦棒（積み上げ）・横棒・円（ドーナツ）。円は1人が1区分にだけ入る切り口のときだけ選べる。表表示・CSV 出力あり。よく見るグラフはダッシュボードに追加できる（編集者以上）
- 集計は DB 関数 `insight_query`（指標・切り口は一覧にあるものだけ受け付ける。RLS のまま実行）。10万人規模の組織で 0.35 秒以内
- 配色は色覚の多様性を含めて検証済み（ライト・ダークそれぞれの背景に対して）

## 料金・契約（Stripe）

- 料金：**標準プラン 月額1,700円**。年払いの有無・金額、税込みか税別かは未定
- **写真からの人数推定（人物検出）は別料金のオプション**（金額は未定）。標準プランには含めない
- 組織の作成から30日間は無料（`trialing`）。オーナーは「料金・契約」から申し込む。無料期間中に申し込んでも、請求は無料期間の終わりから
- カード情報は Stripe の画面（Checkout）で入力し、当サービスには届かない。支払い方法の変更・周期の変更・領収書・解約は Stripe のカスタマーポータル
- Stripe の通知（`/api/billing/webhook`）は署名を確かめ、イベントIDで1回だけ処理する。通知の順序に頼らず、毎回 Stripe から最新の契約を取り直して反映する
- 無料期間の終了・期間末を過ぎた解約・支払いが確認できないまま期間末から14日過ぎた場合は「停止中」（閲覧と出力のみ）。申し込めばすぐ再開する。運営者が手で止めた組織は、契約の更新で勝手に再開しない
- 毎時 `refresh_all_org_access()` が契約状態を確認する（pg_cron `npo-crm-org-access`）。無償で提供する組織は `subscription_status = 'complimentary'`
- **決済は未接続**（Stripe の契約がないため）。キーがない間は画面に「準備中」と出る。手元では疑似 Stripe（`node scripts/mock-stripe.mjs`）で申し込み〜解約〜再申し込みを確認済み。本物の Stripe での確認は未実施

有効にする手順（運営者）
1. Stripe で商品「標準プラン」を作り、月額1,700円の価格を作る（税別なら `tax_behavior=exclusive`、税込みなら `inclusive`）。消費税は税率（10%）を作るか Stripe Tax を使う
   - 写真の人数推定の別料金は、別の商品（定額の追加オプション、または解析枚数に応じた従量課金）として作る。どちらにするかは未定
2. Webhook の送信先に `https://relationnote.vercel.app/api/billing/webhook` を登録（イベント：`checkout.session.completed`、`customer.subscription.created/updated/deleted`、`invoice.paid`、`invoice.payment_failed`）
3. カスタマーポータルを有効にする（解約・支払い方法の変更・周期の変更を許可）
4. Vercel に `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_MONTHLY`、`STRIPE_PRICE_YEARLY`、（任意）`STRIPE_TAX_RATE_ID` を設定。まずテストモードの鍵（`sk_test_…`）で通しで確認する

## 利用規約・プライバシーポリシー・特定商取引法に基づく表記

- `/terms`、`/privacy`、`/legal`。ログイン画面と全画面の下部にリンク
- 事業者名・住所・連絡先・管轄裁判所は `src/lib/legal.ts` の **【要記入】を運営者が埋める**。**公開前に弁護士等の確認を受けること**（文面はひな形）
- 新規登録時に同意を必須にし、同意した版（`TERMS_VERSION`）と日時を `users` に記録。規約を改定したら `TERMS_VERSION` を上げると、ログイン中のスタッフに再同意を求める

## 監視

- `/api/health`：状態（ok／degraded／down）。`Authorization: Bearer <HEALTH_TOKEN>` 付きで指標と問題の一覧
- GitHub Actions `monitor`：30分ごとに確認し、異常なら Issue（ラベル `monitor`）を作成して GitHub からメールで知らせる。回復したら自動で閉じる。通知の経路は手動実行の `simulate_failure` で試せる
- 異常のときに見るもの：`worker_stale`（ワーカーが10分以上動いていない → Supabase の Edge Function のログと pg_cron の実行履歴）、`queue_backlog`（ジョブの滞留）、`dead_jobs_24h`（失敗の多発 → 「処理状況」画面）、`db_size`（容量。無料枠の上限は500MB）
- `HEALTH_TOKEN` は Vercel（本番・プレビュー）と GitHub の secrets に同じ値。手元の `.env.local` の `REMOTE_HEALTH_TOKEN`

## バックアップと復元

- 取得：`scripts/backup.sh`（保存先 `~/Claude/npo-crm-backups/日時/`。個人情報を含むのでリポジトリの外。30日より古いものは削除）
- 試験：`scripts/restore-test.sh <バックアップのフォルダ>`（本番と同じ版で空の Supabase を手元に立てて復元し、件数・RLS・ファイルのハッシュ・ログインを確認）
- **無料枠には自動バックアップがない**。有料化までは毎日 `scripts/backup.sh` を実行する
- 本番の障害で新しいプロジェクトへ戻す場合：新しいプロジェクトに `roles.sql` → `schema.sql` → `select pgmq.create('jobs')` → `set session_replication_role = replica` で `data.sql`（`restore-test.sh` と同じ順）。続けて `storage-sync.mjs upload`、マイグレーション履歴の `supabase migration repair`、pg_cron の予定と Vault の秘密の再設定、外部連携の再連携、Vercel の接続先の切り替え
- 結果：`eval/reports/operations-readiness.md`

## 負荷試験

- `node scripts/loadtest-setup.mjs`（手元に10万人規模の組織を作る）→ 本番ビルドを起動 → `BASE=http://localhost:3090 node scripts/loadtest.mjs 1,5,10,20,30 60`
- 結果：同時10人で95%が1.33秒（目標2秒以内を満たす）。試験で見つかった RLS・検索・上限確認の遅さを修正済み。詳細は `eval/reports/operations-readiness.md`

## 組織間の連携・活動者データ共有（機能フラグ `partner_sharing`）

- 連携（申請・承認・拒否・解除）と、活動者ごとの共有許可は別管理。連携の承認だけでは何も見えない
- 共有は一方向・再共有不可。共有先は共有元の `people` を一切読めず、公開済みスナップショット（`person_share_versions`）を DB 関数経由でだけ閲覧する
- 共有対象：表示名・氏名・居住地域・関心分野・スキル・選んだタグ・選んだ活動履歴（参加確認済み）・メール・電話。初期状態は未選択、連絡先は別枠で明示確認
- 共有根拠（本人同意など）をスタッフが記録。未記録・撤回・失効・範囲外・期限が根拠より長い場合は有効化できない。法的妥当性はアプリでは判断しない
- 元データの編集は自動反映しない。差分を確認して更新版を公開する。範囲の拡大は根拠を再確認
- 閲覧の可否は `share_grant_state()` で毎回判定（停止・期限・連携・根拠・機能フラグ・所属・権限）。期限切れは定期ジョブを待たずに閲覧不可
- 権限：`manage_sharing`（管理者以上に個別付与）、`view_shared`（閲覧用）。監査は `sharing_audit_logs`（本文は保存しない）
- 共有解除後もアプリ内で見えなくなるだけで、相手が既に閲覧・記録した内容まで回収はできない

## 写真の人数カウント強化（機能フラグ `photo_pipeline_v2`、領域分割は `photo_tiling`）

1. 検証：実際の形式・容量・縦横サイズ（sharp）、組織と利用枠
2. 解析用画像：EXIF の回転を反映して正立、位置情報などのメタデータを除去、長辺2048pxに縮小。座標の対応（`analysis_meta`）を記録。元ファイルの座標へは `uprightToRaw` で戻せる
3. 検出：プロバイダー境界（`_shared/detector.ts`）。人物クラスの枠のみ、顔検出は使わない
4. 整理：`_shared/counting.ts`。同じ解析内はほぼ同一の枠（IoU≥0.9）だけを重複とし、全体⇔領域の間は IoU≥0.55＋境界の包含判定。件数は単純加算しない
5. 保存：解析ラン（`photo_analysis_results` を拡張：版・設定・所要時間・API呼び出し数・確認を促す理由）と検出枠（`photo_detections`）
6. 修正・確定：画面で誤検出の削除・見逃しの追加・位置修正→`photo_reviews`（修正内容・修正時間）。再解析は新しい版として保存し、確定値は上書きしない

- 写真ファイルの重複はハッシュ（`content_sha256`）で検出。人物の重複判定とは別
- イベントの確定人数は `event_count_records`（人数・計測方法・根拠・参考写真・注記・確定者・日時）。写真人数は自動転記しない
- 利用者向けの解析枚数（`usage_records`）と外部API呼び出し（`analysis_usage_records`、試行単位）は別記録
- ジョブには実行期限（`jobs.deadline_at`）。期限切れ・失敗の隔離分は利用枠に計上しない
- 領域分割は最大6領域・1ジョブ7呼び出し・処理時間25秒まで。評価で改善を確認するまで既定では無効

### 精度評価

```bash
node scripts/eval-counting.mts synthetic --out eval/reports/synthetic.md   # 合成データ（実写真の精度ではない）
node scripts/eval-counting.mts real eval/dataset.json                     # 実写真（実際の検出APIを設定したワーカーが必要）
node scripts/eval-counting.mts sweep <評価用組織ID> eval/dataset.json       # tune で調整し test で評価（API呼び出しなし）
```

**実写真での精度評価は未実施**（評価用写真と検出APIの認証情報がないため）。`eval/reports/synthetic-2026-10-22.md` は合成データでのアルゴリズム比較で、
同一解析内で積極的に重複を除くと密集写真で別人をまとめて過小カウントが悪化することが分かったため、既定値を保守的（0.9）にした。
密集写真では検出枠方式そのものの見逃しが主な誤差要因になる見込みで、密度推定など別方式の要否は実写真の評価結果で判断する。

### 機能フラグの切り替え（ローカル・検証環境のみ）

```bash
node scripts/set-feature.mjs "<組織名またはID>" partner_sharing on
node scripts/set-feature.mjs "<組織名またはID>" photo_pipeline_v2 on
node scripts/set-feature.mjs "<組織名またはID>" photo_tiling on
```

## 未実施・未確定（設計書 §17 ほか）

- 組織間共有：実データでの有効化・本人同意の取得フロー（アプリ内）・共有データの保存期間は未実施／未確定
- **Rekognition の実写真評価は未実施**（AWS 認証情報がないため）。少人数・混雑・暗所・重なりの実写真で、正解人数との誤差と修正時間を測ってから採用を決める。縮小率（現在は長辺2560px）もその結果で決める
- **料金の変更（月額1,700円・写真解析は別料金）はまだアプリに反映していない**。画面・規約類・DB は旧案の月払い4,980円／年払い49,800円のまま（`src/lib/legal.ts` の `PRICING`、`plans` 表の `monthly_price_jpy`・`yearly_price_jpy`、料金・契約画面、特定商取引法に基づく表記）。写真解析を別料金にする仕組み（オプションの申し込み・有効な組織だけ解析できる制御・従量の集計）も未実装
- 決済（Stripe）は実装済みだが未接続。本物の Stripe での通し確認、上位プランの申し込み、停止から90日後のデータ削除の自動化は未実施
- 規約類は文面のひな形。事業者情報の記入と専門家の確認が必要
- 招待はリンクを画面に表示する方式で、メール送信はしていない
- 外部フォーム連携は汎用 Webhook（JSON）のみ。対応サービスは実際の利用に合わせて追加する
- 負荷試験は手元（10万人）と本番（デモ規模）で実施。本番の DB を有料プランにしたら、大規模データでやり直す。費用（外部APIの利用額）の監視は未実施
- 料金・利用上限・保存期間・関係人口の定義はすべて仮案（設定や `plans` で変更可能）
