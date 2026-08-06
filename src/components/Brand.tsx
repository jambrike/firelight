import { Link } from "wouter";

export function Brand() {
  return (
    <Link className="brand" to="/" aria-label="Firelight home">
      <span className="brand__mark" aria-hidden="true" />
      <span>Firelight</span>
    </Link>
  );
}
