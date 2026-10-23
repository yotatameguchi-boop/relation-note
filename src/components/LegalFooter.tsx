import Link from "next/link";

export function LegalFooter() {
  return (
    <footer className="legal-footer small muted">
      <Link href="/terms">利用規約</Link>
      <Link href="/privacy">プライバシーポリシー</Link>
      <Link href="/legal">特定商取引法に基づく表記</Link>
      <span>© RelationNote</span>
    </footer>
  );
}
