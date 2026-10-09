const paths: Record<string, string> = {
  today: "M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9",
  conversations: "M4 4h16v12H9l-5 4V4m4 5h8m-8 3h5",
  tasks: "M8 4h12v17H4V4h4m0-2h8v4H8V2m0 9 2 2 5-5m-7 9h8",
  contacts: "M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.2a4 4 0 0 1 0 7.6M22 21v-2a4 4 0 0 0-3-3.87",
  companies: "M4 21V3h12v18M2 21h20M16 9h4v12M8 7h4m-4 4h4m-4 4h4m-3 6v-3h2v3",
  inquiries: "M5 3h14v18H5V3m4 5h6m-6 4h6m-6 4h3",
  deals: "M3 5h5v14H3V5m7 0h5v10h-5V5m7 0h4v7h-4V5",
  documents: "M7 3h8l5 5v13H7V3m8 0v5h5M10 13h7M10 17h7M10 9h2",
  control: "M5 3v5m0 4v9M12 3v10m0 4v4M19 3v2m0 4v12M2 8h6v4H2V8m7 5h6v4H9v-4m7-8h6v4h-6V5",
  integrations: "M8 3v5m8-5v5M5 8h14v3a7 7 0 0 1-7 7v4M5 8v3a7 7 0 0 0 7 7",
  stats: "M4 3v17h17M8 15v-4m5 4V7m5 8V4",
  billing: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 9h18M7 15h4",
  "ai-managers": "M12 3v3M7 6h10a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3ZM2 11v5M22 11v5M8 11h.01M16 11h.01M9 16h6",
  settings: "M9.88 5.07 10.51 2.62h2.98l.63 2.45 1.28.53 2.18-1.29 2.11 2.11-1.29 2.18.53 1.28 2.45.63v2.98l-2.45.63-.53 1.28 1.29 2.18-2.11 2.11-2.18-1.29-1.28.53-.63 2.45h-2.98l-.63-2.45-1.28-.53-2.18 1.29-2.11-2.11 1.29-2.18-.53-1.28-2.45-.63v-2.98l2.45-.63.53-1.28-1.29-2.18 2.11-2.11 2.18 1.29ZM15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z",
  help: "M9.1 9a3 3 0 1 1 4.2 2.7c-.8.5-1.3 1-1.3 2M12 17.5h.01",
  more: "M4 6h16M4 12h16M4 18h16",
};

const ADMIN_ICONS: Record<string, string> = {
  companies: "companies",
  members: "contacts",
  support: "help",
  integrations: "integrations",
  billing: "billing",
  "ai-managers": "ai-managers",
  "ai-usage": "stats",
  settings: "settings",
  audit: "control",
};

export function NavIcon({ to, className = "" }: { to: string; className?: string }) {
  const parts = to.replace(/^\//, "").split("/");
  const key = parts[0] === "admin" ? ADMIN_ICONS[parts[1] || ""] || "today" : parts[0] || "today";
  return <svg className={`nav-icon ${className}`.trim()} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[key] || paths.today} /></svg>;
}
