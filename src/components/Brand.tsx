import { Link } from "wouter";
import { useIdentity } from "../features/identity/identity-context";

export function Brand() {
  const identity = useIdentity();
  const homePath = identity.status === "authenticated" ? "/" : "/?intro=1";

  return (
    <Link className="brand" to={homePath} aria-label="Firelight home">
      <span className="brand__mark" aria-hidden="true" />
      <span>Firelight</span>
    </Link>
  );
}
