import { Box } from "@mui/material";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const makeLinkProps = (href) => {
  const url = String(href || "").trim();
  if (!url || url.startsWith("/")) return {};
  return { target: "_blank", rel: "noopener noreferrer" };
};

export default function MarkdownText({ children, inline = false, sx = {}, ...props }) {
  const content = String(children || "").trim();
  if (!content) return null;

  return (
    <Box component={inline ? "span" : "div"} sx={sx} {...props}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node, ...linkProps }) => (
            <Box
              component="a"
              {...linkProps}
              {...makeLinkProps(linkProps.href)}
              sx={{
                color: "inherit",
                textDecoration: "underline",
                textUnderlineOffset: "0.16em",
                wordBreak: "break-word",
              }}
            />
          ),
          p: ({ node, ...paragraphProps }) => (
            <Box
              component={inline ? "span" : "p"}
              {...paragraphProps}
              sx={{
                m: 0,
                display: inline ? "inline" : "block",
                "&:not(:last-child)": inline ? {} : { mb: 1 },
              }}
            />
          ),
          ul: ({ node, ...listProps }) => (
            <Box component="ul" {...listProps} sx={{ my: 0.5, pl: 2.5, "&:first-child": { mt: 0 }, "&:last-child": { mb: 0 } }} />
          ),
          ol: ({ node, ...listProps }) => (
            <Box component="ol" {...listProps} sx={{ my: 0.5, pl: 2.5, "&:first-child": { mt: 0 }, "&:last-child": { mb: 0 } }} />
          ),
          li: ({ node, ...itemProps }) => (
            <Box component="li" {...itemProps} sx={{ my: 0.2 }} />
          ),
          blockquote: ({ node, ...quoteProps }) => (
            <Box component="blockquote" {...quoteProps} sx={{ m: "0.5em 0", pl: 1.5, borderLeft: "2px solid currentColor", opacity: 0.92 }} />
          ),
          code: ({ inline: isInline, node, ...codeProps }) => (
            <Box
              component={isInline ? "code" : "pre"}
              {...codeProps}
              sx={{
                fontFamily: "\"Cascadia Code\", \"Consolas\", monospace",
                fontSize: "0.94em",
                background: isInline ? "rgba(17,24,39,0.08)" : "rgba(17,24,39,0.06)",
                borderRadius: 1,
                px: isInline ? 0.45 : 1,
                py: isInline ? 0.12 : 0.75,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </Box>
  );
}
