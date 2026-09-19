export function BrandLogo({ variant = "nav" }: { variant?: "nav" | "login" }) {
  return (
    <img
      className={`brand-logo brand-logo-${variant}`}
      src="/basqar-logo.png"
      alt="BasQar"
    />
  );
}
