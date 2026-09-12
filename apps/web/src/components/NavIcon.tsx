const paths: Record<string, string> = {
  today: "M3 10 12 3l9 7M5 9v11h5v-6h4v6h5V9",
  conversations: "M4 4h16v12H9l-5 4V4m4 5h8m-8 3h5",
  tasks: "M8 4h12v17H4V4h4m0-2h8v4H8V2m0 9 2 2 5-5m-7 9h8",
  contacts: "M16 21v-2a5 5 0 0 0-10 0v2m5-18a4 4 0 1 0 0 8 4 4 0 0 0 0-8m7 1a4 4 0 0 1 0 7m4 10v-2a5 5 0 0 0-4-5",
  companies: "M4 21V3h12v18M2 21h20M16 9h4v12M8 7h4m-4 4h4m-4 4h4m-3 6v-3h2v3",
  inquiries: "M5 3h14v18H5V3m4 5h6m-6 4h6m-6 4h3",
  deals: "M3 5h5v14H3V5m7 0h5v10h-5V5m7 0h4v7h-4V5",
  documents: "M7 3h8l5 5v13H7V3m8 0v5h5M10 13h7M10 17h7M10 9h2",
  control: "M5 3v5m0 4v9M12 3v10m0 4v4M19 3v2m0 4v12M2 8h6v4H2V8m7 5h6v4H9v-4m7-8h6v4h-6V5",
  integrations: "M8 3v5m8-5v5M5 8h14v3a7 7 0 0 1-7 7v4M5 8v3a7 7 0 0 0 7 7",
  stats: "M4 3v17h17M8 15v-4m5 4V7m5 8V4",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m-2-5h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3 3-3",
};

export function NavIcon({ to }: { to: string }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[to.split("/")[1]] || paths.today} /></svg>;
}
