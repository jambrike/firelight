import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useIdentity } from "../features/identity/identity-context";
import { CampfireScene } from "../components/CampfireScene";

const openingStory = [
  "Before computers,\nbefore electricity,\nbefore engines...",
  "There was fire.",
  "For thousands of years,\npeople gathered around it.",
  "Not just for warmth.",
  "To share ideas.\nTo solve problems.\nTo teach.",
  "Every invention starts small.",
  "A question.\nA spark.\nSomeone willing to try.",
  "One person shares what they know.",
  "Another person builds on it.",
  "The tools have changed.",
  "The fire hasn't.",
  "Today,\nwe gather around screens.",
  "We write code.\nWe wire circuits.\nWe bring machines to life.",
  "Learn.",
  "Build.",
  "Create.",
  "Welcome to Firelight.",
] as const;

function holdDelay(line: string): number {
  if (line.length <= 8) return 1_550;
  return Math.min(2_600, 1_350 + line.length * 18);
}

export function HomePage() {
  const identity = useIdentity();
  const [, navigate] = useLocation();
  const authenticated = identity.status === "authenticated";
  const [introStarted, setIntroStarted] = useState(
    () => new URLSearchParams(window.location.search).get("intro") === "1",
  );
  const [introComplete, setIntroComplete] = useState(false);
  const [lineIndex, setLineIndex] = useState(0);
  const [displayedLine, setDisplayedLine] = useState("");
  const timerRef = useRef<number | null>(null);
  const characterIndexRef = useRef(0);
  const introRequired = identity.status === "anonymous" || identity.status === "error";
  const introVisible = introRequired && introStarted && !introComplete;
  const introBlocking = introVisible || (introStarted && identity.status === "loading");
  const currentLine = openingStory[lineIndex];
  const nextLessonPath = `/learn/${identity.data?.nextLesson?.id ?? "first-spark"}`;

  const clearStoryTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const finishIntro = useCallback(() => {
    clearStoryTimer();
    setIntroComplete(true);
    setDisplayedLine("");
    if (introRequired) navigate("/auth?next=/learn/first-spark");
  }, [clearStoryTimer, introRequired, navigate]);

  const startIntro = useCallback(() => {
    clearStoryTimer();
    setLineIndex(0);
    setDisplayedLine("");
    setIntroComplete(false);
    setIntroStarted(true);
  }, [clearStoryTimer]);

  const continueStory = useCallback(() => {
    setDisplayedLine("");
    if (lineIndex >= openingStory.length - 1) {
      finishIntro();
      return;
    }
    setLineIndex((index) => index + 1);
  }, [finishIntro, lineIndex]);

  useEffect(() => {
    if (!introVisible) {
      clearStoryTimer();
      return;
    }
    if (!currentLine) return;

    characterIndexRef.current = 0;
    const typeNextCharacter = () => {
      characterIndexRef.current += 1;
      setDisplayedLine(currentLine.slice(0, characterIndexRef.current));
      if (characterIndexRef.current < currentLine.length) {
        const character = currentLine[characterIndexRef.current - 1] ?? "";
        timerRef.current = window.setTimeout(
          typeNextCharacter,
          character === "." || character === "," ? 110 : 46,
        );
        return;
      }
      timerRef.current = window.setTimeout(
        () => {
          continueStory();
        },
        holdDelay(currentLine),
      );
    };

    timerRef.current = window.setTimeout(typeNextCharacter, lineIndex === 0 ? 650 : 260);
    return clearStoryTimer;
  }, [clearStoryTimer, continueStory, currentLine, introVisible, lineIndex]);

  const advanceIntro = useCallback(() => {
    if (!introVisible || !currentLine) return;
    clearStoryTimer();
    if (displayedLine !== currentLine) {
      characterIndexRef.current = currentLine.length;
      setDisplayedLine(currentLine);
      timerRef.current = window.setTimeout(
        () => {
          continueStory();
        },
        Math.min(1_200, holdDelay(currentLine) * 0.5),
      );
      return;
    }
    continueStory();
  }, [clearStoryTimer, continueStory, currentLine, displayedLine, introVisible]);

  useEffect(() => {
    if (!introVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (!event.repeat) advanceIntro();
      } else if (event.key.toLowerCase() === "s" || event.key === "Escape") {
        event.preventDefault();
        finishIntro();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [advanceIntro, finishIntro, introVisible]);

  return (
    <section className="old-home" aria-labelledby="home-title">
      <CampfireScene />
      <div className="old-home__vignette" aria-hidden="true" />

      <div
        className="old-home__content"
        aria-hidden={introBlocking || undefined}
        inert={introBlocking ? true : undefined}
      >
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
        {authenticated ? (
          <Link className="old-home__cta" to={nextLessonPath}>
            Begin the first spark
          </Link>
        ) : (
          <button
            className="old-home__cta"
            type="button"
            disabled={identity.status === "loading"}
            onClick={startIntro}
          >
            {identity.status === "loading" ? "Checking your camp…" : "Begin the first spark"}
          </button>
        )}
      </div>
      </div>

      {introBlocking ? (
        <section
          className="firelight-intro"
          data-loading={identity.status === "loading" || undefined}
          aria-label="Firelight opening story"
        >
          {identity.status === "loading" ? (
            <span className="sr-only" role="status">Checking your camp…</span>
          ) : (
            <>
              <p className="firelight-intro__hint" aria-hidden="true">
                <span className="firelight-intro__desktop-hint">
                  Press <kbd>Space</kbd> or <kbd>Enter</kbd>
                </span>
                <span className="firelight-intro__mobile-hint">Tap to continue</span>
              </p>
              <button
                className="firelight-intro__advance"
                type="button"
                onClick={advanceIntro}
                aria-label="Continue opening story"
              >
                <span className="firelight-intro__line" aria-hidden="true">
                  {displayedLine}
                </span>
                <span className="sr-only" aria-live="polite">
                  {displayedLine === currentLine ? currentLine : ""}
                </span>
              </button>
              <div className="firelight-intro__campfire" aria-hidden="true">
                <span className="firelight-intro__flame firelight-intro__flame--outer" />
                <span className="firelight-intro__flame firelight-intro__flame--middle" />
                <span className="firelight-intro__flame firelight-intro__flame--core" />
                <span className="firelight-intro__ember firelight-intro__ember--one" />
                <span className="firelight-intro__ember firelight-intro__ember--two" />
              </div>
              <button
                className="firelight-intro__skip"
                type="button"
                onClick={finishIntro}
                aria-label="Skip intro"
              >
                &gt;&gt;&gt;
              </button>
            </>
          )}
        </section>
      ) : null}
    </section>
  );
}
