import { useEffect, useState } from "react";
import { Box, Button, Grid, Stack, Typography } from "@mui/material";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import { FieldLabel } from "@puckeditor/core";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import VideoLibraryRoundedIcon from "@mui/icons-material/VideoLibraryRounded";
import Loading from "../utils/Loading";
import Vod from "../vods/Vod";
import { uploadDesignAsset } from "../api/adminApi";
import vodsClient from "../vods/client";
import Logo from "../assets/logo.png";
import { SITE_DESCRIPTION, SOCIAL_LINKS } from "../config/site";

const SURFACE_OPTIONS = [
  { label: "Glass", value: "glass" },
  { label: "Bubble glass", value: "bubble" },
  { label: "Cute plush", value: "plush" },
  { label: "Pearl", value: "pearl" },
  { label: "Solid", value: "solid" },
  { label: "Soft", value: "soft" },
  { label: "Outline", value: "outline" },
  { label: "Transparent", value: "transparent" },
];

const ANIMATION_OPTIONS = [
  { label: "None", value: "none" },
  { label: "Fade in", value: "fade" },
  { label: "Lift on hover", value: "lift" },
  { label: "Float", value: "float" },
  { label: "Pulse", value: "pulse" },
  { label: "Sheen", value: "sheen" },
  { label: "Tilt on hover", value: "tilt" },
];

const WIDTH_OPTIONS = [
  { label: "Narrow", value: "narrow" },
  { label: "Normal", value: "normal" },
  { label: "Wide", value: "wide" },
  { label: "Full", value: "full" },
  { label: "Custom", value: "custom" },
];

const PADDING_OPTIONS = [
  { label: "None", value: "none" },
  { label: "Small", value: "small" },
  { label: "Medium", value: "medium" },
  { label: "Large", value: "large" },
];

const FONT_OPTIONS = [
  { label: "Use site font", value: "inherit" },
  { label: "Manrope", value: "\"Manrope\", \"Segoe UI\", sans-serif" },
  { label: "Space Grotesk", value: "\"Space Grotesk\", \"Manrope\", sans-serif" },
  { label: "Rounded cute", value: "\"Nunito\", \"Quicksand\", \"Manrope\", sans-serif" },
  { label: "Soft display", value: "\"Baloo 2\", \"Nunito\", \"Manrope\", sans-serif" },
  { label: "Classic serif", value: "Georgia, \"Times New Roman\", serif" },
  { label: "Mono", value: "\"Cascadia Code\", \"Consolas\", monospace" },
];

const FONT_WEIGHT_OPTIONS = [
  { label: "Regular", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Semibold", value: "650" },
  { label: "Bold", value: "800" },
];

const BACKGROUND_SIZE_OPTIONS = [
  { label: "Cover", value: "cover" },
  { label: "Contain", value: "contain" },
  { label: "Auto", value: "auto" },
];

const BACKGROUND_ATTACHMENT_OPTIONS = [
  { label: "Scroll", value: "scroll" },
  { label: "Fixed", value: "fixed" },
];

const colorField = (label) => ({
  type: "custom",
  label,
  render: ({ id, value, onChange, readOnly }) => {
    const normalized = typeof value === "string" ? value : "";
    return (
      <div style={{ display: "grid", gap: 8 }}>
        <FieldLabel label={label} />
        <div style={{ display: "grid", gridTemplateColumns: "44px 1fr", gap: 8, alignItems: "center" }}>
          <input
            aria-label={label}
            disabled={readOnly}
            id={id}
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(normalized) ? normalized : "#d46b8c"}
            onChange={(event) => onChange(event.currentTarget.value)}
            style={{ width: 44, height: 34, padding: 2, border: "1px solid #d7dce5", borderRadius: 8, background: "transparent" }}
          />
          <input
            disabled={readOnly}
            value={normalized}
            placeholder="#d46b8c or rgba(...)"
            onChange={(event) => onChange(event.currentTarget.value)}
            style={{ minWidth: 0, height: 34, border: "1px solid #d7dce5", borderRadius: 8, padding: "0 10px" }}
          />
        </div>
      </div>
    );
  },
});

function ImageUploadFieldControl({ id, label, value, onChange, readOnly }) {
  const [status, setStatus] = useState("");
  const normalized = typeof value === "string" ? value : "";

  const handleUpload = async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setStatus("Uploading...");
    try {
      const payload = await uploadDesignAsset(file);
      if (!payload?.url) throw new Error("Upload did not return an image URL");
      onChange(payload.url);
      setStatus("Uploaded");
    } catch (error) {
      setStatus(error.message || "Upload failed");
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <FieldLabel label={label} />
      <input
        id={id}
        disabled={readOnly}
        value={normalized}
        placeholder="/uploads/design/image.png or https://..."
        onChange={(event) => onChange(event.currentTarget.value)}
        style={{ minWidth: 0, height: 34, border: "1px solid #d7dce5", borderRadius: 8, padding: "0 10px" }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            minHeight: 32,
            padding: "0 12px",
            borderRadius: 999,
            border: "1px solid #d7dce5",
            background: readOnly ? "#f1f5f9" : "#fff",
            cursor: readOnly ? "not-allowed" : "pointer",
            fontSize: 13,
            fontWeight: 700,
          }}
        >
          Upload image
          <input disabled={readOnly} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handleUpload} style={{ display: "none" }} />
        </label>
        {normalized && (
          <button
            type="button"
            disabled={readOnly}
            onClick={() => onChange("")}
            style={{ minHeight: 32, border: "1px solid #d7dce5", borderRadius: 999, background: "transparent", padding: "0 10px", cursor: "pointer" }}
          >
            Clear
          </button>
        )}
        {status && <span style={{ color: status === "Uploaded" ? "#047857" : "#64748b", fontSize: 12 }}>{status}</span>}
      </div>
    </div>
  );
}

const imageField = (label) => ({
  type: "custom",
  label,
  render: ({ id, value, onChange, readOnly }) => <ImageUploadFieldControl id={id} label={label} value={value} onChange={onChange} readOnly={readOnly} />,
});

const textField = (label, placeholder = "") => ({ type: "text", label, placeholder });
const textareaField = (label, placeholder = "") => ({ type: "textarea", label, placeholder });
const selectField = (label, options) => ({ type: "select", label, options });
const numberField = (label, min, max, step = 1) => ({ type: "number", label, min, max, step });

const fontField = (label) => selectField(label, FONT_OPTIONS);

const advancedFields = {
  width: selectField("Block width", WIDTH_OPTIONS),
  customMaxWidth: textField("Custom max width", "680px, 72rem, 100%"),
  minHeight: numberField("Minimum height", 0, 900),
  padding: selectField("Padding", PADDING_OPTIONS),
  borderRadius: numberField("Roundness", 0, 72),
  borderColor: colorField("Border color"),
  textColor: colorField("Text color"),
  backgroundImage: imageField("Block background image"),
  backgroundImageOpacity: numberField("Background image opacity", 0, 100),
  backgroundPosition: textField("Background position", "center center"),
  backgroundSize: selectField("Background size", BACKGROUND_SIZE_OPTIONS),
  customClassName: textField("Custom CSS class"),
};

const hrefField = textField("Link URL", "Use /page, https://..., or configured:twitch");

