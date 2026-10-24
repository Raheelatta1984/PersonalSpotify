import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100dvh", padding: 24, textAlign: "center" }}>
      <div>
        <h1 style={{ fontSize: 40, margin: 0 }}>404</h1>
        <p style={{ color: "#9aa3b5", marginTop: 8 }}>That page isn&apos;t in the library.</p>
        <Link className="btn primary" href="/" style={{ display: "inline-block", marginTop: 16 }}>
          Back to SongHub
        </Link>
      </div>
    </div>
  );
}
