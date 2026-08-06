import { ArrowRight, Award, Map, Radio } from "lucide-react";
import { Link } from "wouter";
import { HardwareStatus, PageIntro, Panel, ProgressBar, PixelLink } from "../components/ui";

export function CampPage() {
  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="Camp preview" title="Your next build waits by the fire.">
        <p>
          This sample state shows the dashboard shell. Real profile and progress data
          arrive with the identity and lesson-engine milestones.
        </p>
      </PageIntro>

      <section className="dashboard-grid" aria-label="Learner camp preview">
        <Panel className="camp-board">
          <span className="status-chip">Preview data</span>
          <p className="eyebrow">Good evening, Builder</p>
          <h2>Ready to make the first spark?</h2>
          <p>Start with the built-in LED, then return here to resume each saved step.</p>
          <ProgressBar label="Core trail progress" value={0} />
          <div className="button-row">
            <PixelLink to="/learn/first-spark">Open First Spark</PixelLink>
            <PixelLink to="/learn" secondary>
              Open trail
            </PixelLink>
          </div>
        </Panel>
        <Panel className="status-board">
          <p className="eyebrow">Hardware state</p>
          <HardwareStatus />
          <p className="muted-copy">
            Firelight never reports a connection until the browser has actually opened
            a serial port.
          </p>
        </Panel>
      </section>

      <section className="three-up compact-cards" aria-label="Main camp paths">
        <Link className="panel path-card" to="/learn">
          <Map aria-hidden="true" />
          <h2>Learn</h2>
          <p>Walk the six-build trail in order.</p>
          <span>Open path <ArrowRight aria-hidden="true" /></span>
        </Link>
        <Link className="panel path-card" to="/learn/first-spark">
          <Radio aria-hidden="true" />
          <h2>Build</h2>
          <p>Enter the compile, connect, and send workspace.</p>
          <span>Open lesson <ArrowRight aria-hidden="true" /></span>
        </Link>
        <Link className="panel path-card" to="/account">
          <Award aria-hidden="true" />
          <h2>Badges</h2>
          <p>See achievements and connected kit details.</p>
          <span>Open account <ArrowRight aria-hidden="true" /></span>
        </Link>
      </section>
    </div>
  );
}
