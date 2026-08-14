import { Link } from "wouter";
import { useIdentity } from "../features/identity/identity-context";
import { CampfireScene } from "../components/CampfireScene";

export function HomePage() {
  const identity = useIdentity();
  const authenticated = identity.status === "authenticated";

  return (
    <section className="old-home" aria-labelledby="home-title">
      <CampfireScene />
      <div className="old-home__vignette" aria-hidden="true" />

      <header className="old-home__topbar">
        <Link className="old-home__brand" to="/" aria-label="Firelight home">
          <span className="old-home__brand-mark" aria-hidden="true" />
          <span>Firelight</span>
        </Link>
        <nav className="old-home__nav" aria-label="Homepage navigation">
          <Link to="/learn">Learn</Link>
          <Link to="/kit">Kits</Link>
          <Link to="/learn/first-spark">Build</Link>
          <Link to="/camp">Community</Link>
          {authenticated ? (
            <Link className="old-home__nav-button old-home__nav-button--secondary" to="/camp">
              Dashboard
            </Link>
          ) : null}
          <Link className="old-home__nav-button" to="/kit">
            Buy a Kit!
          </Link>
        </nav>
      </header>

      <div className="old-home__hero-copy">
        <div>
          <p className="old-home__kicker">Welcome to the campfire of inventors.</p>
          <h1 id="home-title">Firelight</h1>
          <p className="old-home__tagline">
            Learn electronics, code, and robotics by building real things.
          </p>
        </div>
      </div>

      <div className="old-home__actions">
        <p>Pull up a log.</p>
        <Link className="old-home__cta" to={authenticated ? "/camp" : "/auth"}>
          Begin the first spark
        </Link>
      </div>
    </section>
  );
}