const buttonArrayField = {
  type: "array",
  label: "Buttons",
  getItemSummary: (item) => item?.label || "Button",
  defaultItemProps: {
    label: "Open",
    href: "/vods",
    variant: "contained",
    tone: "accent",
    animation: "lift",
    fontFamily: "inherit",
    backgroundColor: "",
    textColor: "",
    borderColor: "",
    radius: 999,
  },
  arrayFields: {
    label: textField("Label"),
    href: hrefField,
    variant: selectField("Style", [
      { label: "Filled", value: "contained" },
      { label: "Outlined", value: "outlined" },
      { label: "Text", value: "text" },
    ]),
    tone: selectField("Tone", [
      { label: "Accent", value: "accent" },
      { label: "Blue", value: "blue" },
      { label: "Neutral", value: "neutral" },
    ]),
    animation: selectField("Animation", ANIMATION_OPTIONS),
    fontFamily: fontField("Button font"),
    backgroundColor: colorField("Button background"),
    textColor: colorField("Button text color"),
    borderColor: colorField("Button border"),
    radius: numberField("Button roundness", 0, 999),
  },
};

const cleanText = (value, fallback = "") => {
  const next = String(value || "").trim();
  return next || fallback;
};

const safeUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw || /^javascript:/i.test(raw)) return "";
  return raw;
};

const resolveConfiguredHref = (href) => {
  const raw = safeUrl(href);
  if (!raw.startsWith("configured:")) return raw;
  const key = raw.slice("configured:".length);
  return SOCIAL_LINKS[key] || "";
};

const getLinkProps = (href) => {
  const resolved = resolveConfiguredHref(href);
  if (!resolved) return {};
  if (resolved.startsWith("/")) {
    return { component: RouterLink, to: resolved };
  }
  return { component: "a", href: resolved, target: "_blank", rel: "noopener noreferrer" };
};

const getFontFamily = (fontFamily, fallback = undefined) => {
  const value = String(fontFamily || "").trim();
  if (!value || value === "inherit") return fallback;
  return value;
};

const getRadius = (value, fallback = 22) => {
  const radius = Number(value);
  return Number.isFinite(radius) && radius >= 0 ? Math.min(96, radius) : fallback;
};

const getSurfaceSx = ({ surface = "glass", backgroundColor = "", borderColor = "", accentColor = "" } = {}) => {
  if (surface === "transparent") {
    return {
      background: "transparent",
      borderColor: "transparent",
      boxShadow: "none",
      backdropFilter: "none",
    };
  }

  if (surface === "bubble") {
    return {
      background:
        backgroundColor ||
        "var(--soft-surface-bubble)",
      border: `1px solid ${borderColor || "rgba(255,255,255,0.72)"}`,
      boxShadow: "0 20px 46px rgba(19,33,56,0.12), inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(255,255,255,0.08)",
      backdropFilter: "blur(20px) saturate(145%)",
    };
  }

  if (surface === "plush") {
    return {
      background:
        backgroundColor ||
        "var(--soft-surface-plush)",
      border: `1px solid ${borderColor || "rgba(255,255,255,0.64)"}`,
      boxShadow: "0 16px 34px rgba(212,107,140,0.10), inset 0 1px 0 rgba(255,255,255,0.34)",
      backdropFilter: "blur(16px) saturate(132%)",
    };
  }

  if (surface === "pearl") {
    return {
      background:
        backgroundColor ||
        "var(--soft-surface-pearl)",
      border: `1px solid ${borderColor || accentColor || "rgba(255,255,255,0.62)"}`,
      boxShadow: "0 18px 42px rgba(19,33,56,0.10), inset 0 1px 0 rgba(255,255,255,0.38)",
      backdropFilter: "blur(18px) saturate(150%)",
    };
  }

  if (surface === "solid") {
    return {
      background: backgroundColor || "var(--soft-surface-strong)",
      border: `1px solid ${borderColor || "var(--soft-border-subtle)"}`,
      boxShadow: "0 14px 30px rgba(19,33,56,0.09)",
      backdropFilter: "none",
    };
  }

  if (surface === "soft") {
    return {
      background: backgroundColor || "var(--soft-surface-soft)",
      border: `1px solid ${borderColor || "var(--soft-border)"}`,
      boxShadow: "0 10px 24px rgba(19,33,56,0.07)",
      backdropFilter: "blur(10px)",
    };
  }

  if (surface === "outline") {
    return {
      background: backgroundColor || "transparent",
      border: `1px solid ${borderColor || accentColor || "var(--soft-border)"}`,
      boxShadow: "none",
      backdropFilter: "none",
    };
  }

  return {
    background:
      backgroundColor ||
      "radial-gradient(150% 110% at 8% 0%, rgba(255,255,255,0.20), transparent 46%), linear-gradient(180deg, var(--soft-surface-strong), var(--soft-surface-soft))",
    border: `1px solid ${borderColor || "var(--soft-border)"}`,
    boxShadow: "var(--soft-shadow), inset 0 1px 0 rgba(255,255,255,0.16)",
    backdropFilter: "blur(18px) saturate(135%)",
  };
};

const getBlockBackgroundSx = (props = {}) => {
  const image = safeUrl(props.backgroundImage);
  const opacity = Math.max(0, Math.min(100, Number(props.backgroundImageOpacity ?? 30))) / 100;
  const sx = {
    borderRadius: `${getRadius(props.borderRadius, 22)}px`,
  };

  if (props.textColor) sx.color = props.textColor;
  if (!image) return sx;

  return {
    ...sx,
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    "&::before": {
      content: '""',
      position: "absolute",
      inset: 0,
      zIndex: 0,
      pointerEvents: "none",
      borderRadius: "inherit",
      backgroundImage: `linear-gradient(rgba(255,255,255,0.16), rgba(255,255,255,0.16)), url(${image})`,
      backgroundRepeat: "no-repeat",
      backgroundPosition: props.backgroundPosition || "center center",
      backgroundSize: props.backgroundSize || "cover",
      opacity,
      filter: "saturate(1.04)",
    },
    "[data-soft-theme=\"dark\"] &::before": {
      backgroundImage: `linear-gradient(rgba(15,23,42,0.48), rgba(15,23,42,0.62)), url(${image})`,
      opacity: Math.min(0.72, opacity + 0.16),
    },
    "& > *": {
      position: "relative",
      zIndex: 1,
    },
  };
};

const getTextFormattingSx = (props = {}, fallbackColor = "text.secondary") => ({
  color: props.textColor || fallbackColor,
  fontFamily: getFontFamily(props.fontFamily),
  fontSize: props.fontSize ? `${Math.max(10, Math.min(96, Number(props.fontSize) || 16))}px` : undefined,
  fontWeight: props.fontWeight || undefined,
  lineHeight: props.lineHeight ? Math.max(1, Math.min(2.4, Number(props.lineHeight) || 1.5)) : undefined,
  fontStyle: props.italic === true || props.italic === "yes" ? "italic" : undefined,
  textDecoration: props.underline === true || props.underline === "yes" ? "underline" : undefined,
});

const getPaddingSx = (padding = "medium") => {
  if (padding === "none") return { p: 0 };
  if (padding === "small") return { p: { xs: 1.15, md: 1.35 } };
  if (padding === "large") return { p: { xs: 1.6, md: 2.35 } };
  return { p: { xs: 1.35, md: 1.75 } };
};

