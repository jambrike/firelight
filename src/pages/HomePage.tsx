import { ArrowRight, CircuitBoard, Code2, RadioTower } from "lucide-react";
import { Link } from "wouter";
import { CampfireScene } from "../components/CampfireScene";
import { Panel, PixelLink } from "../components/ui";
import { lessonCatalog } from "../features/lessons/catalog";

export function HomePage() {
  return (
    <>
      <section className="home-hero" aria-labelledby="home-title">
        <CampfireScene />
        <div className="home-hero__vignette" aria-hidden="true" />
        <div className="home-hero__copy">
          <p className="eyebrow">Welcome to the campfire of inventors.</p>
          <h1 id="home-title">Firelight</h1>
          <p className="home-hero__tagline">Build real robots, one spark at a time.</p>
          <p className="home-hero__summary">
            Learn electronics and code by building real things with a guided Arduino Nano kit.
          </p>
          <ul className="home-hero__proof" aria-label="Firelight platform highlights">
            <li>6 guided builds</li>
            <li>Browser upload</li>
            <li>Progress saved</li>
          </ul>
        </div>
        <div className="home-hero__start">
          <p className="hero-note">Pull up a log. Curiosity is the only prerequisite.</p>
          <div className="button-row">
            <PixelLink to="/auth">Begin the first spark</PixelLink>
            <PixelLink to="/learn" secondary>
              Preview the trail
            </PixelLink>
          </div>
        </div>
      </section>

      <section className="page-section story-section" aria-labelledby="story-title">
        <div>
          <p className="eyebrow">Why Firelight</p>
          <h2 id="story-title">Every invention starts small.</h2>
        </div>
        <blockquote>
          A question. A spark. Someone willing to try. Firelight turns code and
          circuits into a trail you can follow, test, and make your own.
        </blockquote>
      </section>

      <section className="page-section three-up" aria-label="How Firelight works">
        <Panel>
          <CircuitBoard aria-hidden="true" />
          <p className="eyebrow">01 · Wire</p>
          <h2>See every connection</h2>
          <p>Clear parts lists, fixed pin maps, and safety notes keep the circuit understandable.</p>
        </Panel>
        <Panel>
          <Code2 aria-hidden="true" />
          <p className="eyebrow">02 · Code</p>
          <h2>Change real behavior</h2>
          <p>Edit small Arduino sketches and learn why each line changes the build.</p>
        </Panel>
        <Panel>
          <RadioTower aria-hidden="true" />
          <p className="eyebrow">03 · Send</p>
          <h2>Watch it come alive</h2>
          <p>Compile, connect, and upload from a supported desktop browser.</p>
        </Panel>
      </section>

      <section className="page-section trail-preview" aria-labelledby="trail-preview-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Six guided builds</p>
            <h2 id="trail-preview-title">From first blink to trail rover.</h2>
          </div>
          <Link className="text-link" to="/learn">
            See the full path <ArrowRight aria-hidden="true" />
          </Link>
        </div>
        <ol className="mini-trail">
          {lessonCatalog.map((lesson) => (
            <li key={lesson.id}>
              <span>{lesson.order.toString().padStart(2, "0")}</span>
              <div>
                <strong>{lesson.title}</strong>
                <small>{lesson.summary}</small>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
