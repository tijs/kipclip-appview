import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

interface SwipeableRowProps {
  children: ReactNode;
  onDelete: () => Promise<void>;
  disabled?: boolean;
}

const BUTTON_WIDTH = 80;
const FULL_SWIPE_RATIO = 0.5;
const TAP_THRESHOLD = 10;

type SwipeState = "idle" | "swiping" | "open" | "deleting" | "removing";

export function SwipeableRow(
  { children, onDelete, disabled }: SwipeableRowProps,
) {
  const [state, setState] = useState<SwipeState>("idle");
  const [offsetX, setOffsetX] = useState(0);
  const [removing, setRemoving] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const currentX = useRef(0);
  const directionLocked = useRef<"horizontal" | "vertical" | null>(null);
  const isSwiping = useRef(false);

  const animateClose = useCallback(() => {
    setOffsetX(0);
    setState("idle");
  }, []);

  const handleDelete = useCallback(async () => {
    if (state === "deleting" || state === "removing") return;
    setState("deleting");
    try {
      await onDelete();
      setState("removing");
      setRemoving(true);
    } catch {
      // Delete failed, snap back
      animateClose();
    }
  }, [onDelete, state, animateClose]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || state === "deleting" || state === "removing") return;
      const touch = e.touches[0];
      startX.current = touch.clientX;
      startY.current = touch.clientY;
      currentX.current = touch.clientX;
      directionLocked.current = null;
      isSwiping.current = false;
    },
    [disabled, state],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || state === "deleting" || state === "removing") return;

      const touch = e.touches[0];
      const dx = touch.clientX - startX.current;
      const dy = touch.clientY - startY.current;
      currentX.current = touch.clientX;

      // Lock direction on first significant movement
      if (!directionLocked.current) {
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx < TAP_THRESHOLD && absDy < TAP_THRESHOLD) return;
        directionLocked.current = absDx > absDy ? "horizontal" : "vertical";
      }

      if (directionLocked.current === "vertical") return;

      // Horizontal swipe detected
      isSwiping.current = true;
      setState("swiping");

      // Calculate offset based on whether we started from open or idle
      const baseOffset = state === "open" ? -BUTTON_WIDTH : 0;
      let newOffset = baseOffset + dx;

      // Don't allow swiping to the right past origin
      if (newOffset > 0) newOffset = 0;

      // Add resistance past the button width
      const containerWidth = containerRef.current?.offsetWidth ?? 300;
      const maxSwipe = containerWidth * FULL_SWIPE_RATIO;
      if (newOffset < -maxSwipe) {
        const overflow = -newOffset - maxSwipe;
        newOffset = -(maxSwipe + overflow * 0.3);
      }

      setOffsetX(newOffset);
    },
    [disabled, state],
  );

  const onTouchEnd = useCallback(() => {
    if (disabled || state === "deleting" || state === "removing") return;

    // If direction was vertical or no significant move, don't interfere
    if (directionLocked.current === "vertical" || !isSwiping.current) {
      // If open and user tapped, close it
      if (state === "open") {
        animateClose();
      }
      return;
    }

    const containerWidth = containerRef.current?.offsetWidth ?? 300;
    const fullSwipeThreshold = containerWidth * FULL_SWIPE_RATIO;

    if (-offsetX >= fullSwipeThreshold) {
      // Full swipe — trigger delete
      setOffsetX(-containerWidth);
      handleDelete();
    } else if (-offsetX >= BUTTON_WIDTH / 2) {
      // Partial swipe — snap open to reveal button
      setOffsetX(-BUTTON_WIDTH);
      setState("open");
    } else {
      // Not enough — snap back
      animateClose();
    }
  }, [disabled, state, offsetX, handleDelete, animateClose]);

  // Close if user taps outside the delete button area when open
  const onContentClick = useCallback(
    (e: React.MouseEvent) => {
      if (state === "open") {
        e.stopPropagation();
        e.preventDefault();
        animateClose();
      }
    },
    [state, animateClose],
  );

  const isAnimating = state !== "swiping";

  return (
    <div
      ref={containerRef}
      className={`swipe-row${removing ? " swipe-row-removing" : ""}`}
      style={{
        position: "relative",
        overflow: "hidden",
        maxHeight: removing ? 0 : 200,
      }}
      onTransitionEnd={removing
        ? (e) => {
          // Only fire once when the outer collapse finishes
          if (e.target === containerRef.current) {
            // Row is gone from DOM — parent will remove via React state
          }
        }
        : undefined}
    >
      {/* Red background with delete button */}
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "stretch",
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleDelete();
          }}
          disabled={state === "deleting" || state === "removing"}
          style={{
            width: `${BUTTON_WIDTH}px`,
            backgroundColor: "#ef4444",
            color: "white",
            border: "none",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "14px",
            fontWeight: 600,
          }}
        >
          {state === "deleting" ? "..." : "Delete"}
        </button>
      </div>

      {/* Sliding content */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          transform: `translateX(${offsetX}px)`,
          transition: isAnimating ? "transform 0.25s ease-out" : "none",
          backgroundColor: "inherit",
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={onContentClick}
      >
        {children}
      </div>
    </div>
  );
}
