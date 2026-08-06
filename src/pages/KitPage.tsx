import { Check, Monitor, ShieldCheck } from "lucide-react";
import kitClosed from "../../kit-box-closed.png";
import kitOpenOne from "../../kit-box-open-1.png";
import kitOpenTwo from "../../kit-box-open-2.png";
import kitTop from "../../kit-box-top.png";
import { PageIntro, Panel, PixelLink } from "../components/ui";

const kitContents = [
  "ATmega328P Arduino Nano-compatible board (old bootloader profile)",
  "USB data cable, breadboard, and jumper wires",
  "LEDs, current-limiting resistors, and pushbutton",
  "HC-SR04 ultrasonic distance sensor",
  "SG90 micro servo",
  "TB6612FNG motor driver, two TT motors, wheels, and caster",
  "Separate motor battery pack and regulated 5V servo supply guidance",
] as const;

export function KitPage() {
  return (
    <div className="page-section page-stack">
      <PageIntro eyebrow="The Firelight kit" title="Everything needed for the first six builds.">
        <p>
          One controlled parts set means the lesson diagrams, code, tests, and support
          advice all describe the hardware in front of you.
        </p>
      </PageIntro>

      <section className="kit-hero" aria-labelledby="kit-gallery-title">
        <div className="kit-gallery">
          <h2 className="sr-only" id="kit-gallery-title">
            Firelight kit gallery
          </h2>
          <img
            className="kit-gallery__main"
            src={kitOpenTwo}
            alt="Open Firelight kit box with the Arduino board and learning parts arranged inside"
          />
          <div className="kit-gallery__thumbs">
            <img src={kitOpenOne} alt="Firelight kit opened to its first parts layer" />
            <img src={kitTop} alt="Top view of the printed Firelight kit box" />
            <img src={kitClosed} alt="Closed Firelight kit box" />
          </div>
        </div>
        <Panel className="kit-inventory">
          <p className="eyebrow">Inside the crate</p>
          <h2>A precise pilot kit, not a mystery parts bag.</h2>
          <ul className="check-list">
            {kitContents.map((item) => (
              <li key={item}>
                <Check aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <PixelLink to="/auth">Request pilot access</PixelLink>
        </Panel>
      </section>

      <section className="two-up" aria-label="Browser and safety requirements">
        <Panel>
          <Monitor aria-hidden="true" />
          <p className="eyebrow">Browser contract</p>
          <h2>Desktop Chrome or Edge</h2>
          <p>
            Lessons remain readable everywhere. Compiling and sending code requires a
            desktop Chromium browser with Web Serial and a USB data connection.
          </p>
        </Panel>
        <Panel>
          <ShieldCheck aria-hidden="true" />
          <p className="eyebrow">Build safely</p>
          <h2>Power down before rewiring</h2>
          <p>
            Disconnect power before changing a circuit. Motors use their own battery
            pack; the servo uses a safe external 5V supply with a common ground. The
            platform is for learners 13+ or younger builders with adult supervision.
          </p>
        </Panel>
      </section>

      <aside className="support-note">
        <strong>Supported v1 board:</strong> ATmega328P Nano-compatible board using the
        old bootloader at 57,600 baud. Uno boards, arbitrary clones, mobile serial, and
        custom hardware are outside the pilot contract.
      </aside>
    </div>
  );
}
