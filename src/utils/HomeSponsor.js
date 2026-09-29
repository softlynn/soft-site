import { useState } from "react";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";

const SPONSOR_URL = "https://advanced.gg/?ref=soft";
const ADVANCED_LOGO_URL = "https://advanced.gg/cdn/shop/files/ADV-Logo-Horizontal_2560x.png?v=1762909429";

export default function HomeSponsor() {
  const [logoFailed, setLogoFailed] = useState(false);

  return (
    <aside className="soft-home-sponsor" aria-label="Sponsor">
      <p className="soft-home-sponsor__offer">
        Use code <strong>SOFT</strong> for 10% off!
      </p>
      <a
        className="soft-home-sponsor__link"
        href={SPONSOR_URL}
        target="_blank"
        rel="noopener noreferrer sponsored"
        aria-label="Shop ADVANCED with code SOFT"
      >
        {!logoFailed && (
          <span className="soft-home-sponsor__logo">
            <img
              src={ADVANCED_LOGO_URL}
              alt=""
              width="64"
              height="24"
              loading="lazy"
              decoding="async"
              onError={() => setLogoFailed(true)}
            />
          </span>
        )}
        <span className="soft-home-sponsor__identity">
          <span className="soft-home-sponsor__name">ADVANCED</span>
          <span className="soft-home-sponsor__domain">advanced.gg/?ref=soft</span>
        </span>
        <OpenInNewRoundedIcon className="soft-home-sponsor__external" />
      </a>
    </aside>
  );
}
