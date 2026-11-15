import { Link } from "react-router-dom";

export function NotFoundView() {
  return (
    <section className="placeholder" aria-labelledby="not-found-heading">
      <p className="placeholder-kicker">Not found</p>
      <h2 id="not-found-heading">Not found</h2>
      <p>That route or Game does not exist. Check the address, or return to the Library.</p>
      <Link to="/" className="primary">
        Back to Library
      </Link>
    </section>
  );
}
