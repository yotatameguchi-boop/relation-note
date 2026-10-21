# RelationNote（リレーションノート）

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

## デモ環境（公開中）

- URL：https://relationnote.vercel.app （Vercel・東京リージョン、チーム yotatameguchi-boops-projects / プロジェクト relation-note）
- Supabase：`relation-note`（ref `sufuttgmkfmpsscuqdld`、東京、無料プラン、組織 yotatameguchi-boop's Org）
- ワーカー：Edge Function `process-jobs`（`DETECTOR=mock`）を Supabase Cron が毎分起動
- デモ用ログインは手元の `.env.remote`（Git 管理外）の `DEV_LOGIN_EMAIL` / `DEV_LOGIN_PASSWORD`
- デモデータの入れ直し：`ENV_FILE=.env.remote ALLOW_NON_LOCAL=1 node scripts/seed-dev.mjs && ENV_FILE=.env.remote ALLOW_NON_LOCAL=1 node scripts/seed-demo-features.mjs`
- GitHub 連携：`main` に push すると本番へ自動デプロイ（他のブランチはプレビュー。プレビューも同じデモ用 Supabase につながる。プレビューは Vercel の保護で関係者のみ閲覧可）
- 注意：デモのため、メールアドレスの確認なしで新規登録できる設定（`mailer_autoconfirm`）。人物検出はダミー。実在の個人情報は入れないこと

## 本番に向けて人が行う作業

1. Supabase プロジェクト（東京リージョン想定）を作成し `supabase db push`、`supabase functions deploy process-jobs`
2. Edge Function のシークレット: `WORKER_SECRET`、`DETECTOR=rekognition`、`AWS_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`
3. Vault に `project_url`（`https://<ref>.supabase.co`）と `worker_secret` を登録（`scripts/setup-local-cron.sh` と同じ内容）
4. Vercel に Next.js をデプロイし、`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_APP_URL` を設定
5. Supabase Auth のメール送信（SMTP）とリダイレクトURLを本番ドメインに設定

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
- 課金・契約（決済連携、プラン変更の申し込み、解約時の出力猶予・削除）は未実装。プランと利用枠は DB の `plans` で管理し、変更はサービスロールのみ
- 招待はリンクを画面に表示する方式で、メール送信はしていない
- 外部フォーム連携は汎用 Webhook（JSON）のみ。対応サービスは実際の利用に合わせて追加する
- 負荷試験（§6 の想定データ量）、バックアップの復元試験、監視（キュー滞留・解析失敗・費用）の設定は未実施
- 料金・利用上限・保存期間・関係人口の定義はすべて仮案（設定や `plans` で変更可能）
