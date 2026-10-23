import Link from "next/link";
import { Logo } from "@/components/Logo";
import { LegalFooter } from "@/components/LegalFooter";

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="legal-wrap">
      <header className="legal-head"><Link href="/" aria-label="RelationNote トップへ"><Logo size={30} wordSize={16} /></Link></header>
      <article className="legal-body">{children}</article>
      <LegalFooter />
    </div>
  );
}
