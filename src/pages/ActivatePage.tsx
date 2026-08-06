import { PackageCheck } from "lucide-react";
import { FeaturePlaceholder, PageIntro, PixelLink } from "../components/ui";

export function ActivatePage() {
  return (
    <div className="page-section narrow-page page-stack">
      <PageIntro eyebrow="One-time kit activation" title="Match this kit to your camp.">
        <p>
          Pilot kits will include a single-use 16-character code. Activation unlocks
          compilation and cross-device progress for the signed-in builder.
        </p>
      </PageIntro>
      <FeaturePlaceholder label="Kit activation foundation" title="Activation API not connected yet">
        <PackageCheck aria-hidden="true" />
        <p className="code-example" aria-label="Example kit code format">
          ABCD-EFGH-JKMP-NRST
        </p>
        <p>
          The identity milestone will claim codes atomically and only store a peppered
          hash. Plaintext codes will never be recoverable from the database.
        </p>
      </FeaturePlaceholder>
      <div className="button-row">
        <PixelLink to="/camp">Preview camp</PixelLink>
        <PixelLink to="/kit" secondary>
          Check the kit
        </PixelLink>
      </div>
    </div>
  );
}
