import { Link } from "react-router";
import CustomToolTip from "../utils/CustomToolTip";
import { BRAND_NAME } from "../config/site";

const logoSource = `${process.env.PUBLIC_URL || ""}/media/soft-logo-still.webp`;

export default function ViewerHeader({ vod, game, sourceUrl, isMobile }) {
  const date = vod.createdAt ? new Date(vod.createdAt) : null;
  const hasDate = date && !Number.isNaN(date.getTime());
  const dateLabel = hasDate
    ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date)
    : "";

  return (
    <header className="soft-viewer-header">
      <div className="soft-viewer-heading">
        <CustomToolTip title={vod.title} disableInteractive={isMobile} disableHoverListener={isMobile}>
          <h1 className="soft-viewer-title">{vod.title}</h1>
        </CustomToolTip>
        <div className="soft-viewer-meta">
          {hasDate && <time dateTime={date.toISOString()}>{dateLabel}</time>}
          {vod.duration && <span>{vod.duration}</span>}
          {game && <span className="soft-viewer-game">{game}</span>}
        </div>
        {vod.vodNotice && <p className="soft-viewer-notice">{vod.vodNotice}</p>}
      </div>
      <nav className="soft-viewer-links" aria-label="Viewer navigation">
        <Link className="soft-viewer-home" to="/" aria-label="Back home">
          <img className="soft-viewer-brand-mark" src={logoSource} alt="" width="28" height="28" />
          <span className="soft-viewer-brand-name">{BRAND_NAME}</span>
        </Link>
        <Link to="/vods">Archive</Link>
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label="Open original Twitch VOD">Twitch <span aria-hidden="true">↗</span></a>}
      </nav>
    </header>
  );
}
