import { Box } from "@mui/material";
import { useEffect, useRef, useState } from "react";

export default function Reveal(props) {
  const { children, delay = 0, threshold = 0.2, once = true, className = "", sx, ...rest } = props;
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setVisible(false);
        }
      },
      { threshold }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [once, threshold]);

  return (
    <Box
      ref={ref}
      className={`soft-reveal ${visible ? "is-visible" : ""} ${className}`.trim()}
      sx={{
        "--soft-reveal-delay": `${delay}ms`,
        ...sx,
      }}
      {...rest}
    >
      {children}
    </Box>
  );
}