const getWidthSx = (width = "normal", customMaxWidth = "") => {
  if (width === "custom") return { maxWidth: customMaxWidth || "900px" };
  if (width === "narrow") return { maxWidth: 760 };
  if (width === "wide") return { maxWidth: 1040 };
  if (width === "full") return { maxWidth: "none" };
  return { maxWidth: 900 };
};

const getResizeSx = (props = {}) => ({
  ...getWidthSx(props.width || "full", props.customMaxWidth),
  minHeight: Number(props.minHeight) > 0 ? Number(props.minHeight) : undefined,
  width: "100%",
  mx: props.width && props.width !== "full" ? "auto" : undefined,
});

const getAnimationClass = (animation, extra = "") =>
  ["soft-design-block", animation && animation !== "none" ? `soft-design-anim--${animation}` : "", extra].filter(Boolean).join(" ");

const getToneColor = (tone, fallback = "#d46b8c") => {
  if (tone === "blue") return "#79a3e6";
  if (tone === "neutral") return "var(--soft-text)";
  return fallback;
};

function DesignButton({ button, accentColor = "#d46b8c" }) {
  const hrefProps = getLinkProps(button?.href);
  const toneColor = getToneColor(button?.tone, accentColor);
  const variant = button?.variant || "contained";
  const radius = getRadius(button?.radius, 999);

  return (
    <Button
      {...hrefProps}
      className={getAnimationClass(button?.animation, "soft-design-button")}
      variant={variant}
      size="large"
      endIcon={!String(button?.href || "").startsWith("/") ? <OpenInNewRoundedIcon /> : null}
      sx={{
        borderRadius: `${radius}px`,
        px: 2,
        minHeight: 42,
        color: button?.textColor || (variant === "contained" ? "#fff" : toneColor),
        borderColor: button?.borderColor || toneColor,
        background: button?.backgroundColor || (variant === "contained" ? `linear-gradient(180deg, ${toneColor}, ${toneColor}dd)` : undefined),
        fontFamily: getFontFamily(button?.fontFamily),
        position: "relative",
        overflow: "hidden",
      }}
    >
      {cleanText(button?.label, "Open")}
    </Button>
  );
}

function PlaceholderMedia({ icon = "image", accentColor = "#d46b8c" }) {
  return (
    <Box
      sx={{
        width: "100%",
        height: "100%",
        minHeight: 150,
        display: "grid",
        placeItems: "center",
        background:
          "radial-gradient(circle at 28% 18%, rgba(255,255,255,0.48), transparent 38%), radial-gradient(circle at 74% 70%, rgba(121,163,230,0.24), transparent 46%), linear-gradient(135deg, rgba(212,107,140,0.22), rgba(255,255,255,0.22))",
      }}
    >
      <Box
        component="img"
        alt=""
        src={Logo}
        sx={{
          width: icon === "image" ? 66 : 54,
          height: icon === "image" ? 66 : 54,
          borderRadius: "18px",
          p: 0.8,
          background: "rgba(255,255,255,0.88)",
          boxShadow: `0 12px 28px ${accentColor}33`,
        }}
      />
    </Box>
  );
}

function ImageFrame({ src, alt, aspectRatio = "16 / 10", accentColor = "#d46b8c", className = "" }) {
  const cleanSrc = safeUrl(src);
  return (
    <Box
      className={className}
      sx={{
        width: "100%",
        aspectRatio,
        borderRadius: "18px",
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.45)",
        background: "rgba(255,255,255,0.2)",
        boxShadow: "0 18px 34px rgba(19,33,56,0.12)",
      }}
    >
      {cleanSrc ? (
        <Box component="img" alt={alt || ""} src={cleanSrc} sx={{ width: "100%", height: "100%", display: "block", objectFit: "cover" }} />
      ) : (
        <PlaceholderMedia accentColor={accentColor} />
      )}
    </Box>
  );
}

function extractTwitchChannel(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\/+$/, "");
  const match = normalized.match(/twitch\.tv\/([^/?#]+)/i);
  return match?.[1] || normalized;
}

function TwitchLiveFrame({ channelSource = "configured", customChannel = "", height = 380 }) {
  const configuredChannel = extractTwitchChannel(SOCIAL_LINKS.twitch);
  const channel = channelSource === "custom" ? cleanText(customChannel) : configuredChannel;
  const [hostName, setHostName] = useState("localhost");

  useEffect(() => {
    if (typeof window === "undefined") return;
    setHostName(window.location.hostname || "localhost");
  }, []);

  if (!channel) {
    return (
      <Box className="soft-live-frame soft-grid-pattern" sx={{ height, p: 2, display: "grid", placeItems: "center" }}>
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          Twitch channel link is not configured.
        </Typography>
      </Box>
    );
  }

  const src = `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${encodeURIComponent(hostName)}&autoplay=false&muted=true`;

  return (
    <Box className="soft-live-frame soft-grid-pattern" sx={{ height, minHeight: 220, width: "100%" }}>
      <iframe
        title={`${channel} Twitch Live`}
        src={src}
        width="100%"
        height="100%"
        allowFullScreen
        frameBorder="0"
        loading="lazy"
        style={{ width: "100%", height: "100%", border: 0 }}
      />
    </Box>
  );
}

function GenericEmbedFrame({ title, src, height = 352, aspectRatio = "custom", allow = "", sandbox = "" }) {
  const cleanSrc = safeUrl(src);
  const useAspectRatio = aspectRatio && aspectRatio !== "custom";

  return (
    <Box
      sx={{
        width: "100%",
        height: useAspectRatio ? "auto" : Math.max(120, Number(height) || 352),
        aspectRatio: useAspectRatio ? aspectRatio : undefined,
        borderRadius: "16px",
        overflow: "hidden",
        background: "rgba(17,24,39,0.18)",
        border: "1px solid rgba(255,255,255,0.38)",
      }}
    >
      {cleanSrc ? (
        <iframe
          title={cleanText(title, "Custom embed")}
          src={cleanSrc}
          width="100%"
          height="100%"
          allow={allow || undefined}
          sandbox={sandbox || undefined}
          frameBorder="0"
          loading="lazy"
          style={{ width: "100%", height: "100%", border: 0, display: "block" }}
        />
      ) : (
        <Box sx={{ height: "100%", minHeight: 180, display: "grid", placeItems: "center", color: "text.secondary" }}>
          <Typography variant="body2">Paste an embed URL.</Typography>
        </Box>
      )}
    </Box>
  );
}

function RecentVodsRenderer({ title, subtitle, count = 4, showButton = true, surface = "glass", backgroundColor = "", borderColor = "", width, customMaxWidth, minHeight, padding, ...styleProps }) {
  const navigate = useNavigate();
  const [vods, setVods] = useState(null);

  useEffect(() => {
    let active = true;
    vodsClient
      .service("vods")
      .find({
        query: {
          $limit: Math.max(1, Math.min(12, Number(count) || 4)),
          $skip: 0,
          $sort: { createdAt: -1 },
          $and: [{ unpublished: { $ne: true } }],
        },
      })
      .then((response) => {
        if (!active) return;
        const visible = Array.isArray(response.data) ? response.data.filter((vod) => !vod?.unpublished) : [];
        setVods(visible);
      })
      .catch(() => {
        if (active) setVods([]);
      });

    return () => {
      active = false;
    };
  }, [count]);

  return (
    <Box
      className="soft-design-section"
      sx={{
        ...getResizeSx({ width, customMaxWidth, minHeight }),
        ...getSurfaceSx({ surface, backgroundColor, borderColor }),
        ...getPaddingSx(padding || "medium"),
        ...getBlockBackgroundSx(styleProps),
      }}
    >
      <Stack direction={{ xs: "column", md: "row" }} spacing={1} alignItems={{ xs: "flex-start", md: "center" }} justifyContent="space-between" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="h5" className="soft-section-heading" sx={{ color: "primary.main" }}>
            {cleanText(title, "Recent VODs")}
          </Typography>
          {subtitle && (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.55, maxWidth: 620 }}>
              {subtitle}
            </Typography>
          )}
        </Box>
        {showButton && (
          <Button variant="outlined" startIcon={<VideoLibraryRoundedIcon />} onClick={() => navigate("/vods")}>
            Open VODs
          </Button>
        )}
      </Stack>

      {!vods ? (
        <Loading />
      ) : vods.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary" }}>
          No VODs found yet.
        </Typography>
      ) : (
        <Grid container spacing={{ xs: 1.2, sm: 1.6, md: 2 }} sx={{ justifyContent: "center" }}>
          {vods.map((vod, index) => (
            <Vod key={vod.id} vod={vod} sizes={{ xs: 12, sm: 6, lg: 3 }} gridSize={2.1} sheen={index === 0} cardWidth="21.5rem" />
          ))}
        </Grid>
      )}
    </Box>
  );
}

