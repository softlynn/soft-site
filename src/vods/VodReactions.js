import { useEffect, useMemo, useRef, useState } from "react";
import { Box, CircularProgress, Tooltip, Typography } from "@mui/material";
import ThumbUpAltOutlinedIcon from "@mui/icons-material/ThumbUpAltOutlined";
import ThumbUpAltRoundedIcon from "@mui/icons-material/ThumbUpAltRounded";
import ThumbDownAltOutlinedIcon from "@mui/icons-material/ThumbDownAltOutlined";
import ThumbDownAltRoundedIcon from "@mui/icons-material/ThumbDownAltRounded";
import { getStoredVodReactionVote, getVodReactionSnapshot, setVodReactionVote, subscribeVodReactionSnapshot } from "./vodReactionsApi";

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

export default function VodReactions({ vodId, compact = false, sx, lazy = compact }) {
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
      { root: null, threshold: 0, rootMargin: "160px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, lazy]);

  useEffect(() => {
    if (!vodId) return undefined;
    const unsubscribe = subscribeVodReactionSnapshot(vodId, (snapshot) => {
      setCounts(snapshot);
    });
    return unsubscribe;
  }, [vodId]);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || !vodId) return undefined;

    setLoading(true);
    setError("");
    getVodReactionSnapshot(vodId)
      .then((snapshot) => {
        if (cancelled) return;
        setCounts(snapshot);
      })
      .catch((loadError) => {
        if (cancelled) return;
        console.error("Failed to load VOD reactions:", loadError);
        setError("reactions unavailable");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, vodId]);

  const likeCount = counts?.likes ?? 0;
  const dislikeCount = counts?.dislikes ?? 0;
  const isPending = pendingVote !== null;
  const compactGap = compact ? 0.5 : 0.75;

  const reactionButtonSx = useMemo(
    () => ({
      display: "inline-flex",
      alignItems: "center",
      gap: compact ? 0.35 : 0.45,
      px: compact ? 0.65 : 0.9,
      py: compact ? 0.35 : 0.5,
      minHeight: compact ? 26 : 32,
      borderRadius: compact ? "10px" : "12px",
      border: "1px solid var(--soft-border)",
      background: "var(--soft-surface-strong)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.22)",
      color: "text.secondary",
      transition: "transform 140ms ease, background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease",
      cursor: isPending ? "wait" : "pointer",
      "&:hover": {
        transform: isPending ? "none" : "translateY(-1px)",
      },
      "&:disabled": {
        opacity: 0.72,
        cursor: "wait",
      },
    }),
    [compact, isPending]
  );

  const submitVote = async (direction, event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!vodId || isPending) return;

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
      setError("save failed");
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
          disabled={isPending}
          aria-pressed={active}
          aria-label={`${isLike ? "Like" : "Dislike"} this VOD`}
          sx={{
            ...reactionButtonSx,
            borderColor: active ? (isLike ? "rgba(212,107,140,0.26)" : "rgba(89,145,226,0.24)") : undefined,
            background: active
              ? isLike
                ? "rgba(212,107,140,0.12)"
                : "rgba(89,145,226,0.12)"
              : undefined,
            boxShadow: active
              ? isLike
                ? "inset 0 1px 0 rgba(255,255,255,0.32), 0 4px 10px rgba(212,107,140,0.10)"
                : "inset 0 1px 0 rgba(255,255,255,0.32), 0 4px 10px rgba(89,145,226,0.10)"
              : reactionButtonSx.boxShadow,
          }}
        >
          <Icon sx={{ fontSize: compact ? 14 : 16, color: active ? accentColor : "currentColor" }} />
          <Typography
            variant="caption"
            sx={{
              fontWeight: 800,
              lineHeight: 1,
              minWidth: compact ? 10 : 12,
              color: active ? "text.primary" : "text.secondary",
              fontSize: compact ? "0.68rem" : "0.72rem",
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
                fontSize: "0.7rem",
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

  return (
    <Box
      ref={rootRef}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: compactGap,
        flexWrap: "wrap",
        minHeight: compact ? 28 : 34,
        ...sx,
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {renderButton("like")}
      {renderButton("dislike")}

      {!compact && (
        <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.6, minHeight: 24 }}>
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

