import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

export function Surface({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`surface ${className}`} {...props} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Button({ className = "", variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props} />;
}

export function Metric({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {unit && <small>{unit}</small>}
    </div>
  );
}