const sectionHeading = (title, subtitle, align = "left") => (
  <Box sx={{ textAlign: align, mb: title || subtitle ? 1.15 : 0 }}>
    {title && (
      <Typography variant="h5" className="soft-section-heading" sx={{ color: "primary.main" }}>
        {title}
      </Typography>
    )}
    {subtitle && (
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.55, maxWidth: align === "center" ? 700 : 760, mx: align === "center" ? "auto" : 0 }}>
        {subtitle}
      </Typography>
    )}
  </Box>
);

export const designConfig = {
  root: {
    fields: {
      pageTitle: textField("Browser title"),
      pageDescription: textareaField("Page description"),
      backgroundMode: selectField("Background mode", [
        { label: "Theme default", value: "theme" },
        { label: "Color", value: "color" },
        { label: "Gradient", value: "gradient" },
        { label: "Image", value: "image" },
      ]),
      backgroundColor: colorField("Background color"),
      backgroundGradient: textareaField("Background gradient"),
      backgroundImage: imageField("Background image"),
      backgroundPosition: textField("Background position", "center center"),
      backgroundSize: selectField("Background size", BACKGROUND_SIZE_OPTIONS),
      backgroundAttachment: selectField("Background attachment", BACKGROUND_ATTACHMENT_OPTIONS),
      darkBackgroundMode: selectField("Dark background mode", [
        { label: "Use light setting with dark overlay", value: "auto" },
        { label: "Theme default", value: "theme" },
        { label: "Color", value: "color" },
        { label: "Gradient", value: "gradient" },
        { label: "Image", value: "image" },
      ]),
      darkBackgroundColor: colorField("Dark background color"),
      darkBackgroundGradient: textareaField("Dark background gradient"),
      darkBackgroundImage: imageField("Dark background image"),
      textColor: colorField("Text color"),
      darkTextColor: colorField("Dark text color"),
      fontFamily: fontField("Page body font"),
      headingFontFamily: fontField("Page heading font"),
      maxWidth: textField("Content max width", "1180px, 96vw, none"),
      pagePaddingTop: numberField("Top padding", 0, 120),
      pagePaddingBottom: numberField("Bottom padding", 0, 120),
      sectionGap: numberField("Block gap", 0, 80),
      customCss: textareaField("Custom CSS for this page"),
    },
    defaultProps: createDefaultRootProps(),
    render: ({ children, ...props }) => {
      const getPageBackground = (dark = false) => {
        const mode = dark && props.darkBackgroundMode && props.darkBackgroundMode !== "auto" ? props.darkBackgroundMode : props.backgroundMode;
        const image = safeUrl((dark && props.darkBackgroundImage) || props.backgroundImage);
        const color = (dark && props.darkBackgroundColor) || props.backgroundColor;
        const gradient = (dark && props.darkBackgroundGradient) || props.backgroundGradient;
        const overlay = dark ? "linear-gradient(rgba(15,23,42,0.72), rgba(15,23,42,0.88))" : "linear-gradient(rgba(248,251,255,0.58), rgba(248,251,255,0.78))";

        if (mode === "image" && image) {
          return `${overlay}, url(${image}) ${props.backgroundPosition || "center center"} / ${props.backgroundSize || "cover"} no-repeat ${props.backgroundAttachment || "scroll"}`;
        }
        if (mode === "color") return color || "var(--soft-bg)";
        if (mode === "gradient") return gradient || (dark ? "var(--soft-page-dark-gradient)" : "var(--soft-bg)");
        if (dark && props.darkBackgroundMode === "auto" && props.backgroundMode === "image" && image) {
          return `${overlay}, url(${image}) ${props.backgroundPosition || "center center"} / ${props.backgroundSize || "cover"} no-repeat ${props.backgroundAttachment || "scroll"}`;
        }
        return "transparent";
      };

      const background = getPageBackground(false);
      const darkBackground = getPageBackground(true);
      const maxWidth = props.maxWidth === "none" ? "none" : props.maxWidth || "1180px";

      return (
        <Box
          className="soft-design-page"
          sx={{
            minHeight: "100%",
            "--soft-page-background": background,
            "--soft-page-dark-background": darkBackground,
            "--soft-page-text-color": props.textColor || "var(--soft-text)",
            "--soft-page-dark-text-color": props.darkTextColor || "var(--soft-text)",
            background: "var(--soft-page-background)",
            color: "var(--soft-page-text-color)",
            fontFamily: getFontFamily(props.fontFamily, "var(--soft-body-font)"),
            px: { xs: 1.25, sm: 2, md: 2.25 },
            pt: `${Math.max(0, Number(props.pagePaddingTop) || 0)}px`,
            pb: `${Math.max(0, Number(props.pagePaddingBottom) || 0)}px`,
            "--soft-design-section-gap": `${Math.max(0, Number(props.sectionGap) || 0)}px`,
            "[data-soft-theme=\"dark\"] &": {
              background: "var(--soft-page-dark-background)",
              color: "var(--soft-page-dark-text-color)",
            },
            "& .soft-section-heading, & h1, & h2, & h3, & h4, & h5, & h6": {
              fontFamily: getFontFamily(props.headingFontFamily, "var(--soft-heading-font)"),
            },
          }}
        >
          {props.customCss && <style>{String(props.customCss)}</style>}
          <Box sx={{ width: "100%", maxWidth, mx: "auto", display: "grid", gap: "var(--soft-design-section-gap)" }}>{children}</Box>
        </Box>
      );
    },
  },
  categories: {
    layout: {
      title: "Layout",
      components: ["HeroDirectory", "DirectoryGrid", "TextBlock", "RichText", "ButtonRow", "Spacer"],
      defaultExpanded: true,
    },
    media: {
      title: "Media",
      components: ["ImageBlock", "ImageBoard", "TwitchLive", "EmbedBlock", "EmbedGrid", "RecentVods"],
      defaultExpanded: true,
    },
  },
  components: {
    HeroDirectory: {
      label: "Hero / Directory Intro",
      fields: {
        eyebrow: textField("Eyebrow"),
        title: textField("Title"),
        subtitle: textField("Subtitle"),
        body: textareaField("Body"),
        mediaMode: selectField("Media", [
          { label: "Twitch live embed", value: "twitch" },
          { label: "Image", value: "image" },
          { label: "None", value: "none" },
        ]),
        imageUrl: imageField("Image"),
        imageAlt: textField("Image alt text"),
        titleFontFamily: fontField("Title font"),
        bodyFontFamily: fontField("Body font"),
        titleColor: colorField("Title color"),
        bodyColor: colorField("Body color"),
        layout: selectField("Layout", [
          { label: "Text left", value: "text-left" },
          { label: "Text right", value: "text-right" },
          { label: "Stacked", value: "stacked" },
          { label: "Centered", value: "centered" },
        ]),
        surface: selectField("Surface", SURFACE_OPTIONS),
        backgroundColor: colorField("Panel background"),
        accentColor: colorField("Accent color"),
        animation: selectField("Animation", ANIMATION_OPTIONS),
        minHeight: numberField("Minimum height", 220, 720),
        buttons: buttonArrayField,
        ...advancedFields,
      },
      defaultProps: {
        eyebrow: "softu",
        title: "New hero",
        subtitle: "A flexible intro block",
        body: SITE_DESCRIPTION,
        mediaMode: "image",
        imageUrl: "",
        imageAlt: "",
        layout: "text-left",
        surface: "glass",
        backgroundColor: "",
        accentColor: "#d46b8c",
        titleFontFamily: "inherit",
        bodyFontFamily: "inherit",
        titleColor: "",
        bodyColor: "",
        animation: "fade",
        minHeight: 340,
        buttons: [{ label: "Open VODs", href: "/vods", variant: "contained", tone: "accent", animation: "sheen" }],
        customClassName: "",
      },
      render: (props) => {
        const isCentered = props.layout === "centered";
        const isStacked = props.layout === "stacked" || isCentered;
        const mediaFirst = props.layout === "text-right";
        const media = props.mediaMode === "twitch" ? (
          <TwitchLiveFrame height={Math.max(240, Number(props.minHeight) || 340)} />
        ) : props.mediaMode === "image" ? (
          <ImageFrame src={props.imageUrl} alt={props.imageAlt} accentColor={props.accentColor} aspectRatio="16 / 10" />
        ) : null;

        const textContent = (
          <Box sx={{ minWidth: 0, textAlign: isCentered ? "center" : "left" }}>
            {props.eyebrow && (
              <Typography variant="overline" sx={{ color: props.accentColor || "secondary.main", fontWeight: 800, letterSpacing: "0.08em" }}>
                {props.eyebrow}
              </Typography>
            )}
            <Typography
              variant="h1"
              sx={{
                fontSize: { xs: "2.25rem", sm: "3.1rem", md: "4rem" },
                lineHeight: 0.95,
                color: props.titleColor || "primary.main",
                fontFamily: getFontFamily(props.titleFontFamily),
                textTransform: "lowercase",
              }}
            >
              {cleanText(props.title, "softu")}
            </Typography>
            {props.subtitle && (
              <Typography variant="h5" sx={{ mt: 0.85, color: props.bodyColor || "text.secondary", fontFamily: getFontFamily(props.bodyFontFamily), fontSize: { xs: "1rem", md: "1.2rem" }, lineHeight: 1.3 }}>
                {props.subtitle}
              </Typography>
            )}
            {props.body && (
              <Typography variant="body1" sx={{ mt: 1.25, color: props.bodyColor || "text.secondary", fontFamily: getFontFamily(props.bodyFontFamily), maxWidth: isCentered ? 760 : 560, mx: isCentered ? "auto" : 0, lineHeight: 1.55 }}>
                {props.body}
              </Typography>
            )}
            {Array.isArray(props.buttons) && props.buttons.length > 0 && (
              <Stack direction={{ xs: "column", sm: "row" }} spacing={1} justifyContent={isCentered ? "center" : "flex-start"} sx={{ mt: 1.55 }}>
                {props.buttons.map((button, index) => (
                  <DesignButton key={`${button?.label || "button"}-${index}`} button={button} accentColor={props.accentColor} />
                ))}
              </Stack>
            )}
          </Box>
        );

        return (
          <Box
            className={getAnimationClass(props.animation, props.customClassName)}
            sx={{
              ...getResizeSx(props),
              ...getSurfaceSx(props),
              ...getPaddingSx(props.padding || "large"),
              ...getBlockBackgroundSx(props),
              minHeight: Math.max(220, Number(props.minHeight) || 340),
              overflow: "hidden",
              display: "grid",
              alignItems: "center",
            }}
          >
            <Grid container spacing={{ xs: 1.6, md: 2.6 }} alignItems="center" direction={mediaFirst && !isStacked ? "row-reverse" : "row"}>
              <Grid size={{ xs: 12, lg: media && !isStacked ? 5 : 12 }}>{textContent}</Grid>
              {media && <Grid size={{ xs: 12, lg: isStacked ? 12 : 7 }}>{media}</Grid>}
            </Grid>
          </Box>
        );
      },
    },
    DirectoryGrid: {
      label: "Directory Cards",
      fields: {
        title: textField("Title"),
        subtitle: textareaField("Subtitle"),
        columns: selectField("Columns", [
          { label: "2", value: "2" },
          { label: "3", value: "3" },
          { label: "4", value: "4" },
        ]),
        cardStyle: selectField("Card style", SURFACE_OPTIONS),
        animation: selectField("Card animation", ANIMATION_OPTIONS),
        items: {
          type: "array",
          label: "Cards",
          getItemSummary: (item) => item?.title || "Card",
          defaultItemProps: {
            title: "New card",
            description: "Describe this link or image.",
            imageUrl: "",
            backgroundImage: "",
            href: "",
            buttonLabel: "Open",
            accentColor: "#d46b8c",
          },
          arrayFields: {
            title: textField("Title"),
            description: textareaField("Description"),
            imageUrl: imageField("Card image"),
            backgroundImage: imageField("Card background image"),
            href: hrefField,
            buttonLabel: textField("Button label"),
            accentColor: colorField("Accent color"),
          },
        },
        ...advancedFields,
      },
      defaultProps: {
        title: "Directory",
        subtitle: "Add links, images, pages, and projects.",
        columns: "3",
        cardStyle: "glass",
        animation: "lift",
        items: [],
        customClassName: "",
      },
      render: (props) => {
        const columnSize = props.columns === "4" ? { xs: 12, sm: 6, lg: 3 } : props.columns === "2" ? { xs: 12, md: 6 } : { xs: 12, sm: 6, lg: 4 };
        return (
          <Box className={props.customClassName} sx={{ ...getResizeSx(props), ...getBlockBackgroundSx(props) }}>
            {sectionHeading(props.title, props.subtitle)}
            <Grid container spacing={{ xs: 1.2, md: 1.6 }}>
              {(Array.isArray(props.items) ? props.items : []).map((item, index) => {
                const hrefProps = getLinkProps(item.href);
                return (
                  <Grid key={`${item.title || "card"}-${index}`} size={columnSize}>
                    <Box
                      className={getAnimationClass(props.animation, "soft-design-card")}
                      sx={{
                        ...getSurfaceSx({ surface: props.cardStyle, accentColor: item.accentColor }),
                        ...getBlockBackgroundSx({
                          backgroundImage: item.backgroundImage,
                          backgroundImageOpacity: 22,
                          backgroundPosition: "center center",
                          backgroundSize: "cover",
                          borderRadius: props.borderRadius || 24,
                        }),
                        overflow: "hidden",
                        height: "100%",
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <ImageFrame src={item.imageUrl} alt={item.title} aspectRatio="16 / 9" accentColor={item.accentColor} />
                      <Box sx={{ p: 1.35, display: "flex", flexDirection: "column", gap: 0.65, flex: 1 }}>
                        <Typography variant="h6" sx={{ color: "primary.main", lineHeight: 1.1 }}>
                          {cleanText(item.title, "Card")}
                        </Typography>
                        {item.description && (
                          <Typography variant="body2" sx={{ color: "text.secondary", lineHeight: 1.45, flex: 1 }}>
                            {item.description}
                          </Typography>
                        )}
                        {resolveConfiguredHref(item.href) && (
                          <Button {...hrefProps} variant="outlined" size="small" endIcon={<OpenInNewRoundedIcon />} sx={{ alignSelf: "flex-start", borderColor: item.accentColor, color: item.accentColor }}>
                            {cleanText(item.buttonLabel, "Open")}
                          </Button>
                        )}
                      </Box>
                    </Box>
                  </Grid>
                );
              })}
            </Grid>
          </Box>
        );
      },
    },
    TextBlock: {
      label: "Text",
      fields: {
        eyebrow: textField("Eyebrow"),
        title: textField("Title"),
        body: textareaField("Body"),
        fontFamily: fontField("Body font"),
        fontSize: numberField("Body font size", 10, 64),
        fontWeight: selectField("Body weight", FONT_WEIGHT_OPTIONS),
        lineHeight: numberField("Line height", 1, 2.4, 0.05),
        titleColor: colorField("Title color"),
        titleFontFamily: fontField("Title font"),
        titleFontSize: numberField("Title font size", 12, 96),
        backgroundColor: colorField("Panel background"),
        sideImageUrl: imageField("Side image"),
        sideImageAlt: textField("Side image alt text"),
        sideImagePosition: selectField("Side image position", [
          { label: "None", value: "none" },
          { label: "Left", value: "left" },
          { label: "Right", value: "right" },
          { label: "Top", value: "top" },
        ]),
        sideImageWidth: numberField("Side image width", 80, 520),
        align: selectField("Text align", [
          { label: "Left", value: "left" },
          { label: "Center", value: "center" },
          { label: "Right", value: "right" },
        ]),
        width: selectField("Width", WIDTH_OPTIONS),
        surface: selectField("Surface", SURFACE_OPTIONS),
        animation: selectField("Animation", ANIMATION_OPTIONS),
        ...advancedFields,
      },
      defaultProps: {
        eyebrow: "",
        title: "Text block",
        body: "Write something here.",
        align: "left",
        width: "normal",
        surface: "transparent",
        animation: "fade",
        fontFamily: "inherit",
        fontSize: 16,
        fontWeight: "400",
        lineHeight: 1.58,
        titleColor: "",
        titleFontFamily: "inherit",
        titleFontSize: 0,
        backgroundColor: "",
        sideImageUrl: "",
        sideImageAlt: "",
        sideImagePosition: "none",
        sideImageWidth: 220,
        customClassName: "",
      },
      render: (props) => {
        const imageUrl = props.sideImagePosition !== "none" ? safeUrl(props.sideImageUrl) : "";
        const imageFirst = props.sideImagePosition === "left" || props.sideImagePosition === "top";
        const stacked = props.sideImagePosition === "top";
        const image = imageUrl ? (
          <Box sx={{ width: stacked ? "100%" : Math.max(80, Number(props.sideImageWidth) || 220), flex: "0 0 auto" }}>
            <ImageFrame src={imageUrl} alt={props.sideImageAlt} aspectRatio={stacked ? "16 / 9" : "4 / 5"} />
          </Box>
        ) : null;
        const text = (
          <Box sx={{ minWidth: 0, flex: 1 }}>
            {props.eyebrow && (
              <Typography variant="overline" sx={{ color: props.titleColor || "secondary.main", fontWeight: 800 }}>
                {props.eyebrow}
              </Typography>
            )}
            {props.title && (
              <Typography
                variant="h4"
                sx={{
                  color: props.titleColor || "primary.main",
                  fontFamily: getFontFamily(props.titleFontFamily),
                  fontSize: Number(props.titleFontSize) > 0 ? `${Number(props.titleFontSize)}px` : undefined,
                  lineHeight: 1.05,
                }}
              >
                {props.title}
              </Typography>
            )}
            {props.body && (
              <Typography component="div" variant="body1" sx={{ ...getTextFormattingSx(props), whiteSpace: "pre-line", mt: props.title ? 1 : 0 }}>
                {props.body}
              </Typography>
            )}
          </Box>
        );

        return (
          <Box
            className={getAnimationClass(props.animation, props.customClassName)}
            sx={{
              ...getWidthSx(props.width, props.customMaxWidth),
              minHeight: Number(props.minHeight) > 0 ? Number(props.minHeight) : undefined,
              ...getSurfaceSx({ surface: props.surface, backgroundColor: props.backgroundColor, borderColor: props.borderColor }),
              ...(props.surface === "transparent" ? {} : getPaddingSx(props.padding || "medium")),
              ...getBlockBackgroundSx(props),
              mx: props.align === "center" ? "auto" : props.align === "right" ? "auto 0 auto auto" : 0,
              textAlign: props.align,
            }}
          >
            <Stack direction={stacked ? "column" : { xs: "column", md: "row" }} spacing={1.3} alignItems={props.align === "center" ? "center" : "stretch"}>
              {imageFirst && image}
              {text}
              {!imageFirst && image}
            </Stack>
          </Box>
        );
      },
    },
    RichText: {
      label: "Formatted Text",
      fields: {
        body: textareaField("Text"),
        align: selectField("Text align", [
          { label: "Left", value: "left" },
          { label: "Center", value: "center" },
          { label: "Right", value: "right" },
        ]),
        fontFamily: fontField("Font"),
        fontSize: numberField("Font size", 10, 96),
        fontWeight: selectField("Font weight", FONT_WEIGHT_OPTIONS),
        lineHeight: numberField("Line height", 1, 2.4, 0.05),
        italic: selectField("Italic", [
          { label: "No", value: "no" },
          { label: "Yes", value: "yes" },
        ]),
        underline: selectField("Underline", [
          { label: "No", value: "no" },
          { label: "Yes", value: "yes" },
        ]),
        surface: selectField("Surface", SURFACE_OPTIONS),
        backgroundColor: colorField("Panel background"),
        animation: selectField("Animation", ANIMATION_OPTIONS),
        ...advancedFields,
      },
      defaultProps: {
        body: "Add text here.",
        align: "center",
        fontFamily: "inherit",
        fontSize: 20,
        fontWeight: "650",
        lineHeight: 1.35,
        italic: "no",
        underline: "no",
        surface: "transparent",
        backgroundColor: "",
        animation: "fade",
        width: "normal",
        padding: "medium",
        borderRadius: 22,
        customClassName: "",
      },
      render: (props) => (
        <Box
          className={getAnimationClass(props.animation, props.customClassName)}
          sx={{
            ...getWidthSx(props.width, props.customMaxWidth),
            minHeight: Number(props.minHeight) > 0 ? Number(props.minHeight) : undefined,
            ...getSurfaceSx({ surface: props.surface, backgroundColor: props.backgroundColor, borderColor: props.borderColor }),
            ...(props.surface === "transparent" ? {} : getPaddingSx(props.padding || "medium")),
            ...getBlockBackgroundSx(props),
            mx: props.align === "center" ? "auto" : props.align === "right" ? "auto 0 auto auto" : 0,
            textAlign: props.align,
          }}
        >
          <Typography component="div" sx={{ ...getTextFormattingSx(props, "var(--soft-text)"), whiteSpace: "pre-line" }}>
            {cleanText(props.body, "Add text here.")}
          </Typography>
        </Box>
      ),
    },
    ButtonRow: {
      label: "Button Row",
      fields: {
        align: selectField("Align", [
          { label: "Left", value: "left" },
          { label: "Center", value: "center" },
          { label: "Right", value: "right" },
        ]),
        accentColor: colorField("Accent color"),
        surface: selectField("Surface", SURFACE_OPTIONS),
        backgroundColor: colorField("Panel background"),
        buttons: buttonArrayField,
        ...advancedFields,
      },
      defaultProps: {
        align: "left",
        accentColor: "#d46b8c",
        surface: "transparent",
        backgroundColor: "",
        buttons: [{ label: "Open VODs", href: "/vods", variant: "contained", tone: "accent", animation: "lift" }],
        customClassName: "",
      },
      render: (props) => (
        <Box
          className={props.customClassName}
          sx={{
            ...getResizeSx(props),
            ...getSurfaceSx({ surface: props.surface, backgroundColor: props.backgroundColor, borderColor: props.borderColor, accentColor: props.accentColor }),
            ...(props.surface === "transparent" ? {} : getPaddingSx(props.padding || "small")),
            ...getBlockBackgroundSx(props),
          }}
        >
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1}
            justifyContent={props.align === "center" ? "center" : props.align === "right" ? "flex-end" : "flex-start"}
          >
            {(Array.isArray(props.buttons) ? props.buttons : []).map((button, index) => (
              <DesignButton key={`${button?.label || "button"}-${index}`} button={button} accentColor={props.accentColor} />
            ))}
          </Stack>
        </Box>
      ),
    },
    ImageBlock: {
      label: "Image",
      fields: {
        title: textField("Title"),
        subtitle: textareaField("Caption"),
        imageUrl: imageField("Image"),
        imageAlt: textField("Image alt text"),
        aspectRatio: selectField("Aspect ratio", [
          { label: "Wide", value: "16 / 9" },
          { label: "Photo", value: "4 / 3" },
          { label: "Square", value: "1 / 1" },
          { label: "Tall", value: "4 / 5" },
        ]),
        width: selectField("Width", WIDTH_OPTIONS),
        animation: selectField("Animation", ANIMATION_OPTIONS),
        ...advancedFields,
      },
      defaultProps: {
        title: "",
        subtitle: "",
        imageUrl: "",
        imageAlt: "",
        aspectRatio: "16 / 9",
        width: "wide",
        animation: "fade",
        customClassName: "",
      },
      render: (props) => (
        <Box className={getAnimationClass(props.animation, props.customClassName)} sx={{ ...getWidthSx(props.width, props.customMaxWidth), minHeight: Number(props.minHeight) > 0 ? Number(props.minHeight) : undefined, mx: "auto", ...getBlockBackgroundSx(props) }}>
          {sectionHeading(props.title, props.subtitle)}
          <ImageFrame src={props.imageUrl} alt={props.imageAlt} aspectRatio={props.aspectRatio} />
        </Box>
      ),
    },
    ImageBoard: {
      label: "Image Board",
      fields: {
        title: textField("Title"),
        subtitle: textareaField("Subtitle"),
        columns: selectField("Columns", [
          { label: "2", value: "2" },
          { label: "3", value: "3" },
          { label: "4", value: "4" },
        ]),
        images: {
          type: "array",
          label: "Images",
          getItemSummary: (item) => item?.title || "Image",
          defaultItemProps: {
            title: "Image",
            caption: "",
            imageUrl: "",
            href: "",
          },
          arrayFields: {
            title: textField("Title"),
            caption: textareaField("Caption"),
            imageUrl: imageField("Image"),
            href: hrefField,
          },
        },
        ...advancedFields,
      },
      defaultProps: {
        title: "Images",
        subtitle: "",
        columns: "3",
        images: [],
        customClassName: "",
      },
      render: (props) => {
        const columnSize = props.columns === "4" ? { xs: 12, sm: 6, lg: 3 } : props.columns === "2" ? { xs: 12, md: 6 } : { xs: 12, sm: 6, lg: 4 };
        return (
          <Box className={props.customClassName} sx={{ ...getResizeSx(props), ...getBlockBackgroundSx(props) }}>
            {sectionHeading(props.title, props.subtitle)}
            <Grid container spacing={{ xs: 1.1, md: 1.5 }}>
              {(Array.isArray(props.images) ? props.images : []).map((item, index) => {
                const linkProps = getLinkProps(item.href);
                const content = (
                  <>
                    <ImageFrame src={item.imageUrl} alt={item.title} aspectRatio="4 / 3" className="soft-design-image-board-media" />
                    {(item.title || item.caption) && (
                      <Box sx={{ mt: 0.7 }}>
                        {item.title && <Typography variant="subtitle1" sx={{ color: "primary.main", fontWeight: 800 }}>{item.title}</Typography>}
                        {item.caption && <Typography variant="body2" sx={{ color: "text.secondary" }}>{item.caption}</Typography>}
                      </Box>
                    )}
                  </>
                );
                return (
                  <Grid key={`${item.title || "image"}-${index}`} size={columnSize}>
                    {resolveConfiguredHref(item.href) ? (
                      <Box component={linkProps.component || "a"} {...linkProps} className="soft-design-block soft-design-anim--lift" sx={{ display: "block", color: "inherit" }}>
                        {content}
                      </Box>
                    ) : (
                      <Box className="soft-design-block soft-design-anim--lift">{content}</Box>
                    )}
                  </Grid>
                );
              })}
            </Grid>
          </Box>
        );
      },
    },
    TwitchLive: {
      label: "Twitch Live Embed",
      fields: {
        title: textField("Title"),
        subtitle: textareaField("Subtitle"),
        channelSource: selectField("Channel", [
          { label: "Configured Twitch link", value: "configured" },
          { label: "Custom channel", value: "custom" },
        ]),
        customChannel: textField("Custom Twitch channel"),
        height: numberField("Height", 220, 760),
        surface: selectField("Surface", SURFACE_OPTIONS),
        backgroundColor: colorField("Panel background"),
        ...advancedFields,
      },
      defaultProps: {
        title: "Live",
        subtitle: "",
        channelSource: "configured",
        customChannel: "",
        height: 380,
        surface: "transparent",
        backgroundColor: "",
        customClassName: "",
      },
      render: (props) => (
        <Box
          className={props.customClassName}
          sx={{
            ...getResizeSx(props),
            ...getSurfaceSx({ surface: props.surface, backgroundColor: props.backgroundColor, borderColor: props.borderColor }),
            ...(props.surface === "transparent" ? {} : getPaddingSx(props.padding || "medium")),
            ...getBlockBackgroundSx(props),
          }}
        >
          {sectionHeading(props.title, props.subtitle)}
          <TwitchLiveFrame channelSource={props.channelSource} customChannel={props.customChannel} height={props.height} />
        </Box>
      ),
    },
    EmbedBlock: {
      label: "Embed",
      fields: {
        title: textField("Title"),
        subtitle: textareaField("Caption"),
        src: textField("Embed URL"),
        height: numberField("Height", 120, 900),
        aspectRatio: selectField("Aspect ratio", [
          { label: "Custom height", value: "custom" },
          { label: "16:9", value: "16 / 9" },
          { label: "4:3", value: "4 / 3" },
          { label: "Square", value: "1 / 1" },
        ]),
        allow: textareaField("Iframe allow attributes"),
        sandbox: textareaField("Iframe sandbox attributes"),
        surface: selectField("Surface", SURFACE_OPTIONS),
        backgroundColor: colorField("Panel background"),
        ...advancedFields,
      },
      defaultProps: {
        title: "Embed",
        subtitle: "",
        src: "",
        height: 352,
        aspectRatio: "custom",
        allow: "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture",
        sandbox: "",
        surface: "glass",
        backgroundColor: "",
        customClassName: "",
      },
      render: (props) => (
        <Box
          className={props.customClassName}
          sx={{
            ...getResizeSx(props),
            ...getSurfaceSx({ surface: props.surface, backgroundColor: props.backgroundColor, borderColor: props.borderColor }),
            ...(props.surface === "transparent" ? {} : getPaddingSx(props.padding || "medium")),
            ...getBlockBackgroundSx(props),
          }}
        >
          {sectionHeading(props.title, props.subtitle)}
          <GenericEmbedFrame {...props} />
        </Box>
      ),
    },
    EmbedGrid: {
      label: "Embed Grid",
      fields: {
        title: textField("Title"),
        subtitle: textareaField("Subtitle"),
        columns: selectField("Columns", [
          { label: "1", value: "1" },
          { label: "2", value: "2" },
          { label: "3", value: "3" },
        ]),
        surface: selectField("Surface", SURFACE_OPTIONS),
        backgroundColor: colorField("Panel background"),
        embeds: {
          type: "array",
          label: "Embeds",
          getItemSummary: (item) => item?.title || "Embed",
          defaultItemProps: {
            title: "Embed",
            src: "",
            height: 352,
            aspectRatio: "custom",
            allow: "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture",
            sandbox: "",
          },
          arrayFields: {
            title: textField("Title"),
            src: textField("Embed URL"),
            height: numberField("Height", 120, 900),
            aspectRatio: selectField("Aspect ratio", [
              { label: "Custom height", value: "custom" },
              { label: "16:9", value: "16 / 9" },
              { label: "4:3", value: "4 / 3" },
              { label: "Square", value: "1 / 1" },
            ]),
            allow: textareaField("Iframe allow attributes"),
            sandbox: textareaField("Iframe sandbox attributes"),
          },
        },
        ...advancedFields,
      },
      defaultProps: {
        title: "Embeds",
        subtitle: "",
        columns: "2",
        surface: "glass",
        backgroundColor: "",
        embeds: [],
        customClassName: "",
      },
      render: (props) => {
        const columnSize = props.columns === "3" ? { xs: 12, lg: 4 } : props.columns === "1" ? { xs: 12 } : { xs: 12, md: 6 };
        return (
          <Box
            className={props.customClassName}
          sx={{
            ...getResizeSx(props),
            ...getSurfaceSx({ surface: props.surface, backgroundColor: props.backgroundColor, borderColor: props.borderColor }),
            ...(props.surface === "transparent" ? {} : getPaddingSx(props.padding || "medium")),
            ...getBlockBackgroundSx(props),
          }}
          >
            {sectionHeading(props.title, props.subtitle)}
            <Grid container spacing={{ xs: 1.1, md: 1.4 }}>
              {(Array.isArray(props.embeds) ? props.embeds : []).map((embed, index) => (
                <Grid key={`${embed.title || "embed"}-${index}`} size={columnSize}>
                  {embed.title && (
                    <Typography variant="caption" sx={{ display: "block", color: "text.secondary", mb: 0.65, px: 0.35, letterSpacing: "0.05em", fontWeight: 800 }}>
                      {embed.title}
                    </Typography>
                  )}
                  <GenericEmbedFrame {...embed} />
                </Grid>
              ))}
            </Grid>
          </Box>
        );
      },
    },
    RecentVods: {
      label: "Recent VODs",
      fields: {
        title: textField("Title"),
        subtitle: textareaField("Subtitle"),
        count: numberField("Count", 1, 12),
        showButton: selectField("Show VODs button", [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ]),
        surface: selectField("Surface", SURFACE_OPTIONS),
        backgroundColor: colorField("Panel background"),
        ...advancedFields,
      },
      defaultProps: {
        title: "Recent VODs",
        subtitle: "Latest uploads only.",
        count: 4,
        showButton: true,
        surface: "glass",
        backgroundColor: "",
        width: "full",
        customMaxWidth: "",
        minHeight: 0,
        padding: "medium",
        customClassName: "",
      },
      render: (props) => <RecentVodsRenderer {...props} />,
    },
    Spacer: {
      label: "Spacer",
      fields: {
        height: numberField("Height", 4, 180),
      },
      defaultProps: {
        height: 24,
      },
      render: ({ height }) => <Box aria-hidden sx={{ height: Math.max(4, Number(height) || 24) }} />,
    },
  },
};

function createDefaultRootProps() {
  return {
    pageTitle: "Softu",
    pageDescription: "",
    backgroundMode: "theme",
    backgroundColor: "#e2e9f3",
    backgroundGradient: "",
    backgroundImage: "",
    backgroundPosition: "center center",
    backgroundSize: "cover",
    backgroundAttachment: "scroll",
    darkBackgroundMode: "auto",
    darkBackgroundColor: "#0f172a",
    darkBackgroundGradient:
      "radial-gradient(circle at 14% 12%, rgba(212,107,140,0.14), transparent 36%), radial-gradient(circle at 86% 14%, rgba(121,163,230,0.14), transparent 44%), #0f172a",
    darkBackgroundImage: "",
    textColor: "",
    darkTextColor: "",
    fontFamily: "inherit",
    headingFontFamily: "inherit",
    maxWidth: "1180px",
    pagePaddingTop: 12,
    pagePaddingBottom: 24,
    sectionGap: 18,
    customCss: "",
  };
}
