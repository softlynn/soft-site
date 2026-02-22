import { useEffect, useMemo, useRef, useState } from "react";
import { Box, CircularProgress, Tooltip, Typography } from "@mui/material";
import ThumbUpAltOutlinedIcon from "@mui/icons-material/ThumbUpAltOutlined";
import ThumbUpAltRoundedIcon from "@mui/icons-material/ThumbUpAltRounded";
import ThumbDownAltOutlinedIcon from "@mui/icons-material/ThumbDownAltOutlined";
import ThumbDownAltRoundedIcon from "@mui/icons-material/ThumbDownAltRounded";
import FavoriteBorderRoundedIcon from "@mui/icons-material/FavoriteBorderRounded";
import { getStoredVodReactionVote, getVodLikeCount, getVodReactionSnapshot, setVodReactionVote, subscribeVodReactionSnapshot } from "./vodReactionsApi";

const optimisticCounts = (snapshot, previousVote, nextVote) => {
  const current = {
    likes: Math.max(0, Number(snapshot?.likes) || 0),
    dislikes: Math.max(0, Number(snapshot?.dislikes) || 0),
  };

  if (previousVote === "like" && nextVote !== "like") current.likes = Math.max(0, current.likes - 1);
  if (previousVote === "dislike" && nextVote !== "dislike") current.dislikes = Math.max(0, current.dislikes - 1);
  if (nextVote === "like" && previousVote !== "like") current.likes += 1;
  if (nextVote === "dislike" && previousVote !== "dislike") current.dislikes += 1;

  return current;
};

