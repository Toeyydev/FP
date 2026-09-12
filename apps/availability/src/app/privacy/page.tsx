import type { Metadata } from "next";
import { NOTICE_VERSION, thaiSections, englishSections, type NoticeSection } from "@/lib/privacy-notice";

// The one page on this site anyone can open without signing in: Google Play will
// not accept a privacy policy behind a login. The wording is the same Notice the
// guide app shows (lib/privacy-notice), in both languages, one after the other —
// a public policy page has no one to ask which language they prefer.
//
// Excluded from the auth middleware; see src/middleware.ts.

export const metadata: Metadata = {
  title: "Privacy Notice · Folkpaths",
  description: "How Folkpaths collects and uses personal data in the FolkOPS guide app.",
};

export default function PrivacyPage() {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "40px 24px 72px", color: "#17251F", fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif", lineHeight: 1.6 }}>
      <header style={{ marginBottom: 36 }}>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 700, letterSpacing: 1, color: "#B45309", textTransform: "uppercase" }}>Folkpaths</p>
        <h1 style={{ margin: "8px 0 4px", fontSize: 32, lineHeight: 1.25 }}>ประกาศความเป็นส่วนตัว · Privacy Notice</h1>
        <p style={{ margin: 0, color: "#68756E", fontSize: 15 }}>สำหรับผู้สมัครมัคคุเทศก์ FolkOPS · For FolkOPS guide applicants</p>
        <p style={{ margin: "6px 0 0", color: "#849089", fontSize: 13 }}>เวอร์ชันประกาศ / Notice version: {NOTICE_VERSION}</p>
      </header>

      <Notice heading="ภาษาไทย" sections={thaiSections} />
      <hr style={{ border: 0, borderTop: "1px solid #E2E6E3", margin: "48px 0" }} />
      <Notice heading="English" sections={englishSections} />

      <p style={{ marginTop: 48, color: "#68756E", fontSize: 14 }}>
        บริษัท โฟล์คพาธส์ จำกัด · Folkpaths Co., Ltd. — admin@folkpaths.com
      </p>
    </main>
  );
}

function Notice({ heading, sections }: { heading: string; sections: NoticeSection[] }) {
  return (
    <section>
      <h2 style={{ fontSize: 14, fontWeight: 700, letterSpacing: 1, color: "#68756E", textTransform: "uppercase", marginBottom: 20 }}>{heading}</h2>
      {sections.map((section, i) => (
        <section key={section.title} style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 17, margin: "0 0 6px" }}>{i + 1}. {section.title}</h3>
          <p style={{ margin: 0, color: "#4E5D55", fontSize: 15 }}>{section.body}</p>
        </section>
      ))}
    </section>
  );
}
