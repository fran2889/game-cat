import type { ReactNode } from "react";

export interface PlaceholderViewProps {
  kicker: string;
  title: string;
  description: string;
  children?: ReactNode;
}

export function PlaceholderView({ kicker, title, description, children }: PlaceholderViewProps) {
  return (
    <section className="placeholder" aria-labelledby="placeholder-heading">
      <p className="placeholder-kicker">{kicker}</p>
      <h2 id="placeholder-heading">{title}</h2>
      <p>{description}</p>
      {children}
    </section>
  );
}