export default function VodReactions({
  vodId,
  compact = false,
  sx,
  lazy = compact,
  readOnly = false,
  showDislike = true,
  countOnlyLike = false,
}) {
  const rootRef = useRef(null);
  const [enabled, setEnabled] = useState(!lazy);
  const [vote, setVote] = useState(() => getStoredVodReactionVote(vodId));
  const [counts, setCounts] = useState(null);
  const [loading, setLoading] = useState(!lazy);
  const [pendingVote, setPendingVote] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setVote(getStoredVodReactionVote(vodId));
  }, [vodId]);

  useEffect(() => {
    if (!lazy) {
      setEnabled(true);
      return undefined;
    }
    if (enabled) return undefined;
    if (typeof window === "undefined" || typeof window.IntersectionObserver === "undefined") {
      setEnabled(true);
      return undefined;
    }
    const node = rootRef.current;
    if (!node) return undefined;

    const observer = new window.IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setEnabled(true);
          observer.disconnect();
        }
      },
      { root: null, threshold: 0, rootMargin: "180px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, lazy]);

  useEffect(() => {
    if (!vodId) return undefined;
    if (countOnlyLike) return undefined;
    const unsubscribe = subscribeVodReactionSnapshot(vodId, (snapshot) => {
      setCounts(snapshot);
    });
    return unsubscribe;
  }, [vodId, countOnlyLike]);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !vodId) return undefined;

    setLoading(true);
    setError("");
    const loader = countOnlyLike ? getVodLikeCount(vodId).then((likes) => ({ likes, dislikes: 0 })) : getVodReactionSnapshot(vodId);

    loader
      .then((snapshot) => {
        if (cancelled) return;
        setCounts(snapshot);
      })
      .catch((loadError) => {
        if (cancelled) return;
        console.error("Failed to load VOD reactions:", loadError);
        const message = String(loadError?.message || "").toLowerCase();
        setError(message.includes("fetch") || message.includes("network") || message.includes("abort") ? "counter blocked" : "reactions unavailable");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [countOnlyLike, enabled, vodId]);

  const likeCount = counts?.likes ?? 0;
  const dislikeCount = counts?.dislikes ?? 0;
  const isPending = pendingVote !== null;
  const compactGap = compact ? 0.45 : 0.7;
  const isInteractive = !readOnly && !countOnlyLike;

  const reactionButtonSx = useMemo(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      gap: compact ? 0.35 : 0.42,
      px: compact ? 0.55 : 0.8,
      py: compact ? 0.28 : 0.45,
      minHeight: compact ? 24 : 31,
      borderRadius: compact ? "10px" : "12px",
      border: "1px solid var(--soft-border)",
      background: "var(--soft-surface-strong)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.20)",
      color: "text.secondary",
      transition: "transform 140ms ease, background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease",
      cursor: isInteractive ? (isPending ? "wait" : "pointer") : "default",
      "&:hover": {
        transform: isInteractive && !isPending ? "translateY(-1px)" : "none",
      },
      "&:disabled": {
        opacity: 0.76,
        cursor: "wait",
      },
    }),
    [compact, isInteractive, isPending]
  );

  const submitVote = async (direction, event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!vodId || isPending || !isInteractive) return;

    const previousVote = vote === "like" || vote === "dislike" ? vote : null;
    const nextVote = previousVote === direction ? null : direction;
    const previousCounts = counts;

    setPendingVote(direction);
    setVote(nextVote);
    if (counts) setCounts(optimisticCounts(counts, previousVote, nextVote));
    setError("");

    try {
      const snapshot = await setVodReactionVote(vodId, nextVote, previousVote);
      setCounts(snapshot);
    } catch (submitError) {
      console.error("Failed to submit VOD reaction:", submitError);
      setVote(previousVote);
      if (previousCounts) setCounts(previousCounts);
      const message = String(submitError?.message || "").toLowerCase();
      setError(message.includes("fetch") || message.includes("network") || message.includes("abort") ? "counter blocked" : "save failed");
    } finally {
      setPendingVote(null);
    }
  };

  const renderButton = (direction) => {
    const active = vote === direction;
    const isLike = direction === "like";
    const count = isLike ? likeCount : dislikeCount;
    const Icon = isLike
      ? active
        ? ThumbUpAltRoundedIcon
        : ThumbUpAltOutlinedIcon
      : active
      ? ThumbDownAltRoundedIcon
      : ThumbDownAltOutlinedIcon;
    const accentColor = isLike ? "#7f2946" : "#35506f";

    return (
      <Tooltip key={direction} title={compact ? (isLike ? "Like" : "Dislike") : `Global ${isLike ? "likes" : "dislikes"}`}>
        <Box
          component="button"
          type="button"
          onClick={(event) => submitVote(direction, event)}
          disabled={isPending || !isInteractive}
          aria-pressed={active}
          aria-label={`${isLike ? "Like" : "Dislike"} this VOD`}
          sx={{
            ...reactionButtonSx,
            borderColor: active ? (isLike ? "rgba(212,107,140,0.26)" : "rgba(89,145,226,0.24)") : undefined,
            background: active ? (isLike ? "rgba(212,107,140,0.12)" : "rgba(89,145,226,0.12)") : undefined,
            boxShadow: active
              ? isLike
                ? "inset 0 1px 0 rgba(255,255,255,0.28), 0 4px 10px rgba(212,107,140,0.08)"
                : "inset 0 1px 0 rgba(255,255,255,0.28), 0 4px 10px rgba(89,145,226,0.08)"
              : reactionButtonSx.boxShadow,
          }}
        >
          <Icon sx={{ fontSize: compact ? 13 : 15, color: active ? accentColor : "currentColor" }} />
          <Typography
            variant="caption"
            sx={{
              fontWeight: 800,
              lineHeight: 1,
              minWidth: compact ? 9 : 11,
              color: active ? "text.primary" : "text.secondary",
              fontSize: compact ? "0.66rem" : "0.72rem",
            }}
          >
            {loading && !counts ? "…" : count}
          </Typography>
          {!compact && (
            <Typography
              variant="caption"
              sx={{
                fontWeight: 700,
                lineHeight: 1,
                color: active ? "text.primary" : "text.secondary",
                fontSize: "0.68rem",
                opacity: 0.9,
              }}
            >
              {isLike ? "Like" : "Dislike"}
            </Typography>
          )}
        </Box>
      </Tooltip>
    );
  };

  if (countOnlyLike) {
    const cardText = error ? "!" : loading && !counts ? "…" : likeCount;
    return (
      <Tooltip title={error ? `Global likes unavailable (${error})` : "Global likes"}>
        <Box
          ref={rootRef}
          sx={{
            display: "inline-flex",
            alignItems: "center",
            gap: 0.35,
            minHeight: 22,
            px: 0.6,
            py: 0.25,
            borderRadius: "10px",
            border: "1px solid var(--soft-border)",
            background: "var(--soft-surface-strong)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.20)",
            color: "text.secondary",
            flexShrink: 0,
            ...sx,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <FavoriteBorderRoundedIcon sx={{ fontSize: 13, color: error ? "warning.main" : "#D46B8C" }} />
          <Typography
            variant="caption"
            sx={{ fontWeight: 800, lineHeight: 1, fontSize: "0.66rem", color: error ? "warning.main" : "text.primary" }}
          >
            {cardText}
          </Typography>
        </Box>
      </Tooltip>
    );
  }

  return (
    <Box
      ref={rootRef}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: compactGap,
        flexWrap: "wrap",
        minHeight: compact ? 26 : 34,
        ...sx,
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {renderButton("like")}
      {showDislike && renderButton("dislike")}

      {compact && (isPending || error) && (
        <Tooltip title={error || "Saving reaction..."}>
          <Box
            sx={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 20,
              height: 20,
              px: 0.35,
              borderRadius: "999px",
              border: "1px solid var(--soft-border)",
              background: "var(--soft-surface-strong)",
              color: error ? "warning.main" : "text.secondary",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.20)",
            }}
          >
            {isPending ? <CircularProgress size={10} thickness={5} color="secondary" /> : <Typography variant="caption" sx={{ fontWeight: 900, lineHeight: 1 }}>!</Typography>}
          </Box>
        </Tooltip>
      )}

      {!compact && (
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.55, minHeight: 24 }}>
          {isPending && <CircularProgress size={13} thickness={5} color="secondary" />}
          {error && (
            <Typography variant="caption" sx={{ color: "warning.main", fontWeight: 700 }}>
              {error}
            </Typography>
          )}
          {!error && !isPending && (
            <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 700 }}>
              Global reactions
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
